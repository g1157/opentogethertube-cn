<template>
	<div class="upscale-layer">
		<canvas ref="canvasElem" class="upscale-canvas" aria-hidden="true"></canvas>
		<div ref="captionElem" class="upscale-captions" role="status" aria-live="polite"></div>
	</div>
</template>

<script lang="ts" setup>
import { onBeforeUnmount, onMounted, ref, watch } from "vue";
import { i18n } from "@/i18n";
import { ToastStyle } from "@/models/toast";
import { useStore } from "@/store";
import {
	DEFAULT_UPSCALE_STRENGTH,
	MAX_UPSCALE_STRENGTH,
	MIN_UPSCALE_STRENGTH,
	type SettingsState,
} from "@/stores/settings";
import { computeCanvasSize } from "@/util/upscale/scale";
import type { UpscaleRenderer } from "@/util/upscale/upscale-renderer";
import toast from "@/util/toast";

const props = defineProps<{
	video?: HTMLVideoElement;
	mode: "sharpen" | "anime4k";
}>();

const store = useStore();
const canvasElem = ref<HTMLCanvasElement | null>(null);
const captionElem = ref<HTMLElement | null>(null);

// Degrade ladder, walked one rung per monitoring window.
const SCALE_STEPS = [2, 1.5, 1, 0.75, 0.5, 0.25] as const;
const STRENGTH_STEPS = [
	MAX_UPSCALE_STRENGTH,
	DEFAULT_UPSCALE_STRENGTH,
	MIN_UPSCALE_STRENGTH,
] as const;

let renderer: UpscaleRenderer | null = null;
let generation = 0;
let captionTimer: ReturnType<typeof setInterval> | undefined;
let monitorFrame = 0;
let monitorWindowStart = 0;
let monitorFrames = 0;

function sizeCanvas(video: HTMLVideoElement, canvas: HTMLCanvasElement) {
	const box = video.getBoundingClientRect();
	const size = computeCanvasSize({
		nativeWidth: video.videoWidth,
		nativeHeight: video.videoHeight,
		boxWidth: box.width,
		boxHeight: box.height,
		dpr: Math.min(window.devicePixelRatio || 1, 2),
		requestedScale: store.state.settings.upscaleScale,
	});
	canvas.width = size.width;
	canvas.height = size.height;
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
	if (!monitorWindowStart) {
		monitorWindowStart = now;
	}
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
	degradeOneStep(video, canvasElem.value);
}

/**
 * The next rung down, ending in turning the enhancement off. Ordered by how much
 * each rung relieves the device: render size first because the cost is proportional
 * to it, then the strength of the effect, and finally the effect itself.
 */
function pickDegradeStep(
	video: HTMLVideoElement,
	canvas: HTMLCanvasElement,
): Partial<SettingsState> {
	if (props.mode === "anime4k") {
		// The CNN runs at the source resolution, so shrinking the render target buys
		// almost nothing; switching to the cheap pass is the step that actually helps.
		return { upscaleMode: "sharpen" };
	}
	// The canvas may already sit below 1x when "auto" sized it to the displayed box,
	// so step down from what is actually rendered rather than from the named tier.
	const currentScale = canvas.width / Math.max(1, video.videoWidth);
	const scaleStep = SCALE_STEPS.find(step => step < currentScale - 0.01);
	if (scaleStep !== undefined) {
		// Store an explicit multiplier so the ladder and "auto" cannot fight over it.
		return { upscaleScale: scaleStep };
	}
	const strengthStep = STRENGTH_STEPS.find(
		step => step < store.state.settings.upscaleStrength - 0.001,
	);
	if (strengthStep !== undefined) {
		return { upscaleStrength: strengthStep };
	}
	return { upscaleMode: "off" };
}

function degradeOneStep(video: HTMLVideoElement | undefined, canvas: HTMLCanvasElement | null) {
	if (!video || !canvas) {
		return;
	}
	const step = pickDegradeStep(video, canvas);
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
	const canvas = canvasElem.value;
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
	const canvas = canvasElem.value;
	if (!video || !canvas) {
		return;
	}
	sizeCanvas(video, canvas);
	const current = ++generation;
	try {
		if (props.mode === "anime4k") {
			if (!("gpu" in navigator)) {
				throw new Error("WebGPU unavailable");
			}
			const { startAnime4KRenderer } = await import("@/util/upscale/anime4k");
			if (current !== generation) {
				return;
			}
			renderer = await startAnime4KRenderer(video, canvas);
		} else {
			const { startSharpenRenderer } = await import("@/util/upscale/cas");
			if (current !== generation) {
				return;
			}
			renderer = startSharpenRenderer(
				video,
				canvas,
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
		renderer?.stop();
		renderer = null;
		return;
	}
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
		const canvas = canvasElem.value;
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

.upscale-canvas {
	position: absolute;
	inset: 0;
	width: 100%;
	height: 100%;
	object-fit: contain;
	object-position: 50% 50%;
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
