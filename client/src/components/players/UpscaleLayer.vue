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
import {
	canAffordCnnUpscale,
	computeCanvasSize,
	isCnnUpscaleTier,
	ladderFloorScale,
	MAX_DPR,
} from "@/util/upscale/scale";
import type { UpscaleRenderer } from "@/util/upscale/upscale-renderer";
import { reportEnhancementError, reportEnhancementTarget } from "@/util/upscale/status";
import toast from "@/util/toast";

const props = defineProps<{
	video?: HTMLVideoElement;
	mode: "sharpen" | "film" | "anime4k" | "anime4k-quality" | "anime4k-ultra";
}>();

const store = useStore();
const canvasHost = ref<HTMLElement | null>(null);
const captionElem = ref<HTMLElement | null>(null);

// Degrade ladder, walked one rung per monitoring window.
const SCALE_STEPS = [3, 2.5, 2, 1.5, 1, 0.75, 0.5, 0.25] as const;
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
/** The element the pending monitor callback was registered on; props.video may be newer. */
let monitorElement: HTMLVideoElement | null = null;
let monitorWindowStart = 0;
let monitorFrames = 0;
// Negative infinity rather than 0, so "no frame yet" cannot be confused with a clock
// that legitimately reads 0.
let lastFrameAt = Number.NEGATIVE_INFINITY;
// A rebuild pays for itself in shader linking and a first frame, so the monitoring window
// that starts with one is not evidence about the device and is thrown away unread.
let monitorSkipWindow = false;

/**
 * A canvas keeps whatever context type it was first asked for, so WebGL2 and WebGPU each get a
 * canvas of their own — and each of those is kept for the life of the layer, because rebuilding
 * on the same canvas preserves its context and the programs linked on it (see the program cache
 * in cas.ts). Linking the heavy chain's 55 shaders again on every tier switch, scale step and
 * fullscreen toggle was the most visible part of those rebuilds.
 */
type CanvasKind = "webgl2" | "webgpu";
const canvases: Record<CanvasKind, HTMLCanvasElement | null> = { webgl2: null, webgpu: null };

function acquireCanvas(kind: CanvasKind): HTMLCanvasElement | null {
	const host = canvasHost.value;
	if (!host) {
		return null;
	}
	let element = canvases[kind];
	if (!element) {
		element = document.createElement("canvas");
		element.className = "upscale-canvas";
		element.setAttribute("aria-hidden", "true");
		canvases[kind] = element;
	}
	// Only one canvas may be on screen: whichever tier is not running must not show through.
	if (host.firstElementChild !== element || host.childElementCount !== 1) {
		host.replaceChildren(element);
	}
	return element;
}

function sizeCanvas(video: HTMLVideoElement, target: HTMLCanvasElement) {
	const box = video.getBoundingClientRect();
	const size = computeCanvasSize({
		nativeWidth: video.videoWidth,
		nativeHeight: video.videoHeight,
		boxWidth: box.width,
		boxHeight: box.height,
		dpr: Math.min(window.devicePixelRatio || 1, MAX_DPR),
		requestedScale: store.state.settings.upscaleScale,
		cnnUpscale: isCnnUpscaleTier(props.mode) && canAffordCnnUpscale(),
		fillMode: store.state.settings.videoFillMode,
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
	if (monitorElement && monitorFrame) {
		// Cancelling has to happen on the element the callback was registered on; after an
		// element switch props.video would only swallow the id on the wrong element.
		monitorElement.cancelVideoFrameCallback(monitorFrame);
	}
	const video = props.video;
	monitorFrame = video ? video.requestVideoFrameCallback(monitorPerformance) : 0;
	monitorElement = video ?? null;
}

function monitorPerformance() {
	const video = props.video;
	if (!video || video !== monitorElement) {
		// A callback that outlived its element: the new element gets its own schedule, and
		// this stale chain must not re-arm itself on top of it.
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
	if (monitorSkipWindow) {
		// The window began at a rebuild, so its first frames were the rebuild itself. Judge the
		// window after this one rather than stepping down on a cost that has already been paid.
		monitorSkipWindow = false;
		return;
	}
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
	if (props.mode === "anime4k-ultra") {
		// The heavy chain gives way to the everyday AI tier first: same network family, a
		// fraction of the passes.
		return { upscaleMode: "anime4k" };
	}
	if (props.mode === "anime4k-quality") {
		// The heavy A+A chain gives way first: the fast preset keeps the same upscale
		// for about half the GPU cost.
		return { upscaleMode: "anime4k" };
	}
	if (props.mode === "anime4k") {
		// The CNN runs at the source resolution, so shrinking the render target buys
		// almost nothing; switching to the cheaper pass is the step that actually helps.
		return { upscaleMode: "film" };
	}
	if (props.mode === "film") {
		// The film chain is the heavier of the two WebGL2 tiers; plain sharpening is what
		// is left before the ladder starts shrinking the render target.
		return { upscaleMode: "sharpen" };
	}
	// The canvas may already sit below 1x when "auto" sized it to the displayed box,
	// so step down from what is actually rendered rather than from the named tier.
	const currentScale = target.width / Math.max(1, video.videoWidth);
	// Below the display box the shader's own filtering decides the picture and the result is
	// softer than the plain video, so the ladder ends there instead of stepping past it.
	const box = video.getBoundingClientRect();
	const floor = ladderFloorScale({
		nativeWidth: video.videoWidth,
		nativeHeight: video.videoHeight,
		boxWidth: box.width,
		boxHeight: box.height,
		dpr: Math.min(window.devicePixelRatio || 1, MAX_DPR),
		fillMode: store.state.settings.videoFillMode,
	});
	const scaleStep = SCALE_STEPS.find(step => step < currentScale - 0.01 && step >= floor - 0.01);
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
	// Transient on purpose: the ladder reacts to this device and this moment (another tab on
	// the GPU, a heavy scene), and persisting it would quietly replace the tier the user
	// picked with the tier their slowest minute produced.
	store.commit("settings/UPDATE_TRANSIENT", step);
	// Give the new setting a full window to prove itself before stepping again,
	// whichever watcher it woke.
	monitorWindowStart = 0;
	monitorFrames = 0;
}

// A rebuild costs a GPU device and a pipeline, so the viewport has to settle first;
// otherwise dragging a window edge would rebuild it dozens of times.
const VIEWPORT_SETTLE_MS = 250;
let viewportTimer: ReturnType<typeof setTimeout> | undefined;

function handleViewportChange() {
	const video = props.video;
	if (!renderer || !video || !canvas) {
		return;
	}
	if (props.mode === "sharpen") {
		// The sharpen pass reads the canvas size every frame, so a resize is enough.
		sizeCanvas(video, canvas);
		return;
	}
	// Anime4K captures its target size when the pipeline is built, so entering fullscreen
	// (or resizing the window) has to rebuild it — otherwise the canvas keeps the old
	// resolution and the browser stretches it, which loses exactly what the tier bought.
	if (viewportTimer !== undefined) {
		clearTimeout(viewportTimer);
	}
	viewportTimer = setTimeout(() => {
		viewportTimer = undefined;
		void start();
	}, VIEWPORT_SETTLE_MS);
}

function stopRenderers() {
	generation++;
	if (viewportTimer !== undefined) {
		clearTimeout(viewportTimer);
		viewportTimer = undefined;
	}
	renderer?.stop();
	renderer = null;
	if (captionTimer !== undefined) {
		clearInterval(captionTimer);
		captionTimer = undefined;
	}
	if (monitorElement && monitorFrame) {
		monitorElement.cancelVideoFrameCallback(monitorFrame);
		monitorFrame = 0;
	}
	monitorElement = null;
}

/**
 * Where to go when the current tier cannot run, and what to tell the viewer. Each
 * WebGPU tier falls back to the next lighter one before giving up the enhancement.
 */
function failureFallback(): { settings: Partial<SettingsState>; message: string } {
	if (props.mode === "anime4k-ultra") {
		return {
			settings: { upscaleMode: "anime4k" },
			message: "room.upscale.anime4k-ultra-fallback",
		};
	}
	if (props.mode === "anime4k-quality") {
		return {
			settings: { upscaleMode: "anime4k" },
			message: "room.upscale.anime4k-quality-fallback",
		};
	}
	if (props.mode === "anime4k") {
		return {
			settings: { upscaleMode: "sharpen" },
			// Only claim a missing WebGPU when it is really missing; anything else is the
			// tier failing, and the reason is kept for the playback details panel.
			message:
				"gpu" in navigator
					? "room.upscale.anime4k-fallback"
					: "room.upscale.webgpu-fallback",
		};
	}
	if (props.mode === "film") {
		// A failed clean chain usually means the driver refused its half-float targets;
		// the plain sharpen tier is the one that has always worked everywhere.
		return { settings: { upscaleMode: "sharpen" }, message: "room.upscale.film-fallback" };
	}
	return { settings: { upscaleMode: "off" }, message: "room.upscale.failed" };
}

function fallBackFromFailure(): void {
	const { settings, message } = failureFallback();
	toast.add({
		style: ToastStyle.Error,
		content: i18n.global.t(message),
		duration: 6000,
	});
	store.commit("settings/UPDATE", settings);
}

async function start() {
	stopRenderers();
	// Whatever the previous tier reported is stale from here on; the renderer about to be
	// built reports its own target once it has drawn its first frame.
	reportEnhancementTarget(null);
	const video = props.video;
	// The WebGPU attempt needs a canvas that has never handed out a WebGL2 context, so the
	// tier's family decides which one is taken first; a WebGL2 fallback takes its own below.
	const aiTier = props.mode === "anime4k" || props.mode === "anime4k-quality";
	let element = acquireCanvas(aiTier ? "webgpu" : "webgl2");
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
		if (props.mode === "anime4k-ultra") {
			// Offered only where WebGPU is unavailable, so this is the heavy chain on WebGL2.
			const { startAnime4KUltraRenderer } = await import("@/util/upscale/anime4k-ultra");
			created = startAnime4KUltraRenderer(video, element);
		} else if (props.mode === "anime4k" || props.mode === "anime4k-quality") {
			const variant = props.mode === "anime4k-quality" ? "quality" : "fast";
			// Probe the WebGPU path before importing the driver: the driver pulls a 3.4 MB chunk,
			// and on the platforms that never hand out an adapter (Firefox outside Windows and
			// Nightly, blocklisted drivers) — or that hand out one which cannot write the
			// rgba16float storage textures the Anime4K pipelines need, which is what Firefox's
			// Windows builds have been doing — that download is wasted: the WebGL2 chain below is
			// the tier that actually runs there.
			const { canRunWebGPUEnhancement } = await import("@/util/upscale/webgpu-probe");
			if (await canRunWebGPUEnhancement(video)) {
				// WebGPU reports most setup mistakes through error scopes instead of exceptions, so
				// a browser with a partial implementation throws here rather than at the first
				// drawn frame.
				const { startAnime4KRenderer } = await import("@/util/upscale/anime4k");
				if (current !== generation) {
					// Skip building a GPU device only to throw it away.
					return;
				}
				try {
					created = await startAnime4KRenderer(video, element, variant, message => {
						// WebGPU gave up on its own: a lost device, or a validation failure the
						// error scope caught. Step down instead of leaving a dead canvas.
						if (current !== generation) {
							return;
						}
						reportEnhancementError(message);
						fallBackFromFailure();
					});
				} catch (err) {
					// The same network runs on WebGL2, which every browser has. Only reachable
					// for the tiers that need a GPU: the plain tiers above are already WebGL2.
					console.warn("WebGPU Anime4K unavailable, using the WebGL2 chain:", err);
					created = null;
				}
			}
			if (!created) {
				if (current !== generation) {
					return;
				}
				// The WebGPU attempt may have claimed its own canvas, and a canvas only ever hands
				// out one context type, so the WebGL2 chain takes the WebGL2 one.
				const webglCanvas = acquireCanvas("webgl2");
				if (!webglCanvas) {
					return;
				}
				// This second canvas is brand new, so it still holds the 300x150 default. The
				// WebGL2 chain sizes its whole pipeline from the canvas, so without this it drew
				// a 2:1 picture the browser then letterboxed over the 16:9 video.
				sizeCanvas(video, webglCanvas);
				if (props.mode === "anime4k-quality") {
					// The heavy tier runs the same A+A (HQ) chain the WebGPU "quality" preset does,
					// so the two AI tiers differ on WebGL2 the way they do on a WebGPU device.
					const { startAnime4KUltraRenderer } = await import(
						"@/util/upscale/anime4k-ultra"
					);
					created = startAnime4KUltraRenderer(video, webglCanvas);
				} else {
					const { startAnime4KWebGLRenderer } = await import(
						"@/util/upscale/anime4k-webgl"
					);
					created = startAnime4KWebGLRenderer(video, webglCanvas);
				}
				element = webglCanvas;
			}
		} else if (props.mode === "film") {
			// Live action: clean the source's compression artifacts before the upscale.
			const { startFilmRenderer } = await import("@/util/upscale/film");
			created = startFilmRenderer(video, element, {
				getStrength: () => store.state.settings.upscaleStrength,
			});
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
		reportEnhancementError(err instanceof Error ? err.message : String(err));
		fallBackFromFailure();
		return;
	}
	if (current !== generation) {
		created?.stop();
		return;
	}
	renderer = created;
	canvas = element;
	// A tier that started cleanly clears the last failure; the panel shows whichever
	// cause is still current. The target label is not cleared here: the renderers report it
	// on their first drawn frame, and start() has already drawn that frame by now.
	reportEnhancementError(null);
	updateCaptions();
	captionTimer = setInterval(updateCaptions, 250);
	monitorWindowStart = 0;
	monitorFrames = 0;
	monitorSkipWindow = true;
	scheduleMonitor();
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
		if (props.mode === "anime4k" || props.mode === "anime4k-quality") {
			// Both WebGPU presets capture their target size when the pipeline is built.
			void start();
			return;
		}
		// The sharpen/film passes read the canvas size every frame, so a resize is enough.
		sizeCanvas(video, canvas);
	},
);

// A fit change moves the displayed picture, which changes the size the canvas should hold;
// the same settle-and-rebuild path as a viewport change keeps the pipeline consistent.
watch(
	() => store.state.settings.videoFillMode,
	() => handleViewportChange(),
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
	// The panel would otherwise keep showing the last tier's target after the layer is gone.
	reportEnhancementTarget(null);
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

<!-- biome-ignore lint/nursery/useScopedStyles: the canvas is built in script, so it never receives this component's scope id and a scoped rule would not match it. -->
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
