<template>
	<div class="dash" :class="{ 'video-fill-cover': fillMode === 'cover', 'video-mirror': mirror }">
		<video
			id="dashplayer"
			ref="videoElem"
			playsinline
			webkit-playsinline
			preload="auto"
			crossorigin="anonymous"
			:poster="thumbnail || ''"
			@loadedmetadata="applyPendingPosition"
			@loadeddata="onReady"
			@canplay="onReady"
			@seeked="onReady"
			@ready="onReady"
			@playing="onPlaying"
			@pause="onPaused"
			@waiting="onBuffering"
			@stalled="onStalled"
			@loadstart="onBuffering"
			@progress="onProgress"
			@durationchange="onDurationChange"
			@ended="onEnd"
			@error="onNativeError"
		></video>
		<UpscaleLayer
			v-if="upscaleMode !== 'off'"
			:video="videoElem"
			:mode="enhancementLayerMode(upscaleMode)"
		/>
		<DanmakuLayer v-if="videoElem" :video="videoElem" :video-url="videoUrl" />
	</div>
	<div id="dashplayer-ttml-rendering" ref="ttlmCaption"></div>
</template>

<script lang="ts" setup>
import { type ErrorEvent, MediaPlayer, type MediaPlayerClass } from "dashjs";
import { computed, onBeforeUnmount, onMounted, ref, toRefs, watch } from "vue";
import type { CaptionTrack, VideoTrack } from "@/models/media-tracks";
import { createMediaLoadingState, type MediaLoadingState } from "@/util/media-loading-state";
import { isUsableDuration } from "@/util/video-length";
import { createMediaRecovery, nativeMediaError } from "@/util/media-recovery";
import { createMediaSeek } from "@/util/media-seek";
import { ToastStyle } from "@/models/toast";
import toast from "@/util/toast";
import { i18n } from "@/i18n";
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
	videoUrl: string;
	thumbnail?: string;
}

const props = defineProps<Props>();
const { videoUrl, thumbnail } = toRefs(props);
const videoElem = ref<HTMLVideoElement>();
const seek = createMediaSeek(() => videoElem.value);
const ttlmCaption = ref<HTMLDivElement>();
const captions = useCaptions();
const qualities = useQualities();
const store = useStore();
const upscaleMode = computed(() => store.state.settings.upscaleMode);
const fillMode = computed(() => store.state.settings.videoFillMode);
const mirror = computed(() => store.state.settings.videoMirror);
const dash = ref<MediaPlayerClass | undefined>(undefined);
const audioBoost = useMediaAudioBoost(videoElem);
let sourceGeneration = 0;
let audioOnly = false;
let streamReady = false;
let pendingPosition: number | null = null;

const emit = defineEmits<{
	"apiready": [];
	"ready": [];
	"playing": [];
	"paused": [];
	"buffering": [];
	"end": [];
	"duration": [duration: number];
	"error": [error: MediaPlayerError];
	"buffer-progress": [progress: number];
	"buffer-spans": [spans: TimeRanges];
	"loading-state": [state: MediaLoadingState];
}>();

const loadingState = createMediaLoadingState({
	media: () => videoElem.value,
	onChange: state => emit("loading-state", state),
	isAudioOnly: () => audioOnly,
});

/**
 * dash.js download/manifest error ids (DASH-IF error codes 25–29) are worth retrying; the
 * remaining error ids describe a stream or device problem a reload cannot repair.
 */
const DASH_RETRYABLE_ERROR_CODES = new Set([25, 26, 27, 28, 29]);

function describeDashError(event: ErrorEvent): MediaPlayerError {
	if (event.error === "download" || event.error === "manifestError") {
		const detail = event.error === "manifestError" ? event.event.message : undefined;
		return {
			type: "network",
			message:
				typeof detail === "string" && detail.trim() !== ""
					? detail
					: "dash.js could not download the media stream",
		};
	}
	if (event.error === "capability" || event.error === "mediasource") {
		// The browser cannot decode this container/codec; retrying cannot change that.
		return {
			type: "unsupported",
			message: "This device cannot decode the DASH stream",
			retryable: false,
		};
	}
	if (typeof event.error === "object" && event.error !== null) {
		const detail = event.error.message;
		return {
			type: DASH_RETRYABLE_ERROR_CODES.has(event.error.code) ? "network" : "unknown",
			message:
				typeof detail === "string" && detail.trim() !== ""
					? detail
					: "dash.js reported an error",
		};
	}
	return { type: "unknown", message: "dash.js reported an error" };
}

const recovery = createMediaRecovery({
	media: () => videoElem.value,
	restart: () => {
		loadingState.reset();
		if (!videoElem.value) {
			return;
		}
		// dash.js exposes no per-error recovery hook; rebuilding the player at the captured
		// position is the reliable path (MSE is recreated either way). Keep the recovery
		// snapshot: canPlay() restores it once the rebuilt stream is playable.
		loadVideoSource(recovery.getPosition(), false);
	},
	onRecovering: () => {
		loadingState.reset();
		emit("buffering");
	},
	// dash.js retries segment and manifest requests itself; a silent stall is usually
	// throughput, so the first trigger waits instead of re-fetching the same region.
	stallFirstResponse: () => "wait",
	onStallSkip: seconds => {
		toast.add({
			style: ToastStyle.Neutral,
			content: i18n.global.t("player.recovery.skipped", { seconds }),
			duration: 6000,
		});
	},
	onError: error => {
		loadingState.stop();
		dash.value?.destroy();
		dash.value = undefined;
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
		console.error("video element not ready");
		return;
	}
	videoElem.value.volume = volume / 100;
}

function getPosition() {
	if (!videoElem.value) {
		console.error("video element not ready");
		return 0;
	}
	return videoElem.value.currentTime;
}

function setPosition(position: number) {
	if (!Number.isFinite(position) || position < 0) {
		return;
	}
	// Keep the recovery snapshot in step: a recovery after this seek resumes here instead
	// of at the position captured by the last error.
	recovery.setPosition(position);
	pendingPosition = position;
	applyPendingPosition();
}

function applyPendingPosition() {
	const media = videoElem.value;
	if (pendingPosition === null || !media || !streamReady || media.readyState < 1) {
		return;
	}
	try {
		seek.seek(pendingPosition);
		pendingPosition = null;
	} catch {
		// Some MediaSource timelines become seekable only at canplay. Keep the latest request.
	}
}

function isSeeking() {
	return seek.pending() || (videoElem.value?.seeking ?? false);
}

function isRecovering() {
	return !streamReady || (videoElem.value?.readyState ?? 0) < 1 || pendingPosition !== null;
}

function retry() {
	recovery.retry();
}

function isCaptionsSupported(): boolean {
	return true;
}

function setCaptionsEnabled(enabled: boolean): void {
	if (!dash.value) {
		return;
	}
	if (enabled) {
		dash.value.setTextTrack(captions.currentTrack.value || 0);
	} else {
		dash.value.setTextTrack(-1);
	}
}

function isCaptionsEnabled(): boolean {
	if (!dash.value) {
		return false;
	}
	return dash.value.getCurrentTextTrackIndex() !== -1;
}

function getCaptionsTracks(): CaptionTrack[] {
	if (!dash.value) {
		return [];
	}

	const determineTrackKind = (
		roles: { value?: string }[] | null,
	): "subtitles" | "captions" | undefined => {
		if (!roles?.length || !roles[0]?.value) {
			return undefined;
		}

		const roleValue = roles[0].value.toLowerCase();
		if (["subtitle", "subtitles"].includes(roleValue)) {
			return "subtitles";
		}
		if (["caption", "captions"].includes(roleValue)) {
			return "captions";
		}
		return undefined;
	};

	const tracks: CaptionTrack[] = dash.value.getTracksFor("text").map(track => {
		const labelData = track.labels && track.labels.length > 0 ? track.labels[0] : null;
		return {
			kind: determineTrackKind(track.roles),
			label: labelData?.text,
			srclang: labelData?.lang || track.lang || undefined,
			default: false, // dash.js does not provide info about default track
		};
	});

	console.log("DashPlayer: available captions tracks:", tracks);
	return tracks;
}

function setCaptionsTrack(track: number): void {
	if (!dash.value) {
		console.error("dash.js player not ready");
		return;
	}
	console.log("DashPlayer: setting captions track to", track, "at index", track);
	dash.value.setTextTrack(track);
}

function isQualitySupported(): boolean {
	return true;
}

function getVideoTracks(): VideoTrack[] {
	if (!dash.value) {
		console.error("player not ready");
		return [];
	}
	const videoTracks = dash.value
		.getRepresentationsByType("video")
		.map(rep => ({ width: rep.width, height: rep.height }));
	console.log("DashPlayer: getVideoTracks:", videoTracks);
	if (videoTracks.length === 1) {
		console.log("DashPlayer: no other video tracks available");
		if (videoTracks[0].height === 0) {
			// if the only level height is 0, then don't return any quality levels
			return [];
		}
	}
	return videoTracks;
}

function setVideoTrack(track: number): void {
	if (!dash.value) {
		console.error("dash.js player not ready");
		return;
	}
	if (track >= getVideoTracks().length || track < -1) {
		console.error("DashPlayer: video track not found:", track);
		return;
	}

	const isAutoEnabled =
		dash.value.getSettings().streaming?.abr?.autoSwitchBitrate?.video || false;
	const currentRepresentation = dash.value.getCurrentRepresentationForType("video");
	const currentTrack = isAutoEnabled ? -1 : currentRepresentation?.index || 0;
	// Return early if the requested track is already active
	if (track === currentTrack) {
		return;
	}

	// setRepresentationForTypeByIndex could be overridden by ABR if autoSwitchBitrate is enabled
	const enableAutoSwitch = track === -1;
	dash.value.updateSettings({
		streaming: {
			abr: {
				autoSwitchBitrate: { audio: true, video: enableAutoSwitch },
			},
		},
	});
	if (enableAutoSwitch) {
		console.log("DashPlayer: setting video track to auto");
		return;
	}

	// With forceReplace set to true, the buffer is aggressively cleared, ensuring instant quality switching.
	// This can also cause rebuffering, but since we are watching "together", we set this to false to avoid playback interruptions.
	// With the help of `fastSwitchEnabled`, the quality up-switch should happen when the buffer is healthy enough.
	const forceSwitch = false;
	dash.value.setRepresentationForTypeByIndex("video", track, forceSwitch);
	console.log("DashPlayer: setting video track to index", track);
}

function isAutoQualitySupported(): boolean {
	return true;
}

function getCurrentActiveQuality(): number {
	if (!dash.value) {
		console.error("dash.js player not ready");
		return -1;
	}
	const representation = dash.value.getCurrentRepresentationForType("video");
	console.log("DashPlayer: current active quality:", representation);
	return representation?.index || 0;
}

function getAvailablePlaybackRates(): number[] {
	return [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2];
}

function getPlaybackRate(): number {
	if (!videoElem.value) {
		console.error("video element not ready");
		return 1;
	}
	return videoElem.value.playbackRate;
}

function setPlaybackRate(rate: number): Promise<void> {
	if (!videoElem.value) {
		console.error("video element not ready");
		return Promise.resolve();
	}
	recovery.setPlaybackRate(rate);
	return Promise.resolve();
}

function setAudioBoost(boost: number): void {
	audioBoost.setBoost(boost);
}

function setAudioEq(preset: AudioEqPreset): void {
	audioBoost.setEq(preset);
}

function loadVideoSource(resumePosition: number | null = null, resetRecovery = true) {
	if (resetRecovery) {
		// A new source starts from zero; a recovery reboot keeps its captured snapshot.
		recovery.reset();
	}
	console.log("DashPlayer: loading video source:", props.videoUrl);
	if (!videoElem.value) {
		console.error("video element not ready");
		return;
	}
	const generation = ++sourceGeneration;
	seek.reset();
	audioOnly = false;
	streamReady = false;
	pendingPosition = resumePosition;
	loadingState.reset();
	audioBoost.resetFailedSetup();

	dash.value?.destroy();
	dash.value = undefined;

	dash.value = MediaPlayer().create();
	dash.value.initialize(videoElem.value, props.videoUrl, false);
	if (ttlmCaption.value) {
		dash.value.attachTTMLRenderingDiv(ttlmCaption.value);
	}

	// When fastSwitchEnabled is set to true the next fragment is requested and appended
	// close to the current playback time.
	// Note: When ABR down-switch is detected, dash.js appends the lower quality
	// at the end of the buffer range to preserve the higher quality media for as long as possible.
	dash.value.updateSettings({
		streaming: {
			buffer: {
				fastSwitchEnabled: true,
				// The same buffer preference as HLS: dash.js' own defaults (18/30/60s) are
				// thinner than a room wants, and a stall here pauses everyone.
				bufferTimeDefault: store.state.settings.hlsBufferSeconds,
				bufferTimeAtTopQuality: store.state.settings.hlsBufferSeconds,
				bufferTimeAtTopQualityLongForm: store.state.settings.hlsBufferSeconds,
			},
			abr: {
				// A device that cannot decode the current rendition cleanly keeps dropping
				// frames; a lower one is better for everyone than a stuttering picture.
				rules: {
					droppedFramesRule: {
						active: true,
					},
				},
			},
		},
	});

	dash.value.on(MediaPlayer.events.MANIFEST_LOADED, () => {
		if (generation !== sourceGeneration) {
			return;
		}
		console.info("DashPlayer: dash.js manifest loaded");
		emit("ready");
	});
	dash.value.on(MediaPlayer.events.TEXT_TRACKS_ADDED, () => {
		if (generation !== sourceGeneration) {
			return;
		}
		captions.captionsTracks.value = getCaptionsTracks();
		captions.isCaptionsEnabled.value = isCaptionsEnabled();
		if (dash.value?.getCurrentTextTrackIndex() !== -1) {
			captions.currentTrack.value = dash.value?.getCurrentTextTrackIndex() || 0;
		} else {
			captions.currentTrack.value = null;
			console.log("DashPlayer: no text track selected");
		}
	});
	dash.value.on(MediaPlayer.events.ERROR, (event: ErrorEvent) => {
		if (generation !== sourceGeneration) {
			return;
		}
		if (event.error === "cc") {
			// A timed-text track that fails to load is not a playback failure.
			console.warn("DashPlayer: timed text error", event);
			return;
		}
		loadingState.stop();
		console.error("DashPlayer: dash.js error:", event);
		recovery.handleError(describeDashError(event));
	});
	// dash.value.on(MediaPlayer.events.PLAYBACK_ERROR, (event: unknown) => {
	// 	console.error("DashPlayer: dash.js playback error:", event);
	// 	emit("error");
	// });
	dash.value.on(MediaPlayer.events.STREAM_INITIALIZED, () => {
		if (generation !== sourceGeneration) {
			return;
		}
		console.info("DashPlayer: dash.js stream initialized");
		streamReady = true;
		applyPendingPosition();
		audioOnly =
			(dash.value?.getTracksFor("audio").length ?? 0) > 0 &&
			dash.value?.getTracksFor("video").length === 0;
		loadingState.refresh();
		qualities.videoTracks.value = getVideoTracks();
		const isAuto = dash.value?.getSettings()?.streaming?.abr?.autoSwitchBitrate?.video || false;
		const currentVideoTrack = dash.value?.getCurrentRepresentationForType("video")?.index || 0;
		qualities.currentVideoTrack.value = isAuto ? -1 : currentVideoTrack;
		console.log("DashPlayer: current video track:", qualities.currentVideoTrack.value);
		qualities.currentActiveQuality.value = getCurrentActiveQuality();
		console.log("DashPlayer: current active quality:", qualities.currentActiveQuality.value);
		emit("ready");
	});
	dash.value.on(MediaPlayer.events.BUFFER_EMPTY, () => {
		if (generation !== sourceGeneration) {
			return;
		}
		console.info("DashPlayer: dash.js buffer stalled");
		emit("buffering");
	});
	dash.value.on(MediaPlayer.events.BUFFER_LOADED, () => {
		if (generation !== sourceGeneration) {
			return;
		}
		applyPendingPosition();
		loadingState.refresh();
		console.info("DashPlayer: dash.js buffer loaded");
		emit("ready");
	});
	dash.value.on(MediaPlayer.events.QUALITY_CHANGE_RENDERED, () => {
		if (generation !== sourceGeneration) {
			return;
		}
		console.info("DashPlayer: dash.js quality change rendered");
		qualities.currentActiveQuality.value = getCurrentActiveQuality();
	});

	// Room applies the latest play/pause state and handles autoplay rejection through this API.
	emit("apiready");
}

onMounted(() => {
	if (!videoElem.value) {
		console.error("Dash player video element not found");
		return;
	}
	loadingState.attach();
	loadVideoSource();
});

function onReady() {
	// Side effect: marks the recovery phase ready and starts its stall watch once the
	// element can play (the room still applies play/pause through the ready handler).
	recovery.canPlay();
	applyPendingPosition();
	if (seek.ready()) {
		emit("ready");
	}
}

function onPlaying() {
	emit("playing");
}

function onPaused() {
	emit("paused");
}

function onBuffering() {
	emit("buffering");
}

function onStalled() {
	if (videoElem.value && !videoElem.value.paused && videoElem.value.readyState < 3) {
		onBuffering();
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

function onNativeError() {
	const error = nativeMediaError(videoElem.value?.error ?? null);
	if (error) {
		loadingState.stop();
		recovery.handleError(error);
	}
}

function onProgress() {
	if (isRecovering() || isSeeking()) {
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

onBeforeUnmount(() => {
	sourceGeneration++;
	streamReady = false;
	pendingPosition = null;
	recovery.dispose();
	loadingState.dispose();
	dash.value?.destroy();
	videoElem.value?.pause();
	videoElem.value?.removeAttribute("src");
	videoElem.value?.load();
});

watch(videoUrl, () => {
	console.log("DashPlayer: videoUrl changed");
	loadVideoSource();
});

defineExpose({
	supportsRateBend: true,
	getVideoElement: () => videoElem.value,
	retry,
	play,
	pause,
	setVolume,
	getPosition,
	setPosition,
	isSeeking,
	isRecovering,
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
} satisfies MediaPlayerWithCaptions & MediaPlayerWithQuality & MediaPlayerWithPlaybackRate & MediaPlayerWithAudioBoost);
</script>

<!-- biome-ignore lint/nursery/useScopedStyles: biome migration -->
<style lang="scss">
.dash {
	position: relative;
	display: flex;
	align-items: center;
	justify-content: center;
	max-width: 100%;
	max-height: 100%;
	width: 100%;
	height: 100%;
}

.dash video {
	display: block;
	width: 100%;
	height: 100%;
	object-fit: contain;
	object-position: 50% 50%;
}

.dash.video-fill-cover video,
.dash.video-fill-cover .upscale-canvas {
	object-fit: cover;
}

.dash.video-mirror video,
.dash.video-mirror .upscale-canvas {
	transform: scaleX(-1);
}
</style>
