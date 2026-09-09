<template>
	<div class="dash">
		<video
			id="dashplayer"
			ref="videoElem"
			playsinline
			webkit-playsinline
			preload="auto"
			crossorigin="anonymous"
			:poster="thumbnail || ''"
			@loadedmetadata="applyPendingPosition"
			@canplay="onReady"
			@ready="onReady"
			@playing="onPlaying"
			@pause="onPaused"
			@waiting="onBuffering"
			@stalled="onStalled"
			@loadstart="onBuffering"
			@progress="onProgress"
			@error="onNativeError"
		></video>
	</div>
	<div id="dashplayer-ttml-rendering" ref="ttlmCaption"></div>
</template>

<script lang="ts" setup>
import { type ErrorEvent, MediaPlayer, type MediaPlayerClass } from "dashjs";
import { onBeforeUnmount, onMounted, ref, toRefs, watch } from "vue";
import type { CaptionTrack, VideoTrack } from "@/models/media-tracks";
import { createMediaLoadingState, type MediaLoadingState } from "@/util/media-loading-state";
import { nativeMediaError } from "@/util/media-recovery";
import type {
	MediaPlayerError,
	MediaPlayerWithAudioBoost,
	MediaPlayerWithCaptions,
	MediaPlayerWithPlaybackRate,
	MediaPlayerWithQuality,
} from "../composables";
import { useCaptions, useMediaAudioBoost, useQualities } from "../composables";

interface Props {
	videoUrl: string;
	thumbnail?: string;
}

const props = defineProps<Props>();
const { videoUrl, thumbnail } = toRefs(props);
const videoElem = ref<HTMLVideoElement>();
const ttlmCaption = ref<HTMLDivElement>();
const captions = useCaptions();
const qualities = useQualities();
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

function play() {
	const media = videoElem.value;
	if (!media) {
		console.error("video element not ready");
		return;
	}
	if (!media.currentSrc && !media.src && !media.srcObject) {
		// dash.js attaches MediaSource after reading the manifest. Room retries on ready.
		return;
	}
	return media.play();
}

function pause() {
	if (!videoElem.value) {
		console.error("video element not ready");
		return;
	}
	videoElem.value.pause();
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
	pendingPosition = position;
	applyPendingPosition();
}

function applyPendingPosition() {
	const media = videoElem.value;
	if (pendingPosition === null || !media || !streamReady || media.readyState < 1) {
		return;
	}
	try {
		media.currentTime = pendingPosition;
		pendingPosition = null;
	} catch {
		// Some MediaSource timelines become seekable only at canplay. Keep the latest request.
	}
}

function isSeeking() {
	return videoElem.value?.seeking ?? false;
}

function isRecovering() {
	return !streamReady || (videoElem.value?.readyState ?? 0) < 1 || pendingPosition !== null;
}

function retry() {
	const position = pendingPosition ?? videoElem.value?.currentTime;
	loadVideoSource(
		position !== undefined && Number.isFinite(position) && position >= 0 ? position : null,
	);
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

async function setPlaybackRate(rate: number): Promise<void> {
	if (!videoElem.value) {
		console.error("video element not ready");
		return;
	}
	videoElem.value.playbackRate = rate;
}

function setAudioBoost(boost: number): void {
	audioBoost.setBoost(boost);
}

function loadVideoSource(resumePosition: number | null = null) {
	console.log("DashPlayer: loading video source:", props.videoUrl);
	if (!videoElem.value) {
		console.error("video element not ready");
		return;
	}
	const generation = ++sourceGeneration;
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
		loadingState.stop();
		console.error("DashPlayer: dash.js error:", event);
		console.log("DashPlayer: dash.js error event type:", typeof event);
		const errorEvent: MediaPlayerError = {
			type: "unknown",
			message: JSON.stringify(event),
		};
		emit("error", errorEvent);
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
	applyPendingPosition();
	emit("ready");
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

function onNativeError() {
	const error = nativeMediaError(videoElem.value?.error ?? null);
	if (error) {
		loadingState.stop();
		emit("error", error);
	}
}

function onProgress() {
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
} satisfies MediaPlayerWithCaptions & MediaPlayerWithQuality & MediaPlayerWithPlaybackRate & MediaPlayerWithAudioBoost);
</script>

<!-- biome-ignore lint/nursery/useScopedStyles: biome migration -->
<style lang="scss">
.dash {
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
</style>
