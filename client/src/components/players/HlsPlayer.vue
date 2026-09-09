<template>
	<div class="hls">
		<video
			ref="videoElem"
			playsinline
			webkit-playsinline
			preload="auto"
			crossorigin="anonymous"
			:poster="thumbnail || ''"
			@loadedmetadata="recovery.restoreMetadata"
			@canplay="onReady"
			@playing="onPlaying"
			@pause="onPaused"
			@waiting="onBuffering"
			@stalled="onStalled"
			@loadstart="onBuffering"
			@progress="onProgress"
			@ended="onEnd"
			@error="onMediaError"
		></video>
	</div>
</template>

<script lang="ts" setup>
import Hls from "hls.js";
import { onBeforeUnmount, onMounted, ref, toRefs, watch } from "vue";
import type { CaptionTrack, VideoTrack } from "@/models/media-tracks";
import { useStore } from "@/store";
import { createMediaRecovery, nativeMediaError } from "@/util/media-recovery";
import { createMediaLoadingState, type MediaLoadingState } from "@/util/media-loading-state";
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
}

const props = defineProps<Props>();
const { videoUrl, thumbnail } = toRefs(props);
const videoElem = ref<HTMLVideoElement | undefined>();
const captions = useCaptions();
const qualities = useQualities();
const audioBoost = useMediaAudioBoost(videoElem);
const store = useStore();
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
	onError: error => {
		loadingState.stop();
		hls?.stopLoad();
		emit("error", error);
	},
});

function play() {
	return recovery.play();
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
	previous?.destroy();
	videoElem.value.pause();
	videoElem.value.removeAttribute("src");
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
	const engine = new Hls({
		maxBufferLength: bufferSeconds,
		maxMaxBufferLength: bufferSeconds,
		backBufferLength: 30,
	});
	hls = engine;

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
		}
	});

	engine.loadSource(videoUrl.value);
	engine.attachMedia(videoElem.value);
	emit("apiready");
}

onMounted(() => {
	loadingState.attach();
	loadVideoSource();
});

function onReady() {
	if (recovery.canPlay()) {
		emit("ready");
	}
}
function onPlaying() {
	if (!recovery.isRecovering() && !recovery.isFailed()) {
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

onBeforeUnmount(() => {
	loadingState.dispose();
	recovery.dispose();
	const previous = hls;
	hls = undefined;
	previous?.destroy();
	videoElem.value?.pause();
	videoElem.value?.removeAttribute("src");
	videoElem.value?.load();
});

watch(videoUrl, () => {
	loadVideoSource();
});

watch(
	() => store.state.settings.hlsBufferSeconds,
	seconds => {
		if (hls) {
			hls.config.maxBufferLength = seconds;
			hls.config.maxMaxBufferLength = seconds;
		}
	},
);

defineExpose({
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
	retry: recovery.retry,
	isSeeking: () => videoElem.value?.seeking ?? false,
	isRecovering: recovery.isRecovering,
} satisfies MediaPlayerWithCaptions & MediaPlayerWithQuality & MediaPlayerWithPlaybackRate & MediaPlayerWithAudioBoost);
</script>

<!-- biome-ignore lint/nursery/useScopedStyles: biome migration -->
<style lang="scss">
.hls {
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
</style>
