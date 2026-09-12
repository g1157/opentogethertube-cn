<template>
	<div class="upscale-layer">
		<div ref="canvasHost" class="upscale-canvas-host"></div>
		<div ref="captionElem" class="upscale-captions" role="status" aria-live="polite"></div>
	</div>
</template>

<script lang="ts" setup>
import { onBeforeUnmount, onMounted, ref, watch } from "vue";
import { i18n } from "@/i18n";
import { ToastStyle } from "@/models/toast";
import { useStore } from "@/store";
import type { SettingsState } from "@/stores/settings";
import { computeCanvasSize } from "@/util/upscale/scale";
import type { UpscaleRenderer } from "@/util/upscale/upscale-renderer";
import toast from "@/util/toast";

const props = defineProps<{
	video?: HTMLVideoElement;
	mode: "sharpen" | "anime4k";
}>();

const store = useStore();
const canvasHost = ref<HTMLElement | null>(null);
const captionElem = ref<HTMLElement | null>(null);

// Degrade ladder, walked one rung per monitoring window.
const SCALE_STEPS = [2, 1.5, 1, 0.75, 0.5, 0.25] as const;
// A gap this long between presented frames means nothing was being drawn — a pause, a
// seek, a rebuffer or a backgrounded tab. That time says nothing about the device, so
// the measurement restarts instead of scoring it as an abysmal frame rate. Judging needs
// 24 frames in a 6s window, so nothing slower than 4fps is judged either way; a second is
// far above any real frame interval and far below a human pause.
const STALL_MS = 1000;

let renderer: UpscaleRenderer | null = null;
let canvas: HTMLCanvasElement | null = null;
let generation = 0;
let captionTimer: ReturnType<typeof setInterval> | undefined;
let monitorFrame = 0;
let monitorWindowStart = 0;
let monitorFrames = 0;
// Negative infinity rather than 0, so "no frame yet" cannot be confused with a clock
// that legitimately reads 0.
let lastFrameAt = Number.NEGATIVE_INFINITY;

/**
 * A canvas keeps whatever context type it was first asked for, and the sharpen renderer
 * deliberately loses its WebGL context when it stops, so a canvas that has hosted one
 * renderer can never host another — switching tiers or reloading the media would just
 * fail to get a context. Every start therefore gets a canvas of its own.
 */
function createCanvas(): HTMLCanvasElement | null {
	const host = canvasHost.value;
	if (!host) {
		return null;
	}
	const element = document.createElement("canvas");
	element.className = "upscale-canvas";
	element.setAttribute("aria-hidden", "true");
	host.replaceChildren(element);
	return element;
}

function sizeCanvas(video: HTMLVideoElement, target: HTMLCanvasElement) {
	const box = video.getBoundingClientRect();
	const size = computeCanvasSize({
		nativeWidth: video.videoWidth,
		nativeHeight: video.videoHeight,
		boxWidth: box.width,
		boxHeight: box.height,
		dpr: Math.min(window.devicePixelRatio || 1, 2),
		requestedScale: store.state.settings.upscaleScale,
	});
	target.width = size.width;
	target.height = size.height;
}

function updateCaptions() {
	const video = props.video;
	const target = captionElem.value;
	if (!video || !target) {
		return;
	}
	let text = "";
	for (const track of Array.from(video.textTracks)) {
		if (track.mode !== "showing" || !track.activeCues) {
			continue;
		}
		for (const cue of Array.from(track.activeCues)) {
			const cueText = (cue as VTTCue).text;
			if (cueText) {
				text += `${text ? "\n" : ""}${cueText}`;
			}
		}
	}
	if (target.textContent !== text) {
		target.textContent = text;
	}
}

function scheduleMonitor() {
	const video = props.video;
	if (video && monitorFrame) {
		video.cancelVideoFrameCallback(monitorFrame);
	}
	monitorFrame = video ? video.requestVideoFrameCallback(monitorPerformance) : 0;
}

function monitorPerformance() {
	const video = props.video;
	if (!video) {
		return;
	}
	const now = performance.now();
	if (video.paused) {
		// Paused videos produce no frames; counting that time would look like 0 fps.
		monitorWindowStart = 0;
		monitorFrames = 0;
		scheduleMonitor();
		return;
	}
	if (now - lastFrameAt > STALL_MS) {
		// requestVideoFrameCallback stops firing while the video is paused, so the paused
		// check above may never run; this is what actually catches it. Without it, resuming
		// after a pause scores the whole pause as one window and degrades on the first frame.
		monitorWindowStart = now;
		monitorFrames = 0;
	}
	lastFrameAt = now;
	monitorFrames++;
	scheduleMonitor();
	if (now - monitorWindowStart < 6000) {
		return;
	}
	const elapsed = (now - monitorWindowStart) / 1000;
	const frames = monitorFrames;
	monitorWindowStart = now;
	monitorFrames = 0;
	if (frames < 24) {
		return;
	}
	const fps = frames / elapsed;
	if (fps >= 18) {
		return;
	}
	if (!store.state.settings.upscaleAutoDegrade) {
		// The user chose to keep the enhancement on and absorb the stutter.
		return;
	}
	degradeOneStep(video, canvas);
}

/**
 * The next rung down, ending in turning the enhancement off. Only render size and the
 * algorithm appear here: lowering the sharpen strength changes one uniform while the
 * shader still samples five texels per pixel, so it would spend a whole window waiting
 * to see no improvement. The slider is a quality control, not a performance one.
 */
function pickDegradeStep(
	video: HTMLVideoElement,
	target: HTMLCanvasElement,
): Partial<SettingsState> {
	if (props.mode === "anime4k") {
		// The CNN runs at the source resolution, so shrinking the render target buys
		// almost nothing; switching to the cheap pass is the step that actually helps.
		return { upscaleMode: "sharpen" };
	}
	// The canvas may already sit below 1x when "auto" sized it to the displayed box,
	// so step down from what is actually rendered rather than from the named tier.
	const currentScale = target.width / Math.max(1, video.videoWidth);
	const scaleStep = SCALE_STEPS.find(step => step < currentScale - 0.01);
	if (scaleStep !== undefined) {
		// Store an explicit multiplier so the ladder and "auto" cannot fight over it.
		return { upscaleScale: scaleStep };
	}
	return { upscaleMode: "off" };
}

function degradeOneStep(video: HTMLVideoElement | undefined, target: HTMLCanvasElement | null) {
	if (!video || !target) {
		return;
	}
	const step = pickDegradeStep(video, target);
	toast.add({
		style: ToastStyle.Neutral,
		content: i18n.global.t("room.upscale.degraded"),
		duration: 6000,
	});
	store.commit("settings/UPDATE", step);
	// Give the new setting a full window to prove itself before stepping again,
	// whichever watcher it woke.
	monitorWindowStart = 0;
	monitorFrames = 0;
}

function handleViewportChange() {
	const video = props.video;
	if (props.mode === "sharpen" && renderer && video && canvas) {
		// The sharpen pass reads the canvas size every frame, so a resize is enough.
		sizeCanvas(video, canvas);
	}
}

function stopRenderers() {
	generation++;
	renderer?.stop();
	renderer = null;
	if (captionTimer !== undefined) {
		clearInterval(captionTimer);
		captionTimer = undefined;
	}
	const video = props.video;
	if (video && monitorFrame) {
		video.cancelVideoFrameCallback(monitorFrame);
		monitorFrame = 0;
	}
}

async function start() {
	stopRenderers();
	const video = props.video;
	const element = createCanvas();
	if (!video || !element) {
		return;
	}
	sizeCanvas(video, element);
	const current = ++generation;
	// Hold the result locally until the generation check: assigning straight to `renderer`
	// lets a slow start clobber the renderer a newer one already installed, after which
	// nothing holds a reference to stop it and its frame loop and device leak.
	let created: UpscaleRenderer | null = null;
	try {
		if (props.mode === "anime4k") {
			if (!("gpu" in navigator)) {
				throw new Error("WebGPU unavailable");
			}
			const { startAnime4KRenderer } = await import("@/util/upscale/anime4k");
			if (current !== generation) {
				// Skip building a GPU device only to throw it away.
				return;
			}
			created = await startAnime4KRenderer(video, element);
		} else {
			const { startSharpenRenderer } = await import("@/util/upscale/cas");
			created = startSharpenRenderer(
				video,
				element,
				() => store.state.settings.upscaleStrength,
			);
		}
	} catch (err) {
		console.warn("Video enhancement unavailable:", err);
		if (current !== generation) {
			return;
		}
		const webgpu = props.mode === "anime4k";
		toast.add({
			style: ToastStyle.Error,
			content: i18n.global.t(webgpu ? "room.upscale.webgpu-fallback" : "room.upscale.failed"),
			duration: 6000,
		});
		store.commit("settings/UPDATE", { upscaleMode: webgpu ? "sharpen" : "off" });
		return;
	}
	if (current !== generation) {
		created?.stop();
		return;
	}
	renderer = created;
	canvas = element;
	updateCaptions();
	captionTimer = setInterval(updateCaptions, 250);
	monitorWindowStart = 0;
	monitorFrames = 0;
	monitorFrame = video.requestVideoFrameCallback(monitorPerformance);
}

function onLoadedMetadata() {
	void start();
}

function attachVideo(video: HTMLVideoElement | undefined) {
	if (video) {
		video.addEventListener("loadedmetadata", onLoadedMetadata);
	}
}

function detachVideo(video: HTMLVideoElement | undefined) {
	if (video) {
		video.removeEventListener("loadedmetadata", onLoadedMetadata);
	}
}

watch(
	() => props.video,
	(video, oldVideo) => {
		detachVideo(oldVideo);
		attachVideo(video);
		void start();
	},
);

watch(
	() => props.mode,
	() => void start(),
);

watch(
	() => store.state.settings.upscaleScale,
	() => {
		const video = props.video;
		if (!video || !canvas) {
			return;
		}
		if (props.mode === "anime4k") {
			// The Anime4K pipeline captures its target size when it is built.
			void start();
			return;
		}
		// The sharpen pass reads the canvas size every frame, so a resize is enough.
		sizeCanvas(video, canvas);
	},
);

onMounted(() => {
	attachVideo(props.video);
	window.addEventListener("resize", handleViewportChange);
	document.addEventListener("fullscreenchange", handleViewportChange);
	void start();
});

onBeforeUnmount(() => {
	window.removeEventListener("resize", handleViewportChange);
	document.removeEventListener("fullscreenchange", handleViewportChange);
	detachVideo(props.video);
	stopRenderers();
});
</script>

<style scoped>
.upscale-layer {
	position: absolute;
	inset: 0;
	pointer-events: none;
}

.upscale-canvas-host {
	position: absolute;
	inset: 0;
}

.upscale-captions {
	position: absolute;
	left: 5%;
	right: 5%;
	bottom: 8%;
	color: #fff;
	text-align: center;
	font-size: clamp(14px, 2.2vw, 22px);
	line-height: 1.4;
	white-space: pre-line;
	text-shadow: 0 1px 2px rgb(0 0 0 / 0.9), 0 0 4px rgb(0 0 0 / 0.7);
}

.upscale-captions:empty {
	display: none;
}
</style>

<!-- Not scoped: the canvas is built in script, so it never receives this component's
     scope id and a scoped rule would not match it. -->
<style>
.upscale-canvas {
	position: absolute;
	inset: 0;
	width: 100%;
	height: 100%;
	object-fit: contain;
	object-position: 50% 50%;
}
</style>
