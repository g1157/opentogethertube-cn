<template>
	<canvas ref="canvasElem" class="danmaku-canvas" aria-hidden="true"></canvas>
</template>

<script lang="ts" setup>
import { onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useResizeObserver } from "@vueuse/core";
import { useStore } from "@/store";
import { DANMAKU_MAX_PER_SECOND } from "@/stores/settings";
import { i18n } from "@/i18n";
import { ToastStyle } from "@/models/toast";
import toast from "@/util/toast";
import { DanmakuEngine, type DanmakuRenderItem } from "@/util/danmaku/engine";
import {
	autoMatch,
	bindingsState,
	danmuApiProvider,
	getBinding,
	getDanmakuApiBase,
	looksLikeRemoteCandidate,
	rememberBinding,
	setDanmakuApiBase,
	trackUrl,
	type DanmakuBinding,
} from "@/util/danmaku/danmu-api";
import { loadGirigiriTrack } from "@/util/danmaku/girigiri-api";
import { findDanmakuProvider } from "@/util/danmaku/provider";
import { shiftDanmakuTime, type DanmakuItem } from "@/util/danmaku/parse";
import { useDanmaku } from "../composables";

const props = defineProps<{
	video?: HTMLVideoElement;
	videoUrl: string;
}>();

const store = useStore();
const { available, loadedCount, currentVideoUrl } = useDanmaku();
const canvasElem = ref<HTMLCanvasElement | null>(null);

// girigiri's measured proportions, kept so the picture reads the same: ~19.2px text on a
// 577px-high picture, lanes at 1.1x the font size, an 8s traverse, a thin black outline.
const FONT_RATIO = 0.0333;
const FONT_SIZE_SCALES = { small: 0.8, medium: 1, large: 1.25 } as const;
const MIN_FONT_PX = 12;
const MAX_FONT_PX = 44;
const SCROLL_DURATION_SECONDS = 8;
const MAX_ON_SCREEN = 100;
/**
 * Text is ~19px; two device pixels per CSS pixel is already supersampled well past what
 * the eye resolves, and the third used to multiply the per-frame clear/fill cost for
 * nothing on a 3x display.
 */
const MAX_DPR = 2;
const FONT_FAMILY = "system-ui, sans-serif";
const FONT_WEIGHT = 500;
const OUTLINE_WIDTH = 1.2;

let engine: DanmakuEngine | null = null;
let items: DanmakuItem[] | null = null;
let loadGeneration = 0;
let frameRequest = 0;
/** Media time of the last painted frame; an unchanged clock needs no repaint. */
let lastDrawnTime = -1;
// The clock the comments advance on. video.currentTime steps once per presented frame — a
// 24fps anime steps 24 times a second — so reading it directly made scrolling comments
// judder on a 60/120Hz screen while the picture itself stayed smooth (the decoder
// interpolates, the property does not). Every frame that sees a new media time re-anchors
// here and the wall clock carries the motion in between, so a seek, a pause or a playback
// rate change corrects the clock on the next frame.
let clockMediaTime = Number.NEGATIVE_INFINITY;
let clockAnchoredAt = 0;
let clockRate = 1;
/**
 * How far the extrapolated clock may run past the last media time it saw. Without this cap
 * a stalled video (a rebuffer, a background tab) would let comments keep sliding over a
 * frozen picture.
 */
const MAX_CLOCK_LEAD_SECONDS = 0.25;
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
		area: settings.danmakuDisplayArea,
		maxPerSecond: DANMAKU_MAX_PER_SECOND[settings.danmakuDensity],
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
	// The desynchronized (low-latency) hint is deliberately not used: Chromium composites a
	// transparent canvas created with it as opaque black on some Android GPUs
	// (crbug 450752884), which turns this overlay into a black rectangle over the video.
	// The hint only buys latency a text overlay has no use for.
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
		lastDrawnTime = video.currentTime;
	}
}

/**
 * The media clock to lay the comments out on: the last observed media time plus the wall
 * clock since it was observed, capped so a stalled video cannot run away from its picture.
 */
function smoothCurrentTime(video: HTMLVideoElement, now: number): number {
	const mediaTime = video.currentTime;
	if (mediaTime !== clockMediaTime) {
		clockMediaTime = mediaTime;
		clockAnchoredAt = now;
		clockRate = video.playbackRate;
		return mediaTime;
	}
	const rate = video.playbackRate;
	if (rate !== clockRate) {
		// The room or a rate bend changed the slope; the position stays where it is.
		clockAnchoredAt = now;
		clockRate = rate;
	}
	const lead = Math.min(((now - clockAnchoredAt) / 1000) * clockRate, MAX_CLOCK_LEAD_SECONDS);
	return clockMediaTime + Math.max(0, lead);
}

/**
 * The requestAnimationFrame loop paints at the display's rate and reads the media clock
 * for the schedule itself. Driving it from requestVideoFrameCallback instead — which
 * only fires when the video presents a frame — capped the motion to the source's frame
 * rate (24fps anime juddered on a 60Hz screen) for no benefit: the clock is continuous
 * either way, and the room's speed, rate bends and local seeks already live in it.
 */
function onFrame() {
	frameRequest = 0;
	const video = props.video;
	if (!video || !engine || video.paused) {
		// A paused picture is repainted by whichever handler changes it; the play
		// listener starts the loop again when playback resumes.
		return;
	}
	const clock = smoothCurrentTime(video, performance.now());
	if (clock !== lastDrawnTime) {
		draw(engine.tick(clock));
		lastDrawnTime = clock;
	}
	schedule();
}

function schedule() {
	if (frameRequest !== 0 || !running) {
		return;
	}
	const video = props.video;
	if (!video || video.paused || document.hidden) {
		return;
	}
	frameRequest = requestAnimationFrame(onFrame);
}

function cancelFrame() {
	if (frameRequest === 0) {
		return;
	}
	cancelAnimationFrame(frameRequest);
	frameRequest = 0;
}

function updateRunning() {
	const enabled = store.state.settings.danmakuEnabled && !!items?.length && frameWidth > 0;
	running = enabled && !!props.video && !document.hidden;
	if (running) {
		if (props.video?.paused) {
			// A paused picture cannot advance the loop; show the current moment once.
			redrawCurrent();
			return;
		}
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
	// Re-anchored immediately: a paused seek must show the new position without waiting
	// for a frame, and a playing one starts from the same clock on the next frame.
	redrawCurrent();
	schedule();
}

function onPlay() {
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
	lastDrawnTime = -1;
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
	video.addEventListener("play", onPlay);
	video.addEventListener("pause", onPause);
	video.addEventListener("seeked", onSeeked);
	video.addEventListener("loadedmetadata", onLoadedMetadata);
	video.addEventListener("emptied", onEmptied);
}

function detachVideo(video: HTMLVideoElement | undefined) {
	if (!video) {
		return;
	}
	video.removeEventListener("play", onPlay);
	video.removeEventListener("pause", onPause);
	video.removeEventListener("seeked", onSeeked);
	video.removeEventListener("loadedmetadata", onLoadedMetadata);
	video.removeEventListener("emptied", onEmptied);
}

/** Loads the track a stored binding points at, whichever provider it belongs to. */
function loadBindingTrack(binding: DanmakuBinding): Promise<DanmakuItem[] | null> {
	if (binding.provider === "girigiri") {
		return binding.page ? loadGirigiriTrack(binding.page) : Promise.resolve(null);
	}
	const url = trackUrl(binding);
	return url ? danmuApiProvider.load(url) : Promise.resolve(null);
}

/**
 * Second source for videos the URL rules do not know — and for URL-matched tracks that
 * turned out to be missing (a girigiri 404). The self-hosted aggregator answers with a
 * best-effort match that is remembered for the next visit; an explicit binding never
 * gets here, because the user's own choice must not be silently replaced by a match.
 */
async function loadFromAggregator(): Promise<DanmakuItem[] | null> {
	const binding = await autoMatch(props.videoUrl);
	if (!binding) {
		return null;
	}
	const url = trackUrl(binding);
	const loaded = url ? await danmuApiProvider.load(url) : null;
	if (loaded !== null) {
		// Remembered only after a track actually arrived; the reload this triggers reads
		// the same URL back from the fetch cache.
		rememberBinding(props.videoUrl, binding);
	}
	return loaded;
}

async function load() {
	loadGeneration++;
	const generation = loadGeneration;
	items = null;
	loadedCount.value = 0;
	engine?.setItems([]);
	draw([]);
	updateRunning();
	const binding = getBinding(props.videoUrl);
	const direct = findDanmakuProvider(props.videoUrl);
	const aggregator = getDanmakuApiBase() !== "" && looksLikeRemoteCandidate(props.videoUrl);
	available.value = binding !== null || direct !== null || aggregator;
	if (!store.state.settings.danmakuEnabled) {
		return;
	}
	let loaded: DanmakuItem[] | null = direct ? await direct.provider.load(direct.url) : null;
	if (generation !== loadGeneration) {
		return;
	}
	// A binding is the user's own pick for this video (a girigiri episode on someone
	// else's source, for one), so it is tried after the URL-derived track and, when it
	// fails, the automatic matcher stands down instead of overriding the choice.
	if (loaded === null && binding) {
		loaded = await loadBindingTrack(binding);
		if (generation !== loadGeneration) {
			return;
		}
	}
	if (loaded === null && binding === null && aggregator) {
		loaded = await loadFromAggregator();
		if (generation !== loadGeneration) {
			return;
		}
	}
	items = loaded === null ? [] : binding ? shiftDanmakuTime(loaded, binding.offset) : loaded;
	loadedCount.value = items.length;
	if (items.length > 0) {
		// Feedback that a track actually arrived; without it the only sign was comments
		// appearing over the picture.
		toast.add({
			style: ToastStyle.Neutral,
			content: i18n.global.t("room.danmaku.loaded-toast", { count: items.length }),
			duration: 3000,
		});
	}
	engine?.setItems(items);
	updateRunning();
}

// The aggregator's base lives in this device's settings; the layer mirrors it into the
// module before the first lookup and re-resolves whenever it changes.
watch(
	() => store.state.settings.danmakuApiBase,
	base => {
		setDanmakuApiBase(base);
		void load();
	},
	{ immediate: true },
);

// A manual bind (or clear) from the settings panel re-resolves the current video.
watch(bindingsState, () => {
	void load();
});

watch(
	() => props.videoUrl,
	url => {
		currentVideoUrl.value = url;
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
		store.state.settings.danmakuDisplayArea,
		store.state.settings.danmakuDensity,
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
