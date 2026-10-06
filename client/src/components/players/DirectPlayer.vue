<template>
	<div
		class="direct"
		:class="{ 'video-fill-cover': fillMode === 'cover', 'video-mirror': mirror }"
	>
		<video
			ref="videoElem"
			:key="surfaceGeneration"
			playsinline
			webkit-playsinline
			preload="auto"
			:crossorigin="crossoriginEnabled ? 'anonymous' : undefined"
			@loadedmetadata="recovery.restoreMetadata"
			@loadeddata="onCanPlay"
			@canplay="onCanPlay"
			@seeked="onCanPlay"
			@playing="onPlaying"
			@pause="onPaused"
			@waiting="onBuffering"
			@stalled="onStalled"
			@loadstart="onBuffering"
			@progress="onProgress"
			@ended="onEnd"
			@error="onError"
		>
			<track
				v-for="track in vttSources"
				:key="track.url"
				kind="subtitles"
				:src="track.url"
				:srclang="track.srclang"
				:label="track.name"
				:default="track.default"
			/>
		</video>
		<UpscaleLayer
			v-if="upscaleMode !== 'off'"
			:video="videoElem"
			:mode="enhancementLayerMode(upscaleMode)"
		/>
		<div ref="subtitleCanvasHost" v-show="assVisible" class="jassub-canvas-host"></div>
		<DanmakuLayer v-if="videoElem" :video="videoElem" :video-url="videoUrl" />
	</div>
</template>

<script lang="ts" setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, toRefs, watch } from "vue";
import JASSUB from "jassub";
// ?url would copy jassub's worker verbatim, keeping its bare imports (abslink, …) that a
// browser worker cannot resolve; ?worker&url bundles the worker with its pthread companion.
import jassubWorkerUrl from "jassub/dist/worker/worker.js?worker&url";
import jassubWasmUrl from "jassub/dist/wasm/jassub-worker.wasm?url";
import jassubModernWasmUrl from "jassub/dist/wasm/jassub-worker-modern.wasm?url";
import type { CaptionTrack, VideoTrack } from "@/models/media-tracks";
import {
	CustomMediaManifestSchema,
	type CustomMediaManifest,
} from "ott-common/models/zod-schemas.js";
import { getSubtitleFormatFromUrl, type SubtitleFormat } from "ott-common/subtitles.js";
import {
	createMediaRecovery,
	nativeMediaError,
	probeSourceReachability,
} from "@/util/media-recovery";
import { createMediaLoadingState, type MediaLoadingState } from "@/util/media-loading-state";
import { ToastStyle } from "@/models/toast";
import toast from "@/util/toast";
import { i18n } from "@/i18n";
import { rememberCors, rememberedCors } from "@/util/cors-memory";
import { referrerPolicyValue } from "@/util/media-access";
import type {
	MediaPlayerError,
	MediaPlayerWithAudioBoost,
	MediaPlayerWithCaptions,
	MediaPlayerWithPlaybackRate,
	MediaPlayerWithQuality,
} from "../composables";
import { useCaptions, useMediaAudioBoost, useQualities } from "../composables";
import UpscaleLayer from "./UpscaleLayer.vue";
import DanmakuLayer from "./DanmakuLayer.vue";
import { useStore } from "@/store";
import { enhancementLayerMode, type AudioEqPreset } from "@/stores/settings";

interface Props {
	service: string;
	videoUrl: string;
	videoMime: string;
	thumbnail?: string;
	subtitleUrl?: string;
	/** Probed requirement of the source's host, when it differs from the browser default. */
	referrerPolicy?: string;
}

interface SubtitleSource {
	url: string;
	format: SubtitleFormat;
	name?: string;
	srclang?: string;
	default?: boolean;
}

const props = defineProps<Props>();
const { videoUrl, videoMime, thumbnail, subtitleUrl, referrerPolicy } = toRefs(props);
const videoElem = ref<HTMLVideoElement | undefined>();
const subtitleCanvasHost = ref<HTMLDivElement | undefined>();
const assVisible = ref(false);
const captions = useCaptions();
const audioBoost = useMediaAudioBoost(videoElem);
const qualities = useQualities();
const store = useStore();
// Sources without CORS headers can only play without crossorigin, which also disables
// canvas/WebGL enhancement because the texture would taint the canvas.
const crossoriginEnabled = ref(true);
/**
 * A source that cannot be read cross-origin must never be tried that way twice: the server
 * records the verdict when a link is added, and a live fallback records it for the session.
 */
const sourceAllowsCors = computed(() => {
	const remembered = rememberedCors(videoUrl.value);
	if (remembered !== undefined) {
		return remembered;
	}
	return store.state.room.currentSource?.cors !== false;
});
const upscaleMode = computed(() =>
	crossoriginEnabled.value ? store.state.settings.upscaleMode : "off",
);
const fillMode = computed(() => store.state.settings.videoFillMode);
const mirror = computed(() => store.state.settings.videoMirror);
/**
 * A media element routed through Web Audio can never be un-routed, so a source that has
 * to load without CORS needs a fresh element: bumping this remounts the <video>.
 */
const surfaceGeneration = ref(0);

function setAudioEq(preset: AudioEqPreset): void {
	audioBoost.setEq(preset);
}
const manifest = ref<CustomMediaManifest | null>(null);
let activeMediaUrl = "";
let sourceGeneration = 0;
let manifestRequest: AbortController | undefined;
let corsFallbackPending = false;
let sourceProbe: Promise<boolean> | undefined;

// kept outside subtitleSources's computed() factory to dodge a noVueRefAsOperand false
// positive: biome's nursery rule flags property access on nested callback params when the
// callback lives directly inside a computed(), mistaking plain manifest data for a ref
function textTracksToSubtitleSources(
	tracks: NonNullable<CustomMediaManifest["textTracks"]>,
): SubtitleSource[] {
	return tracks.map(track => ({
		url: track.url,
		format: track.contentType === "text/x-ssa" ? "ass" : "vtt",
		name: track.name,
		srclang: track.srclang,
		default: track.default,
	}));
}

function isVttSource(track: SubtitleSource): boolean {
	return track.format === "vtt";
}

// unifies manifest text tracks and the single legacy subtitleUrl prop into one indexable list,
// used to render native <track> elements (vtt) and to drive the jassub renderer (ass)
const subtitleSources = computed<SubtitleSource[]>(() => {
	if (videoMime.value === "application/json") {
		return textTracksToSubtitleSources(manifest.value?.textTracks ?? []);
	}
	if (!subtitleUrl.value) {
		return [];
	}
	return [
		{
			url: subtitleUrl.value,
			format: getSubtitleFormatFromUrl(subtitleUrl.value) ?? "vtt",
			default: true,
		},
	];
});
const vttSources = computed(() => subtitleSources.value.filter(isVttSource));

// maps an index into subtitleSources to the corresponding index in videoElem.textTracks,
// counting only the vtt entries that precede it (ass tracks don't get a native <track>)
function nativeTrackIndex(sourceIndex: number): number {
	let count = 0;
	for (let i = 0; i < sourceIndex; i++) {
		if (subtitleSources.value[i]?.format === "vtt") {
			count++;
		}
	}
	return count;
}

// created lazily on first ASS use, then kept alive for the component's lifetime: its canvas
// can only be transferred to the worker once, so VTT<->ASS toggles and ASS->ASS track changes
// reuse this instance instead of tearing it down and rebuilding a new worker
let jassubInstance: JASSUB | null = null;

// A jassub instance owns its canvas for good: transferring a canvas to the worker cannot be
// undone, and destroy() removes it. Each instance therefore gets a freshly created canvas,
// which is what makes remountSurface (the CORS fallback rebuilds the <video>) safe.
function createSubtitleCanvas(): HTMLCanvasElement | undefined {
	const host = subtitleCanvasHost.value;
	if (!host) {
		return undefined;
	}
	const canvas = document.createElement("canvas");
	canvas.className = "jassub-canvas";
	host.replaceChildren(canvas);
	return canvas;
}

function destroyJassub() {
	const inst = jassubInstance;
	jassubInstance = null;
	assVisible.value = false;
	subtitleCanvasHost.value?.replaceChildren();
	if (inst) {
		inst.destroy().catch(e => {
			console.error("DirectPlayer: error destroying jassub:", e);
		});
	}
}

// every track change is chained onto this promise, so switches always run in the order they
// were requested and the last one wins, instead of racing on the async jassub calls below
let trackQueue: Promise<void> = Promise.resolve();

function applyActiveTrack(idx: number, enabled: boolean): Promise<void> {
	// caught here (not left to the caller) so a failed switch doesn't reject the shared chain
	// and skip every switch queued after it
	trackQueue = trackQueue
		.then(() => doApplyTrack(idx, enabled))
		.catch(e => {
			console.error("DirectPlayer: failed to apply subtitle track:", e);
		});
	return trackQueue;
}

async function doApplyTrack(idx: number, enabled: boolean) {
	const source = idx >= 0 ? subtitleSources.value[idx] : undefined;

	if (videoElem.value) {
		for (let i = 0; i < videoElem.value.textTracks.length; i++) {
			videoElem.value.textTracks[i].mode = "hidden";
		}
	}

	if (source?.format === "ass" && enabled) {
		if (!videoElem.value) {
			return;
		}
		if (!jassubInstance) {
			const canvas = createSubtitleCanvas();
			if (!canvas) {
				return;
			}
			jassubInstance = new JASSUB({
				video: videoElem.value,
				canvas,
				subUrl: source.url,
				workerUrl: jassubWorkerUrl,
				wasmUrl: jassubWasmUrl,
				modernWasmUrl: jassubModernWasmUrl,
				// fall back to remote font queries so styles using fonts not installed
				// locally (e.g. CJK/decorative fonts) still render instead of falling
				// back to the default font
				queryFonts: "localandremote",
			});
			await jassubInstance.ready;
		} else {
			await jassubInstance.ready;
			await jassubInstance.renderer.setTrackByUrl(source.url);
		}
		assVisible.value = true;
		return;
	}

	assVisible.value = false;
	if (jassubInstance) {
		await jassubInstance.ready;
		jassubInstance.renderer.freeTrack();
	}
	if (source?.format === "vtt" && enabled && videoElem.value) {
		const track = videoElem.value.textTracks[nativeTrackIndex(idx)];
		if (track) {
			track.mode = "showing";
		}
	}
}

const emit = defineEmits<{
	"apiready": [];
	"ready": [];
	"playing": [];
	"paused": [];
	"buffering": [];
	"error": [error: MediaPlayerError];
	"end": [];
	"buffer-progress": [progress: number];
	"buffer-spans": [spans: TimeRanges];
	"loading-state": [state: MediaLoadingState];
}>();

const loadingState = createMediaLoadingState({
	media: () => videoElem.value,
	onChange: state => emit("loading-state", state),
	isAudioOnly: () => {
		const contentType =
			manifest.value?.sources.find(source => source.url === activeMediaUrl)?.contentType ??
			videoMime.value;
		return contentType.startsWith("audio/");
	},
});

const recovery = createMediaRecovery({
	media: () => videoElem.value,
	restart: async () => {
		loadingState.reset();
		if (activeMediaUrl && videoElem.value) {
			videoElem.value.src = activeMediaUrl;
			videoElem.value.load();
		} else {
			await resolveVideoSource(sourceGeneration);
		}
	},
	onRecovering: () => {
		loadingState.reset();
		emit("buffering");
	},
	onStallSkip: seconds => {
		toast.add({
			style: ToastStyle.Neutral,
			content: i18n.global.t("player.recovery.skipped", { seconds }),
			duration: 6000,
		});
	},
	onError: error => {
		loadingState.stop();
		manifestRequest?.abort();
		emit("error", error);
	},
});

function play(userInitiated = false) {
	return recovery.play(userInitiated);
}

function pause() {
	recovery.pause();
}

function setVolume(volume: number) {
	if (!videoElem.value) {
		console.error("player not ready");
		return;
	}
	videoElem.value.volume = volume / 100;
}

function getPosition() {
	return recovery.getPosition();
}

function setPosition(position: number) {
	recovery.setPosition(position);
}

function isCaptionsSupported(): boolean {
	return true;
}

function setCaptionsEnabled(enabled: boolean): void {
	if (!videoElem.value || captions.currentTrack.value === null) {
		return;
	}
	if (subtitleSources.value.length === 0) {
		return;
	}
	let idx = captions.currentTrack.value;
	if (idx === -1) {
		if (!enabled) {
			return;
		}
		idx = 0;
		captions.currentTrack.value = 0;
	}
	if (idx >= subtitleSources.value.length) {
		console.warn("DirectPlayer: invalid captions track index:", idx);
		return;
	}
	applyActiveTrack(idx, enabled);
}

function isCaptionsEnabled(): boolean {
	if (!videoElem.value) {
		return false;
	}
	if (assVisible.value) {
		return true;
	}
	return Array.from(videoElem.value.textTracks).find(t => t.mode === "showing") !== undefined;
}

function getCaptionsTracks(): CaptionTrack[] {
	return subtitleSources.value.map(track => ({
		kind: "subtitles",
		label: track.name,
		srclang: track.srclang,
		default: track.default,
	}));
}

function setCaptionsTrack(track: number): void {
	if (!videoElem.value) {
		console.error("player not ready");
		return;
	}
	console.log("DirectPlayer: setCaptionsTrack:", track);
	captions.currentTrack.value = track;
	applyActiveTrack(track, true);
}

function isQualitySupported(): boolean {
	return manifest.value !== null && manifest.value.sources.length > 1;
}

function getVideoTracks(): VideoTrack[] {
	if (!manifest.value) {
		return [];
	}
	return manifest.value.sources.map(s => ({
		label: s.quality,
		width: 0,
		height: s.quality,
	}));
}

function setVideoTrack(idx: number): void {
	if (!manifest.value || !videoElem.value) {
		return;
	}
	const source = manifest.value.sources[idx];
	if (!source || source.url === activeMediaUrl) {
		return;
	}
	activeMediaUrl = source.url;
	recovery.retry();
	qualities.currentVideoTrack.value = idx;
}

function isAutoQualitySupported(): boolean {
	return false;
}

function getCurrentActiveQuality(): number | null {
	if (!videoElem.value || !manifest.value) {
		return null;
	}
	return manifest.value.sources.findIndex(s => s.url === activeMediaUrl);
}

function getAvailablePlaybackRates(): number[] {
	return [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2];
}

function getPlaybackRate(): number {
	if (!videoElem.value) {
		console.error("player not ready");
		return 1;
	}
	return videoElem.value.playbackRate;
}

async function setPlaybackRate(rate: number): Promise<void> {
	recovery.setPlaybackRate(rate);
}

function setAudioBoost(boost: number): void {
	audioBoost.setBoost(boost);
}

/** Replaces the video element and waits for the new one to be bound before it is used. */
async function remountSurface() {
	// The running jassub instance is bound to the old element; a fresh canvas is created when
	// the next ASS track is applied.
	destroyJassub();
	const previous = videoElem.value;
	if (previous) {
		// The old element leaves the DOM but its media would keep decoding headlessly until
		// garbage collection; tear the load down the same way unmount does.
		previous.pause();
		previous.removeAttribute("src");
		previous.load();
	}
	surfaceGeneration.value++;
	await nextTick();
	if (videoElem.value) {
		videoElem.value.referrerPolicy = referrerPolicyValue(referrerPolicy.value) ?? "";
	}
	// Every listener of the loading tracker lives on the element, and the tracker is
	// attached once; without this the new element would never report any state again.
	loadingState.reattach();
}

async function loadVideoSource() {
	if (!videoElem.value) {
		return;
	}
	// The Web Audio graph that was built for an earlier, CORS-readable source cannot be
	// removed from this element, and a source that needs the no-CORS path would play
	// silently through it. A fresh element starts clean.
	if (!sourceAllowsCors.value && audioBoost.hasActiveGraph()) {
		await remountSurface();
	}
	if (!videoElem.value) {
		return;
	}
	sourceGeneration++;
	loadingState.reset();
	manifestRequest?.abort();
	recovery.reset();
	crossoriginEnabled.value = sourceAllowsCors.value;
	corsFallbackPending = false;
	sourceProbe = undefined;
	activeMediaUrl = "";
	videoElem.value.pause();
	videoElem.value.removeAttribute("src");
	// The source's host may refuse a Referer from this page; the probe decided which.
	videoElem.value.referrerPolicy = referrerPolicyValue(referrerPolicy.value) ?? "";
	videoElem.value.load();
	// Fix for captions from previous video still showing after source change; queued so it
	// runs after any switch already in flight, and blocks the new default track below from
	// jumping ahead of it
	void applyActiveTrack(-1, false);
	audioBoost.resetFailedSetup();
	manifest.value = null;
	videoElem.value.poster = thumbnail.value ?? "";
	emit("buffering");
	// The control API can accept play/pause/seek while a manifest is still loading.
	emit("apiready");
	await resolveVideoSource(sourceGeneration);
}

async function resolveVideoSource(generation: number) {
	if (!videoElem.value || generation !== sourceGeneration) {
		return;
	}
	if (videoMime.value === "application/json") {
		manifestRequest?.abort();
		const request = new AbortController();
		manifestRequest = request;
		try {
			const response = await fetch(videoUrl.value, {
				signal: request.signal,
				referrerPolicy: referrerPolicyValue(referrerPolicy.value),
			});
			if (generation !== sourceGeneration || request.signal.aborted) {
				return;
			}
			if (!response.ok) {
				recovery.handleError({
					type: "network",
					retryable: ![400, 401, 403, 404, 410].includes(response.status),
				});
				return;
			}
			const data: unknown = await response.json();
			if (generation !== sourceGeneration || request.signal.aborted) {
				return;
			}
			const parsed = CustomMediaManifestSchema.safeParse(data);
			if (!parsed.success || parsed.data.sources.length === 0) {
				recovery.handleError({ type: "unsupported", retryable: false });
				return;
			}
			manifest.value = parsed.data;
		} catch (e) {
			if (generation === sourceGeneration && !request.signal.aborted) {
				console.warn("DirectPlayer: failed to fetch manifest:", e);
				recovery.handleError({
					type: e instanceof SyntaxError ? "unsupported" : "network",
				});
			}
			return;
		}
		activeMediaUrl = manifest.value.sources[0].url;

		qualities.videoTracks.value = getVideoTracks();
		qualities.currentVideoTrack.value = 0;
	} else {
		activeMediaUrl = videoUrl.value;

		qualities.videoTracks.value = [];
		qualities.currentVideoTrack.value = -1;
	}

	if (subtitleSources.value.length > 0) {
		// Wait for all vtt <track> elements to be inserted
		await nextTick();
	}
	if (generation !== sourceGeneration) {
		return;
	}
	captions.captionsTracks.value = getCaptionsTracks();
	const defaultTrackIdx = subtitleSources.value.findIndex(t => t.default);
	captions.currentTrack.value = defaultTrackIdx;
	captions.isCaptionsEnabled.value = defaultTrackIdx !== -1;
	if (defaultTrackIdx !== -1) {
		await applyActiveTrack(defaultTrackIdx, true);
	}

	if (!videoElem.value || generation !== sourceGeneration) {
		return;
	}
	videoElem.value.src = activeMediaUrl;
	videoElem.value.load();
	// Refresh capabilities now that a custom manifest's quality and caption tracks are known.
	emit("apiready");
}

function onCanPlay() {
	if (recovery.canPlay()) {
		if (corsFallbackPending) {
			// Only now is it true that dropping crossorigin is what made playback work.
			corsFallbackPending = false;
			toast.add({
				style: ToastStyle.Neutral,
				content: i18n.global.t("player.cors-fallback"),
				duration: 8000,
			});
		} else if (crossoriginEnabled.value && activeMediaUrl) {
			// It played with crossOrigin, so this host allows it.
			rememberCors(activeMediaUrl, true);
		}
		emit("ready");
	}
}

function onPlaying() {
	if (
		recovery.isFailed() ||
		((recovery.isRecovering() || recovery.isSeeking()) && !recovery.canPlay())
	) {
		return;
	}
	emit("playing");
}

function onPaused() {
	if (!recovery.isRecovering() && !recovery.isFailed()) {
		emit("paused");
	}
}

function onBuffering() {
	if (!recovery.isFailed()) {
		emit("buffering");
	}
}

function onStalled() {
	// stalled only describes download activity; playback may still have plenty of buffer.
	if (videoElem.value && !videoElem.value.paused && videoElem.value.readyState < 3) {
		onBuffering();
	}
}

function onProgress() {
	if (recovery.isRecovering() || recovery.isSeeking()) {
		onCanPlay();
	}
	if (videoElem.value) {
		const buffered = videoElem.value.buffered;
		emit("buffer-spans", buffered);
		const duration = videoElem.value.duration;
		let bufferedTotal = 0;
		for (let i = 0; i < buffered.length; i++) {
			bufferedTotal += buffered.end(i) - buffered.start(i);
		}
		const bufferedPercentage = duration > 0 ? bufferedTotal / duration : 0;
		emit("buffer-progress", bufferedPercentage);
	}
}

function onEnd() {
	emit("end");
}

async function onError() {
	const error = nativeMediaError(videoElem.value?.error ?? null);
	if (!error) {
		return;
	}
	if (error.type === "unsupported" && crossoriginEnabled.value) {
		// The host may simply not send CORS headers. Retrying without crossorigin trades
		// enhancement and cross-origin subtitles for playback instead of failing.
		console.warn("DirectPlayer: retrying without crossorigin:", videoElem.value?.error);
		crossoriginEnabled.value = false;
		// Change the attribute before load(), not after the next Vue patch.
		videoElem.value?.removeAttribute("crossorigin");
		corsFallbackPending = true;
		if (activeMediaUrl) {
			rememberCors(activeMediaUrl, false);
		}
		sourceProbe ??= probeSourceReachability(activeMediaUrl);
		if (audioBoost.hasActiveGraph()) {
			// The element is permanently routed through Web Audio; the no-CORS retry would
			// come out silent, and the graph cannot be detached from this element.
			await remountSurface();
		}
		recovery.retry();
		return;
	}
	console.warn("DirectPlayer: media error:", videoElem.value?.error);
	if (error.type === "unsupported") {
		// Code 4 cannot tell an unplayable format from an unreachable host, so ask the network.
		if (!sourceProbe) {
			sourceProbe = probeSourceReachability(activeMediaUrl);
		}
		void sourceProbe.then(unreachable =>
			recovery.handleError({ ...error, sourceUnreachable: unreachable }),
		);
		return;
	}
	recovery.handleError(error);
}

onMounted(() => {
	loadingState.attach();
	loadVideoSource();
});

// A changed policy means the requests must be built differently, which only a reload does.
watch([videoUrl, videoMime, subtitleUrl, referrerPolicy], () => {
	loadVideoSource();
});

onBeforeUnmount(() => {
	destroyJassub();
	loadingState.dispose();
	sourceGeneration++;
	manifestRequest?.abort();
	recovery.dispose();
	videoElem.value?.pause();
	videoElem.value?.removeAttribute("src");
	videoElem.value?.load();
});

defineExpose({
	supportsRateBend: true,
	getVideoElement: () => videoElem.value,
	play,
	pause,
	setVolume,
	getPosition,
	setPosition,
	isCaptionsSupported,
	setCaptionsEnabled,
	isCaptionsEnabled,
	getCaptionsTracks,
	setCaptionsTrack,
	isQualitySupported,
	getVideoTracks,
	setVideoTrack,
	isAutoQualitySupported,
	getCurrentActiveQuality,
	getAvailablePlaybackRates,
	getPlaybackRate,
	setPlaybackRate,
	setAudioBoost,
	setAudioEq,
	retry: recovery.retry,
	isSeeking: recovery.isSeeking,
	isRecovering: recovery.isRecovering,
} satisfies MediaPlayerWithCaptions & MediaPlayerWithPlaybackRate & MediaPlayerWithAudioBoost & MediaPlayerWithQuality);
</script>

<!-- biome-ignore lint/nursery/useScopedStyles: biome migration -->
<style lang="scss">
.direct {
	position: relative;
	display: flex;
	align-items: center;
	justify-content: center;
	max-width: 100%;
	max-height: 100%;
	width: 100%;
	height: 100%;
}

.direct video {
	display: block;
	width: 100%;
	height: 100%;
	object-fit: contain;
	object-position: 50% 50%;
}

.direct .jassub-canvas-host {
	position: absolute;
	inset: 0;
	pointer-events: none;
}

.direct .jassub-canvas {
	position: absolute;
	pointer-events: none;
}

.direct.video-fill-cover video,
.direct.video-fill-cover .upscale-canvas {
	object-fit: cover;
}

.direct.video-mirror video,
.direct.video-mirror .upscale-canvas {
	transform: scaleX(-1);
}
</style>
