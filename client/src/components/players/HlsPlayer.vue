<template>
	<div class="hls" :class="{ 'video-fill-cover': fillMode === 'cover', 'video-mirror': mirror }">
		<video
			ref="videoElem"
			playsinline
			webkit-playsinline
			preload="auto"
			crossorigin="anonymous"
			:poster="thumbnail || ''"
			@loadedmetadata="recovery.restoreMetadata"
			@loadeddata="onReady"
			@canplay="onReady"
			@seeked="onReady"
			@playing="onPlaying"
			@pause="onPaused"
			@waiting="onBuffering"
			@stalled="onStalled"
			@loadstart="onBuffering"
			@progress="onProgress"
			@durationchange="onDurationChange"
			@ended="onEnd"
			@error="onMediaError"
		></video>
		<UpscaleLayer
			v-if="upscaleMode !== 'off'"
			:video="videoElem"
			:mode="enhancementLayerMode(upscaleMode)"
		/>
		<DanmakuLayer v-if="videoElem" :video="videoElem" :video-url="videoUrl" />
	</div>
</template>

<script lang="ts" setup>
import Hls from "hls.js";
import { computed, onBeforeUnmount, onMounted, ref, toRefs, watch } from "vue";
import type { CaptionTrack, VideoTrack } from "@/models/media-tracks";
import { useStore } from "@/store";
import { enhancementLayerMode, type AudioEqPreset } from "@/stores/settings";
import UpscaleLayer from "./UpscaleLayer.vue";
import DanmakuLayer from "./DanmakuLayer.vue";
import { createMediaRecovery, nativeMediaError } from "@/util/media-recovery";
import {
	recallHlsBandwidthEstimate,
	rememberHlsBandwidthEstimate,
} from "@/util/hls-bandwidth-memory";
import { hlsLoaderOptions } from "@/util/hls-media-loader";
import { referrerPolicyValue } from "@/util/media-access";
import { ToastStyle } from "@/models/toast";
import toast from "@/util/toast";
import { i18n } from "@/i18n";
import { calculateCurrentPosition } from "ott-common/timestamp";
import { createMediaLoadingState, type MediaLoadingState } from "@/util/media-loading-state";
import { visibleBufferSeconds } from "@/util/media-buffer";
import { hlsBufferBudget } from "@/util/hls-buffer";
import { isUsableDuration } from "@/util/video-length";
import type {
	MediaPlayerWithAudioBoost,
	MediaPlayerWithCaptions,
	MediaPlayerWithPlaybackRate,
	MediaPlayerWithQuality,
} from "../composables";
import { useCaptions, useMediaAudioBoost, useQualities } from "../composables";
import type { MediaPlayerError } from "../composables/media-player";

interface Props {
	videoUrl: string;
	thumbnail?: string;
	/** Probed requirement of the source's host, when it differs from the browser default. */
	referrerPolicy?: string;
}

/** Ceiling for buffered media. A room stall pauses everyone, so depth is worth the memory. */
const MAX_BUFFER_BYTES = 256 * 1024 * 1024;
/** Devices below this much RAM keep a smaller byte budget. */
const LOW_MEMORY_DEVICE_GB = 4;
const LOW_MEMORY_BUFFER_BYTES = 96 * 1024 * 1024;
/** Rewinding is part of watching together; hls.js' 30s default is thinner than a room rewind. */
const BACK_BUFFER_SECONDS = 180;

const props = defineProps<Props>();
const { videoUrl, thumbnail, referrerPolicy } = toRefs(props);
const videoElem = ref<HTMLVideoElement | undefined>();
const captions = useCaptions();
const qualities = useQualities();
const audioBoost = useMediaAudioBoost(videoElem);
const store = useStore();
const upscaleMode = computed(() => store.state.settings.upscaleMode);
const fillMode = computed(() => store.state.settings.videoFillMode);
const mirror = computed(() => store.state.settings.videoMirror);
let hls: Hls | undefined;
let audioOnly = false;

const emit = defineEmits<{
	"apiready": [];
	"ready": [];
	"playing": [];
	"paused": [];
	"buffering": [];
	"error": [error: MediaPlayerError];
	"end": [];
	"duration": [duration: number];
	"buffer-progress": [progress: number];
	"buffer-spans": [spans: TimeRanges];
	"loading-state": [state: MediaLoadingState];
}>();

const loadingState = createMediaLoadingState({
	media: () => videoElem.value,
	onChange: state => emit("loading-state", state),
	isAudioOnly: () => audioOnly,
});

const recovery = createMediaRecovery({
	media: () => videoElem.value,
	restart: (error, manual) => {
		loadingState.reset();
		if (manual) {
			attachSource();
		} else if (hls) {
			if (error.type === "decode" || videoElem.value?.error) {
				hls.recoverMediaError();
			} else {
				// startLoad alone cannot recover a manifest which never loaded successfully.
				if (hls.levels.length === 0) {
					hls.loadSource(videoUrl.value);
				}
				hls.startLoad(recovery.getPosition());
			}
		} else {
			videoElem.value?.load();
		}
	},
	onRecovering: () => {
		loadingState.reset();
		emit("buffering");
	},
	// hls.js watches for stalls and gaps and retries loads on its own; rebuilding the
	// MediaSource here would re-fetch the same region under the same conditions and tear the
	// audio pipeline down with it (see stallFirstResponse). The Safari native fallback below
	// has no hls.js behind it, so it keeps the reload.
	stallFirstResponse: () => (hls ? "wait" : "reload"),
	onStallSkip: seconds => {
		toast.add({
			style: ToastStyle.Neutral,
			content: i18n.global.t("player.recovery.skipped", { seconds }),
			duration: 6000,
		});
	},
	onError: error => {
		loadingState.stop();
		hls?.stopLoad();
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
	return !!hls;
}

function setCaptionsEnabled(enabled: boolean): void {
	if (!hls) {
		return;
	}
	if (enabled) {
		hls.subtitleTrack = captions.currentTrack.value || 0;
	} else {
		hls.subtitleTrack = -1;
	}
}

function isCaptionsEnabled(): boolean {
	if (!hls) {
		return false;
	}
	return hls.subtitleTrack !== -1;
}

function getCaptionsTracks(): CaptionTrack[] {
	console.log("HlsPlayer: getCaptionsTracks:", hls?.subtitleTracks);
	if (!hls) {
		console.error("player not ready");
		return [];
	}
	if (!hls.subtitleTracks || hls.subtitleTracks.length === 0) {
		console.log("HlsPlayer: no captions tracks available");
		return [];
	}
	const tracks: CaptionTrack[] = hls.subtitleTracks.map(track => ({
		// hls.js should return either `SUBTITLES` or `CLOSED-CAPTIONS`
		kind: track.type === "SUBTITLES" ? "subtitles" : "captions",
		label: track.name || undefined,
		srclang: track.lang || undefined,
		default: track.default,
	}));
	return tracks;
}

function setCaptionsTrack(track: number): void {
	if (!hls) {
		console.error("HlsPlayer: player not ready");
		return;
	}
	console.log("HlsPlayer: setCaptionsTrack:", track);
	hls.subtitleTrack = track;
}

function isQualitySupported(): boolean {
	return !!hls;
}

function getVideoTracks(): VideoTrack[] {
	if (!hls || !hls.levels) {
		console.error("player not ready");
		return [];
	}
	console.log("HlsPlayer: getVideoTracks:", hls.levels);
	if (hls.levels.length === 1) {
		console.log("HlsPlayer: no other video tracks available");
		if (hls.levels[0].height === 0) {
			// if the only level height is 0, then don't return any quality levels
			return [];
		}
	}
	return hls.levels.map(level => ({
		width: level.width,
		height: level.height,
	}));
}

function setVideoTrack(track: number): void {
	if (!hls) {
		console.error("player not ready");
		return;
	}
	if (track >= hls.levels.length || track < -1) {
		console.error("HlsPlayer:  HLS.js video track not found:", track);
		return;
	}

	const isAutoEnabled = hls.autoLevelEnabled;
	const currentTrack = isAutoEnabled ? -1 : hls.currentLevel;
	if (track === currentTrack) {
		return;
	}

	// hls.currentLevel immediately switches to the specified quality level.
	// hls.loadLevel switches to the new quality level
	// hls.nextLevel switches to the new quality level and eventually flush already buffered next fragments.
	// To smoothly switch quality levels, let's use nextLevel.
	hls.nextLevel = track;
	console.log("HlsPlayer: setting HLS.js video track:", track);
}

function isAutoQualitySupported(): boolean {
	return !!hls;
}

function getCurrentActiveQuality(): number | null {
	if (!hls || !hls.levels || hls.levels.length === 0) {
		return null;
	}
	return hls.currentLevel;
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

function setAudioEq(preset: AudioEqPreset): void {
	audioBoost.setEq(preset);
}

function loadVideoSource() {
	loadingState.reset();
	audioOnly = false;
	recovery.reset();
	emit("buffering");
	attachSource();
}

function attachSource() {
	if (!videoElem.value) {
		return;
	}
	audioBoost.resetFailedSetup();
	audioOnly = false;

	const previous = hls;
	hls = undefined;
	if (previous) {
		// Keep what this session measured for the next one, before the engine is gone.
		rememberHlsBandwidthEstimate(previous.bandwidthEstimate);
	}
	previous?.destroy();
	videoElem.value.pause();
	videoElem.value.removeAttribute("src");
	// Element-level so it also covers the native HLS path on Safari, which bypasses hls.js
	// entirely; hls.js requests get the same policy from its own loader options below.
	videoElem.value.referrerPolicy = referrerPolicyValue(referrerPolicy.value) ?? "";
	videoElem.value.load();
	if (!Hls.isSupported()) {
		if (videoElem.value.canPlayType("application/vnd.apple.mpegurl")) {
			videoElem.value.src = videoUrl.value;
			videoElem.value.load();
		} else {
			recovery.handleError({ type: "unsupported", retryable: false });
		}
		emit("apiready");
		return;
	}

	const bufferSeconds = store.state.settings.hlsBufferSeconds;
	const rememberedBandwidth = recallHlsBandwidthEstimate();
	const bufferMaxBytes = isLowMemoryDevice() ? LOW_MEMORY_BUFFER_BYTES : MAX_BUFFER_BYTES;
	const initialBudget = hlsBufferBudget(
		bufferSeconds,
		bufferMaxBytes,
		rememberedBandwidth ?? 5_000_000,
		BACK_BUFFER_SECONDS,
	);
	const engine = new Hls({
		maxBufferLength: initialBudget.forwardSeconds,
		// The byte budget is converted to time above; keeping the absolute cap equal to the
		// target prevents hls.js' 8x size heuristic from growing far past the budget.
		maxMaxBufferLength: initialBudget.maxForwardSeconds,
		maxBufferSize: bufferMaxBytes,
		// Going back is part of watching together (re-seeks, undo); the helper also caps it
		// so the forward and backward windows together stay inside the byte budget.
		backBufferLength: initialBudget.backSeconds,
		// The room player is usually smaller than the source's top rendition; there is no
		// point fetching 4K into a small box. A manual quality pick can still exceed it.
		capLevelToPlayerSize: true,
		// Loading where playback will begin is what the room position calls for; hls.js would
		// otherwise fetch from zero and we would seek afterwards, costing an extra round trip
		// every time someone enters the room.
		autoStartLoad: false,
		// Start at the level the remembered estimate supports instead of the manifest's
		// first variant, and let ABR take over from the first fragment.
		...(rememberedBandwidth !== null
			? {
					abrEwmaDefaultEstimate: rememberedBandwidth,
					startLevel: -1,
					testBandwidth: false,
			  }
			: {}),
		// Empty for every ordinary source, which keeps hls.js on its default XHR loader.
		...hlsLoaderOptions(referrerPolicy.value),
	});
	hls = engine;
	applyVisibleBufferTarget();

	engine.on(Hls.Events.MANIFEST_PARSED, (_, data) => {
		if (hls !== engine) {
			return;
		}
		// Metadata/track availability is not proof that the video can play yet.
		audioOnly = data.audio === true && data.video === false;
		loadingState.refresh();
		qualities.videoTracks.value = getVideoTracks();
		qualities.currentVideoTrack.value = engine.autoLevelEnabled ? -1 : engine.currentLevel;
		captions.captionsTracks.value = getCaptionsTracks();
		applyBufferBudget(engine);
		emit("apiready");
	});

	engine.on(Hls.Events.BUFFER_CREATED, (_, { tracks }) => {
		if (hls !== engine) {
			return;
		}
		// Direct media playlists can omit CODECS. These buffers include all expected tracks,
		// whereas separate audio/video controllers can emit BUFFER_CODECS independently.
		audioOnly = !!tracks.audio && !tracks.video && !tracks.audiovideo;
		loadingState.refresh();
	});

	engine.on(Hls.Events.ERROR, (_, data) => {
		if (hls !== engine || !data.fatal) {
			return;
		}
		console.warn("HlsPlayer: fatal media error:", data.type, data.details);
		const type =
			data.type === Hls.ErrorTypes.NETWORK_ERROR
				? "network"
				: data.type === Hls.ErrorTypes.MEDIA_ERROR
				? "decode"
				: "unknown";
		recovery.handleError({
			type,
			// Retrying a missing or denied source cannot repair its URL or authorization.
			retryable: ![400, 401, 403, 404, 410].includes(data.response?.code ?? 0),
		});
	});

	engine.on(Hls.Events.INIT_PTS_FOUND, () => {
		if (hls !== engine) {
			return;
		}
		captions.captionsTracks.value = getCaptionsTracks();
		captions.isCaptionsEnabled.value = isCaptionsEnabled();
		captions.currentTrack.value = engine.subtitleTrack;

		qualities.videoTracks.value = getVideoTracks();
		qualities.currentVideoTrack.value = engine.autoLevelEnabled ? -1 : engine.currentLevel;
		qualities.currentActiveQuality.value = getCurrentActiveQuality();
	});

	engine.on(Hls.Events.LEVEL_SWITCHED, () => {
		if (hls === engine) {
			qualities.currentActiveQuality.value = getCurrentActiveQuality();
			rememberHlsBandwidthEstimate(engine.bandwidthEstimate);
			applyBufferBudget(engine);
		}
	});

	engine.loadSource(videoUrl.value);
	engine.attachMedia(videoElem.value);
	engine.startLoad(hlsStartPosition());
	emit("apiready");
}

/**
 * Where this client should begin loading: the room's current position when it is playing,
 * the saved position when it is paused, and the recovery snapshot as a last resort.
 */
function hlsStartPosition(): number {
	const room = store.state.room;
	if (room.isPlaying && room.playbackStartTime) {
		return Math.max(
			0,
			calculateCurrentPosition(
				room.playbackStartTime,
				Date.now(),
				room.playbackPosition,
				room.playbackSpeed,
			),
		);
	}
	return Math.max(0, room.playbackPosition || recovery.getPosition());
}

onMounted(() => {
	document.addEventListener("visibilitychange", onVisibilityChange);
	loadingState.attach();
	loadVideoSource();
});

function onReady() {
	if (recovery.canPlay()) {
		emit("ready");
	}
}
function onPlaying() {
	if (
		!recovery.isFailed() &&
		((!recovery.isRecovering() && !recovery.isSeeking()) || recovery.canPlay())
	) {
		emit("playing");
	}
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
	if (videoElem.value && !videoElem.value.paused && videoElem.value.readyState < 3) {
		onBuffering();
	}
}
function onMediaError() {
	// A decoder can fail after buffering has finished, without another hls.js append/error.
	// The recovery controller coalesces duplicate native and hls.js reports.
	const error = nativeMediaError(videoElem.value?.error ?? null);
	if (error) {
		recovery.handleError(error);
	}
}
function onProgress() {
	if (recovery.isRecovering() || recovery.isSeeking()) {
		onReady();
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

function onDurationChange() {
	const duration = videoElem.value?.duration;
	if (isUsableDuration(duration)) {
		emit("duration", duration);
	}
}

function onEnd() {
	emit("end");
}

/** `deviceMemory` is Chromium-only; an unknown value keeps the generous budget. */
function isLowMemoryDevice(): boolean {
	const memory = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
	return typeof memory === "number" && memory <= LOW_MEMORY_DEVICE_GB;
}

/** The active rendition, or the engine's own link estimate before a level is chosen. */
function currentHlsBitrate(engine: Hls): number {
	const index = engine.currentLevel >= 0 ? engine.currentLevel : engine.nextLevel;
	return engine.levels[index]?.bitrate ?? engine.bandwidthEstimate ?? 0;
}

/**
 * A hidden tab usually still plays audio, but nobody sees the picture; buffering the full
 * window there spends bandwidth and memory on frames that were never shown. The byte
 * budget is converted to time for the active bitrate, so a high-quality rendition cannot
 * turn the user's "300 s" preference into hundreds of megabytes.
 */
function applyBufferBudget(engine = hls) {
	if (!engine) {
		return;
	}
	const budget = hlsBufferBudget(
		visibleBufferSeconds(store.state.settings.hlsBufferSeconds, document.hidden),
		isLowMemoryDevice() ? LOW_MEMORY_BUFFER_BYTES : MAX_BUFFER_BYTES,
		currentHlsBitrate(engine),
		BACK_BUFFER_SECONDS,
	);
	engine.config.maxBufferLength = budget.forwardSeconds;
	engine.config.maxMaxBufferLength = budget.maxForwardSeconds;
	engine.config.backBufferLength = budget.backSeconds;
}

function applyVisibleBufferTarget() {
	applyBufferBudget();
}

function onVisibilityChange() {
	applyVisibleBufferTarget();
}

onBeforeUnmount(() => {
	document.removeEventListener("visibilitychange", onVisibilityChange);
	loadingState.dispose();
	recovery.dispose();
	const previous = hls;
	hls = undefined;
	if (previous) {
		rememberHlsBandwidthEstimate(previous.bandwidthEstimate);
	}
	previous?.destroy();
	videoElem.value?.pause();
	videoElem.value?.removeAttribute("src");
	videoElem.value?.load();
});

// A changed policy means the requests must be built differently, which only a reload does.
watch([videoUrl, referrerPolicy], () => {
	loadVideoSource();
});

watch(
	() => store.state.settings.hlsBufferSeconds,
	() => applyVisibleBufferTarget(),
);

defineExpose({
	supportsRateBend: true,
	getVideoElement: () => videoElem.value,
	isVideoEnhancementSupported: () => !!videoElem.value,
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
	/** hls.js' current throughput estimate; 0/undefined until the first fragment. */
	getBandwidthEstimate: () => hls?.bandwidthEstimate ?? null,
	getAvailablePlaybackRates,
	getPlaybackRate,
	setPlaybackRate,
	setAudioBoost,
	setAudioEq,
	retry: recovery.retry,
	isSeeking: recovery.isSeeking,
	isRecovering: recovery.isRecovering,
} satisfies MediaPlayerWithCaptions & MediaPlayerWithQuality & MediaPlayerWithPlaybackRate & MediaPlayerWithAudioBoost);
</script>

<!-- biome-ignore lint/nursery/useScopedStyles: biome migration -->
<style lang="scss">
.hls {
	position: relative;
	display: flex;
	align-items: center;
	justify-content: center;
	max-width: 100%;
	max-height: 100%;
	width: 100%;
	height: 100%;
}

.hls video {
	display: block;
	width: 100%;
	height: 100%;
	object-fit: contain;
	object-position: 50% 50%;
}

.hls.video-fill-cover video,
.hls.video-fill-cover .upscale-canvas {
	object-fit: cover;
}

.hls.video-mirror video,
.hls.video-mirror .upscale-canvas {
	transform: scaleX(-1);
}
</style>
