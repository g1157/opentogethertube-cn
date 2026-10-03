<template>
	<canvas ref="canvasElem" class="danmaku-canvas" aria-hidden="true"></canvas>
</template>

<script lang="ts" setup>
import { onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useResizeObserver } from "@vueuse/core";
import { useStore } from "@/store";
import { DanmakuEngine, type DanmakuRenderItem } from "@/util/danmaku/engine";
import { findDanmakuProvider } from "@/util/danmaku/provider";
import type { DanmakuItem } from "@/util/danmaku/parse";
import { useDanmaku } from "../composables";

const props = defineProps<{
	video?: HTMLVideoElement;
	videoUrl: string;
}>();

const store = useStore();
const { available } = useDanmaku();
const canvasElem = ref<HTMLCanvasElement | null>(null);

// girigiri's measured proportions, kept so the picture reads the same: ~19.2px text on a
// 577px-high picture, lanes at 1.1x the font size, an 8s traverse, a thin black outline.
const FONT_RATIO = 0.0333;
const FONT_SIZE_SCALES = { small: 0.8, medium: 1, large: 1.25 } as const;
const MIN_FONT_PX = 12;
const MAX_FONT_PX = 44;
const SCROLL_DURATION_SECONDS = 8;
const MAX_ON_SCREEN = 100;
const MAX_DPR = 3;
const FONT_FAMILY = "system-ui, sans-serif";
const FONT_WEIGHT = 500;
const OUTLINE_WIDTH = 1.2;

let engine: DanmakuEngine | null = null;
let items: DanmakuItem[] | null = null;
let loadGeneration = 0;
let frameRequest = 0;
let frameViaAnimation = false;
/** The element the pending frame callback was registered on; props.video may be newer. */
let frameElement: HTMLVideoElement | null = null;
let running = false;
let frameWidth = 0;
let frameHeight = 0;
let dpr = 1;
let measureContext: CanvasRenderingContext2D | null | undefined;

function fontSizePx(): number {
	const scale = FONT_SIZE_SCALES[store.state.settings.danmakuFontSize] ?? 1;
	const base = frameHeight * FONT_RATIO * scale;
	return Math.round(Math.min(MAX_FONT_PX, Math.max(MIN_FONT_PX, base)));
}

/** Lane placement needs text widths before anything is drawn, so a scratch context measures. */
function measureText(text: string, fontPx: number): number {
	if (measureContext === undefined) {
		measureContext = document.createElement("canvas").getContext("2d");
	}
	if (!measureContext) {
		return text.length * fontPx * 0.8;
	}
	measureContext.font = `${FONT_WEIGHT} ${fontPx}px ${FONT_FAMILY}`;
	return measureContext.measureText(text).width;
}

function engineConfig() {
	const settings = store.state.settings;
	return {
		width: frameWidth,
		height: frameHeight,
		fontPx: fontSizePx(),
		scrollDuration: SCROLL_DURATION_SECONDS,
		speed: settings.danmakuSpeed,
		antiCollision: settings.danmakuAntiCollision,
		maxOnScreen: MAX_ON_SCREEN,
		blockScroll: settings.danmakuBlockScroll,
		blockTop: settings.danmakuBlockTop,
		blockBottom: settings.danmakuBlockBottom,
		blockColored: settings.danmakuBlockColored,
	};
}

function applyConfig() {
	if (!engine) {
		engine = new DanmakuEngine(engineConfig(), measureText);
		if (items) {
			engine.setItems(items);
		}
		return;
	}
	engine.configure(engineConfig());
}

/**
 * Sizes the canvas to the picture inside the player box. Letterbox bars are excluded, so
 * comments do not run over them; under "cover" the picture fills the box and is cropped
 * instead, and the frame is the whole box.
 */
function sizeCanvas(video: HTMLVideoElement) {
	const canvas = canvasElem.value;
	const box = video.getBoundingClientRect();
	if (!canvas || box.width <= 0 || box.height <= 0) {
		return;
	}
	let width = box.width;
	let height = box.height;
	let left = 0;
	let top = 0;
	if (
		store.state.settings.videoFillMode !== "cover" &&
		video.videoWidth > 0 &&
		video.videoHeight > 0
	) {
		const scale = Math.min(box.width / video.videoWidth, box.height / video.videoHeight);
		width = video.videoWidth * scale;
		height = video.videoHeight * scale;
		left = (box.width - width) / 2;
		top = (box.height - height) / 2;
	}
	dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
	canvas.style.left = `${left}px`;
	canvas.style.top = `${top}px`;
	canvas.style.width = `${width}px`;
	canvas.style.height = `${height}px`;
	canvas.width = Math.max(1, Math.round(width * dpr));
	canvas.height = Math.max(1, Math.round(height * dpr));
	frameWidth = width;
	frameHeight = height;
}

function draw(rendered: DanmakuRenderItem[]) {
	const canvas = canvasElem.value;
	const context = canvas?.getContext("2d");
	if (!canvas || !context) {
		return;
	}
	context.setTransform(dpr, 0, 0, dpr, 0, 0);
	context.clearRect(0, 0, frameWidth, frameHeight);
	if (rendered.length === 0) {
		return;
	}
	context.font = `${FONT_WEIGHT} ${fontSizePx()}px ${FONT_FAMILY}`;
	context.textBaseline = "top";
	context.globalAlpha = store.state.settings.danmakuOpacity;
	context.lineJoin = "round";
	context.strokeStyle = "#000";
	context.lineWidth = OUTLINE_WIDTH;
	for (const item of rendered) {
		context.strokeText(item.text, item.x, item.y);
		context.fillStyle = item.color;
		context.fillText(item.text, item.x, item.y);
	}
	context.globalAlpha = 1;
}

function redrawCurrent() {
	const video = props.video;
	if (video && engine) {
		draw(engine.tick(video.currentTime));
	}
}

/**
 * The schedule advances with the media clock itself, which already folds in the room
 * speed, rate bends and local seeking — there is no separate wall clock to drift.
 */
function onFrame() {
	frameRequest = 0;
	frameElement = null;
	const video = props.video;
	if (!video || !engine) {
		return;
	}
	draw(engine.tick(video.currentTime));
	schedule();
}

function schedule() {
	if (frameRequest !== 0 || !running) {
		return;
	}
	const video = props.video;
	if (!video || document.hidden) {
		return;
	}
	if (typeof video.requestVideoFrameCallback === "function") {
		frameViaAnimation = false;
		frameRequest = video.requestVideoFrameCallback(onFrame);
	} else {
		// Older browsers without the frame API: rAF is close enough to the picture.
		frameViaAnimation = true;
		frameRequest = requestAnimationFrame(onFrame);
	}
	frameElement = video;
}

function cancelFrame() {
	if (frameRequest === 0) {
		return;
	}
	if (frameViaAnimation) {
		cancelAnimationFrame(frameRequest);
	} else {
		// The handle belongs to the element it was requested on; after a source-driven
		// element swap props.video would be a different one and never release the handle.
		frameElement?.cancelVideoFrameCallback?.(frameRequest);
	}
	frameRequest = 0;
	frameElement = null;
}

function updateRunning() {
	const enabled = store.state.settings.danmakuEnabled && !!items?.length && frameWidth > 0;
	running = enabled && !!props.video && !document.hidden;
	if (running) {
		schedule();
		return;
	}
	cancelFrame();
	if (!enabled) {
		draw([]);
	}
	// A hidden tab keeps its last picture so nothing needs drawing on return; the next
	// frame sees the time jump and the engine re-anchors itself.
}

function onSeeked() {
	const video = props.video;
	if (!video || !engine) {
		return;
	}
	engine.seekTo(video.currentTime);
	draw([]);
	schedule();
}

function onPause() {
	redrawCurrent();
}

function onLoadedMetadata() {
	const video = props.video;
	if (!video) {
		return;
	}
	sizeCanvas(video);
	applyConfig();
	redrawCurrent();
}

function onEmptied() {
	engine?.reset();
	draw([]);
}

function onViewportChange() {
	const video = props.video;
	if (!video) {
		return;
	}
	sizeCanvas(video);
	applyConfig();
	redrawCurrent();
	// A first fit is what makes the frame loop possible at all (frameWidth > 0); without
	// this, a track that arrived before the first layout would never start drawing.
	updateRunning();
}

function onVisibilityChange() {
	updateRunning();
}

function attachVideo(video: HTMLVideoElement | undefined) {
	if (!video) {
		return;
	}
	video.addEventListener("pause", onPause);
	video.addEventListener("seeked", onSeeked);
	video.addEventListener("loadedmetadata", onLoadedMetadata);
	video.addEventListener("emptied", onEmptied);
}

function detachVideo(video: HTMLVideoElement | undefined) {
	if (!video) {
		return;
	}
	video.removeEventListener("pause", onPause);
	video.removeEventListener("seeked", onSeeked);
	video.removeEventListener("loadedmetadata", onLoadedMetadata);
	video.removeEventListener("emptied", onEmptied);
}

async function load() {
	loadGeneration++;
	const generation = loadGeneration;
	items = null;
	engine?.setItems([]);
	draw([]);
	updateRunning();
	const source = findDanmakuProvider(props.videoUrl);
	available.value = source !== null;
	if (!source || !store.state.settings.danmakuEnabled) {
		return;
	}
	const loaded = await source.provider.load(source.url);
	if (generation !== loadGeneration) {
		return;
	}
	items = loaded ?? [];
	engine?.setItems(items);
	updateRunning();
}

watch(
	() => props.videoUrl,
	() => {
		void load();
	},
	{ immediate: true },
);

watch(
	() => props.video,
	(video, oldVideo) => {
		// A pending callback belongs to the old element; release it there before the loop
		// moves to the new one, or its stale handle would freeze scheduling forever.
		cancelFrame();
		detachVideo(oldVideo);
		attachVideo(video);
		if (video) {
			sizeCanvas(video);
			applyConfig();
		}
		updateRunning();
	},
	{ immediate: true },
);

watch(
	() => store.state.settings.danmakuEnabled,
	() => {
		if (store.state.settings.danmakuEnabled && items === null) {
			void load();
		} else {
			updateRunning();
		}
	},
);

watch(
	() => [
		store.state.settings.danmakuFontSize,
		store.state.settings.danmakuSpeed,
		store.state.settings.danmakuAntiCollision,
		store.state.settings.danmakuBlockScroll,
		store.state.settings.danmakuBlockTop,
		store.state.settings.danmakuBlockBottom,
		store.state.settings.danmakuBlockColored,
	],
	() => {
		applyConfig();
		redrawCurrent();
	},
);

// Opacity is applied while drawing, so a change only needs one more frame.
watch(
	() => store.state.settings.danmakuOpacity,
	() => redrawCurrent(),
);

// A different fit moves and resizes the picture area the comments are laid out over.
watch(
	() => store.state.settings.videoFillMode,
	() => onViewportChange(),
);

// Layout changes reach us through the element itself (theater mode, letterboxing, the
// window), plus the two events that only the document sees.
useResizeObserver(
	() => props.video,
	() => onViewportChange(),
);

onMounted(() => {
	window.addEventListener("resize", onViewportChange);
	document.addEventListener("fullscreenchange", onViewportChange);
	document.addEventListener("visibilitychange", onVisibilityChange);
});

onBeforeUnmount(() => {
	loadGeneration++;
	cancelFrame();
	detachVideo(props.video);
	window.removeEventListener("resize", onViewportChange);
	document.removeEventListener("fullscreenchange", onViewportChange);
	document.removeEventListener("visibilitychange", onVisibilityChange);
	available.value = false;
});
</script>

<style scoped>
.danmaku-canvas {
	position: absolute;
	pointer-events: none;
}
</style>
