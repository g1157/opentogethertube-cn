<template>
	<div class="direct">
		<video
			ref="videoElem"
			playsinline
			webkit-playsinline
			preload="auto"
			crossorigin="anonymous"
			@loadedmetadata="recovery.restoreMetadata"
			@canplay="onCanPlay"
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
				v-for="track in manifest?.textTracks ?? []"
				:key="track.url"
				kind="subtitles"
				:src="track.url"
				:srclang="track.srclang"
				:label="track.name"
				:default="track.default"
			/>
			<track
				v-if="subtitleUrl && videoMime !== 'application/json'"
				:src="subtitleUrl"
				kind="subtitles"
				default
			/>
		</video>
	</div>
</template>

<script lang="ts" setup>
import { nextTick, onBeforeUnmount, onMounted, ref, toRefs, watch } from "vue";
import type { CaptionTrack, VideoTrack } from "@/models/media-tracks";
import {
	CustomMediaManifestSchema,
	type CustomMediaManifest,
} from "ott-common/models/zod-schemas.js";
import { createMediaRecovery, nativeMediaError } from "@/util/media-recovery";
import type {
	MediaPlayerError,
	MediaPlayerWithAudioBoost,
	MediaPlayerWithCaptions,
	MediaPlayerWithPlaybackRate,
	MediaPlayerWithQuality,
} from "../composables";
import { useCaptions, useMediaAudioBoost, useQualities } from "../composables";

interface Props {
	service: string;
	videoUrl: string;
	videoMime: string;
	thumbnail?: string;
	subtitleUrl?: string;
}

const props = defineProps<Props>();
const { videoUrl, videoMime, thumbnail, subtitleUrl } = toRefs(props);
const videoElem = ref<HTMLVideoElement | undefined>();
const captions = useCaptions();
const audioBoost = useMediaAudioBoost(videoElem);
const qualities = useQualities();
const manifest = ref<CustomMediaManifest | null>(null);
let activeMediaUrl = "";
let sourceGeneration = 0;
let manifestRequest: AbortController | undefined;

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
}>();

const recovery = createMediaRecovery({
	media: () => videoElem.value,
	restart: async () => {
		if (activeMediaUrl && videoElem.value) {
			videoElem.value.src = activeMediaUrl;
			videoElem.value.load();
		} else {
			await resolveVideoSource(sourceGeneration);
		}
	},
	onRecovering: () => emit("buffering"),
	onError: error => {
		manifestRequest?.abort();
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
	return true;
}

function setCaptionsEnabled(enabled: boolean): void {
	if (!videoElem.value || captions.currentTrack.value === null) {
		return;
	}
	if (
		videoMime.value !== "application/json" &&
		!manifest.value?.textTracks &&
		!subtitleUrl.value
	) {
		return;
	}
	if (captions.currentTrack.value === -1) {
		if (enabled) {
			videoElem.value.textTracks[0].mode = "showing";
			captions.currentTrack.value = 0;
		}
		return;
	}
	if (captions.currentTrack.value >= videoElem.value.textTracks.length) {
		console.warn("DirectPlayer: invalid captions track index:", captions.currentTrack.value);
		return;
	}
	videoElem.value.textTracks[captions.currentTrack.value].mode = enabled ? "showing" : "hidden";
}

function isCaptionsEnabled(): boolean {
	if (!videoElem.value) {
		return false;
	}
	return Array.from(videoElem.value.textTracks).find(t => t.mode === "showing") !== undefined;
}

function getCaptionsTracks(): CaptionTrack[] {
	if (!videoElem.value) {
		return [];
	}
	if (videoMime.value === "application/json") {
		if (!manifest.value) {
			return [];
		}
	} else {
		return subtitleUrl.value ? [{ kind: "subtitles", default: true }] : [];
	}

	const tracks: CaptionTrack[] = [];
	for (const track of manifest.value.textTracks ?? []) {
		tracks.push({
			kind: "subtitles",
			label: track.name ?? undefined,
			srclang: track.srclang,
			default: track.default,
		});
	}
	return tracks;
}

function setCaptionsTrack(track: number): void {
	if (!videoElem.value) {
		console.error("player not ready");
		return;
	}
	console.log("DirectPlayer: setCaptionsTrack:", track);
	for (let i = 0; i < videoElem.value.textTracks.length; i++) {
		videoElem.value.textTracks[i].mode = i === track ? "showing" : "hidden";
	}
	captions.currentTrack.value = track;
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

async function loadVideoSource() {
	if (!videoElem.value) {
		return;
	}
	sourceGeneration++;
	manifestRequest?.abort();
	recovery.reset();
	activeMediaUrl = "";
	videoElem.value.pause();
	videoElem.value.removeAttribute("src");
	videoElem.value.load();
	// Fix for captions from previous video still showing after source change
	for (let i = 0; i < videoElem.value.textTracks.length; i++) {
		videoElem.value.textTracks[i].mode = "hidden";
	}
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
			const response = await fetch(videoUrl.value, { signal: request.signal });
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

		captions.captionsTracks.value = getCaptionsTracks();
		// The browser adds newly inserted <track> elements in "disabled" mode initially,
		// the default attribute causes them to become "showing" asynchronously.
		// To reflect this in the UI correctly, now the default track index is read directly
		// from the manifest data, and we explicitly set its mode to "showing"
		const defaultTrackIdx = manifest.value.textTracks?.findIndex(t => t.default) ?? -1;
		captions.currentTrack.value = defaultTrackIdx;
		captions.isCaptionsEnabled.value = defaultTrackIdx !== -1;
		if (defaultTrackIdx !== -1) {
			await nextTick();
			if (generation !== sourceGeneration || request.signal.aborted) {
				return;
			}
			const track = videoElem.value?.textTracks[defaultTrackIdx];
			if (track) {
				track.mode = "showing";
			}
		}
	} else {
		activeMediaUrl = videoUrl.value;

		qualities.videoTracks.value = [];
		qualities.currentVideoTrack.value = -1;

		if (subtitleUrl.value) {
			captions.captionsTracks.value = [{ kind: "subtitles", default: true }];
			captions.currentTrack.value = 0;
			captions.isCaptionsEnabled.value = true;
		} else {
			captions.captionsTracks.value = [];
			captions.currentTrack.value = -1;
			captions.isCaptionsEnabled.value = false;
		}
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
		emit("ready");
	}
}

function onPlaying() {
	if (recovery.isFailed() || recovery.isRecovering()) {
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

function onError() {
	const error = nativeMediaError(videoElem.value?.error ?? null);
	if (error) {
		console.warn("DirectPlayer: media error:", videoElem.value?.error);
		recovery.handleError(error);
	}
}

onMounted(() => {
	loadVideoSource();
});

watch([videoUrl, videoMime, subtitleUrl], () => {
	loadVideoSource();
});

onBeforeUnmount(() => {
	sourceGeneration++;
	manifestRequest?.abort();
	recovery.dispose();
	videoElem.value?.pause();
	videoElem.value?.removeAttribute("src");
	videoElem.value?.load();
});

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
} satisfies MediaPlayerWithCaptions & MediaPlayerWithPlaybackRate & MediaPlayerWithAudioBoost & MediaPlayerWithQuality);
</script>

<!-- biome-ignore lint/nursery/useScopedStyles: biome migration -->
<style lang="scss">
.direct {
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
</style>
