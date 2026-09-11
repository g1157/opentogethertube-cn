<template>
	<div class="player">
		<MediaLoadingNotice
			v-if="showLoadingNotice"
			:key="`${sourceKey}:${loadingAttempt}`"
			:state="loadingNoticeState"
			:room-playing="store.state.room.isPlaying"
			:can-retry="!!player?.retry"
			:preparation-failed="preparationFailed"
			:resuming="preparingPlayback"
			:waiting-for-viewer="waitingForPreparedPlayback"
			@retry="retryLocalMedia"
		/>
		<div class="in-player-notifs">
			<!-- TODO: replace with v-banner when this is fixed: https://github.com/vuetifyjs/vuetify/issues/17124 -->
			<v-sheet color="warning" density="compact" v-if="showBufferWarning">
				<v-container fluid style="padding: 6px">
					<div style="display: flex; align-items: center">
						<v-progress-circular indeterminate size="16" width="2" />
						<span>{{ $t("player.buffer-warn.spans", { ranges: renderedSpans }) }}</span>
						<v-spacer />
						<v-btn
							size="x-small"
							variant="text"
							icon
							@click="showBufferWarning = false"
						>
							<v-icon :icon="mdiClose" />
						</v-btn>
					</div>
				</v-container>
			</v-sheet>
		</div>
		<v-alert prominent variant="tonal" class="playback-error" v-if="showPlaybackError">
			<div class="playback-error-text">
				<h1>
					<v-icon :icon="mdiAlertCircle" />
					{{
						$t(`player.playback-error-title.${currentPlaybackError?.type ?? "unknown"}`)
					}}
				</h1>
				<span>{{
					$t(`player.playback-error-message.${currentPlaybackError?.type ?? "unknown"}`)
				}}</span>
				<span v-if="currentPlaybackError?.message">
					<br /><br />
					<em>{{ currentPlaybackError?.message }}</em>
				</span>
				<div v-if="player?.retry" class="playback-error-retry">
					<v-btn
						color="primary"
						data-cy="retry-local-media"
						@click.stop="retryLocalMedia"
					>
						{{ $t("player.retry-local") }}
					</v-btn>
					<p>{{ $t("player.retry-local-hint") }}</p>
				</div>
			</div>
		</v-alert>

		<Suspense>
			<YoutubePlayer
				v-if="!!source && source.service === 'youtube'"
				ref="player"
				:video-id="source.id"
				class="player"
				@apiready="onApiReady"
				@playing="onPlaying"
				@paused="onPaused"
				@ready="onReady"
				@buffering="onBuffering"
				@error="onError"
				@buffer-progress="onBufferProgress"
			/>
			<VimeoPlayer
				v-else-if="!!source && source.service === 'vimeo'"
				ref="player"
				:video-id="source.id"
				class="player"
				@apiready="onApiReady"
				@playing="onPlaying"
				@paused="onPaused"
				@ready="onReady"
				@buffering="onBuffering"
				@error="onError"
			/>
			<HlsPlayer
				v-else-if="
					!!source &&
					(['hls', 'reddit', 'tubi', 'pluto'].includes(source.service) ||
						(source.service === 'odysee' &&
							(source.mime?.includes('application/vnd.apple.mpegurl') ||
								source.mime?.includes('application/x-mpegURL'))))
				"
				ref="player"
				:video-url="source.hls_url ?? source.id"
				:thumbnail="source.thumbnail"
				class="player"
				@apiready="onApiReady"
				@playing="onPlaying"
				@paused="onPaused"
				@ready="onReady"
				@buffering="onBuffering"
				@error="onError"
				@buffer-progress="onBufferProgress"
				@buffer-spans="onBufferSpans"
				@loading-state="onLoadingState"
			/>
			<DashPlayer
				v-else-if="!!source && source.service === 'dash'"
				ref="player"
				:video-url="source.dash_url ?? source.id"
				:thumbnail="source.thumbnail"
				class="player"
				@apiready="onApiReady"
				@playing="onPlaying"
				@paused="onPaused"
				@ready="onReady"
				@buffering="onBuffering"
				@error="onError"
				@buffer-progress="onBufferProgress"
				@buffer-spans="onBufferSpans"
				@loading-state="onLoadingState"
			/>
			<DirectPlayer
				v-else-if="
					!!source &&
					(['direct', 'googledrive'].includes(source.service) ||
						(source.service === 'odysee' && source.mime?.includes('video/mp4')))
				"
				ref="player"
				:service="source.service"
				:video-url="source.src_url ?? source.id"
				:video-mime="source.mime!"
				:thumbnail="source.thumbnail"
				:subtitle-url="source.subtitleUrl"
				class="player"
				@apiready="onApiReady"
				@playing="onPlaying"
				@paused="onPaused"
				@ready="onReady"
				@buffering="onBuffering"
				@error="onError"
				@buffer-progress="onBufferProgress"
				@buffer-spans="onBufferSpans"
				@loading-state="onLoadingState"
			/>
			<PeertubePlayer
				v-else-if="!!source && source.service === 'peertube'"
				ref="player"
				:video-id="source.id"
				class="player"
				@apiready="onApiReady"
				@playing="onPlaying"
				@paused="onPaused"
				@ready="onReady"
				@buffering="onBuffering"
				@error="onError"
			/>
			<div v-else class="no-video">
				<h1>{{ $t("video.no-video") }}</h1>
				<span>{{ $t("video.no-video-text") }}</span>
			</div>
			<template #fallback>
				<div class="no-video">
					<v-progress-circular indeterminate />
				</div>
			</template>
		</Suspense>
	</div>
</template>

<script lang="ts" setup>
import { mdiAlertCircle, mdiClose } from "@mdi/js";
import { ALL_VIDEO_SERVICES } from "ott-common";
import { PlayerStatus } from "ott-common/models/types";
import type { QueueItem } from "ott-common/models/video";
import { calculateCurrentPosition } from "ott-common/timestamp";
import {
	computed,
	defineAsyncComponent,
	nextTick,
	onBeforeUnmount,
	type PropType,
	type Ref,
	ref,
	watch,
	watchEffect,
} from "vue";
import { useStore } from "@/store";
import type { MediaLoadingState } from "@/util/media-loading-state";
import { isInTimeRanges, secondsToTimestamp } from "@/util/timestamp";
import {
	type MediaPlayer,
	type MediaPlayerError,
	type MediaPlayerWithAudioBoost,
	type MediaPlayerWithCaptions,
	type MediaPlayerWithPlaybackRate,
	type MediaPlayerWithQuality,
	useCaptions,
	useMediaPlayer,
	usePlaybackRate,
	useQualities,
	useVolume,
} from "../composables";
import MediaLoadingNotice from "./MediaLoadingNotice.vue";

const props = defineProps({
	source: {
		type: Object as PropType<QueueItem | null>,
		validator: (source: QueueItem | null) => {
			return !source || ALL_VIDEO_SERVICES.includes(source.service);
		},
	},
	playbackBlocked: { type: Boolean, default: false },
	seekingPlayback: { type: Boolean, default: false },
	preparationFailed: { type: Boolean, default: false },
	preparingPlayback: { type: Boolean, default: false },
	waitingForPreparedPlayback: { type: Boolean, default: false },
});

const emit = defineEmits([
	"apiready",
	"playing",
	"paused",
	"ready",
	"buffering",
	"error",
	"loading-state",
	"retry",
]);

const YoutubePlayer = defineAsyncComponent(() => import("./YoutubePlayer.vue"));
const VimeoPlayer = defineAsyncComponent(() => import("./VimeoPlayer.vue"));
const HlsPlayer = defineAsyncComponent(() => import("./HlsPlayer.vue"));
const DashPlayer = defineAsyncComponent(() => import("./DashPlayer.vue"));
const DirectPlayer = defineAsyncComponent(() => import("./DirectPlayer.vue"));
const PeertubePlayer = defineAsyncComponent(() => import("./PeertubePlayer.vue"));

const store = useStore();

const player: Ref<MediaPlayer | null> = ref(null);

const sourceKey = computed(() =>
	JSON.stringify([
		props.source?.service,
		props.source?.id,
		props.source?.src_url,
		props.source?.hls_url,
		props.source?.dash_url,
		props.source?.mime,
		props.source?.subtitleUrl,
	]),
);
const usesNativeVideo = computed(() => {
	const source = props.source;
	return (
		!!source &&
		(["direct", "googledrive", "dash", "hls", "reddit", "tubi", "pluto"].includes(
			source.service,
		) ||
			(source.service === "odysee" &&
				["video/mp4", "application/vnd.apple.mpegurl", "application/x-mpegURL"].some(mime =>
					source.mime?.includes(mime),
				)))
	);
});
const loadingState = ref<MediaLoadingState>({
	phase: "preparing",
	currentTime: null,
	bufferAhead: null,
});
const loadingAttempt = ref(0);
const loadingNoticeState = computed<MediaLoadingState>(() =>
	props.seekingPlayback
		? { ...loadingState.value, phase: "seeking" }
		: props.preparationFailed || props.waitingForPreparedPlayback
		? { ...loadingState.value, phase: loadingState.value.phase ?? "waiting-frame" }
		: loadingState.value,
);
const showLoadingNotice = computed(
	() =>
		!!props.source?.id &&
		(usesNativeVideo.value ||
			["youtube", "vimeo", "peertube"].includes(props.source.service)) &&
		loadingNoticeState.value.phase !== null &&
		!props.playbackBlocked &&
		!showPlaybackError.value,
);

function onLoadingState(state: MediaLoadingState) {
	loadingState.value = state;
	emit("loading-state", state);
}

function embeddedPlayerReady() {
	if (!usesNativeVideo.value) {
		loadingState.value = { phase: null, currentTime: null, bufferAhead: null };
	}
}

const controls = useMediaPlayer();

function implementsCaptions(p: MediaPlayer | null): p is MediaPlayerWithCaptions {
	return !!p && p.isCaptionsSupported();
}

function implementsQualities(p: MediaPlayer | null): p is MediaPlayerWithQuality {
	return !!p && p.isQualitySupported();
}

function implementsPlaybackRate(p: MediaPlayer | null): p is MediaPlayerWithPlaybackRate {
	return !!p && p.getAvailablePlaybackRates().length > 1;
}

function implementsAudioBoost(p: MediaPlayer | null): p is MediaPlayerWithAudioBoost {
	return !!p && "setAudioBoost" in p;
}

function isCaptionsSupported() {
	if (!controls.checkForPlayer(player.value)) {
		return false;
	}
	return implementsCaptions(player.value);
}

function isQualitySupported() {
	if (!controls.checkForPlayer(player.value)) {
		return false;
	}
	return implementsQualities(player.value);
}

const volume = useVolume();
const captions = useCaptions();
const qualities = useQualities();
watch(
	() => store.state.settings.audioBoost,
	v => {
		if (player.value && implementsAudioBoost(player.value)) {
			player.value.setAudioBoost(v);
		}
	},
);
watch(volume.volume, v => {
	if (player.value) {
		player.value.setVolume(v);
	}
});
watch(player, v => {
	console.debug("Player changed", v);
	// note that we have to wait for the player's api to be ready before we can call any methods on it
	controls.setPlayer(v);
	if (!v) {
		captions.isCaptionsSupported.value = false;
		qualities.isQualitySupported.value = false;
		qualities.isAutoQualitySupported.value = false;
		playbackRate.availablePlaybackRates.value = [1];
	}
});
watch(captions.isCaptionsEnabled, v => {
	if (player.value && implementsCaptions(player.value)) {
		console.debug("Setting captions enabled", v);
		player.value.setCaptionsEnabled(v);
		captions.captionsTracks.value = player.value.getCaptionsTracks();
	}
});
watch(captions.currentTrack, v => {
	if (player.value && implementsCaptions(player.value) && v !== null) {
		player.value.setCaptionsTrack(v);
	}
});
watch(qualities.currentVideoTrack, v => {
	if (player.value && implementsQualities(player.value) && v !== null) {
		player.value.setVideoTrack(v);
	}
});
const playbackRate = usePlaybackRate();
watch(playbackRate.playbackRate, v => {
	if (player.value && implementsPlaybackRate(player.value)) {
		player.value.setPlaybackRate(v);
	}
});
watchEffect(() => {
	playbackRate.playbackRate.value = store.state.room.playbackSpeed;
});
// Clear error state when source changes
watch(
	sourceKey,
	() => {
		if (store.state.playerStatus === PlayerStatus.error) {
			store.commit("PLAYBACK_STATUS", PlayerStatus.none);
		}
		currentPlaybackError.value = null;
		showBufferWarning.value = false;
		onLoadingState({ phase: "preparing", currentTime: null, bufferAhead: null });
		store.commit("PLAYBACK_BUFFER_RESET");
	},
	{ flush: "sync" },
);
// player events re-emitted or data stored
async function onApiReady() {
	// mounted may emit before Vue assigns the template ref. The same component may also
	// emit again after a source/manifest change, so waiting for a new ref would deadlock.
	await nextTick();
	if (!player.value) {
		return;
	}

	controls.markApiReady();
	captions.isCaptionsSupported.value = isCaptionsSupported();
	qualities.isQualitySupported.value = isQualitySupported();
	if (player.value) {
		player.value.setVolume(volume.volume.value);
		if (implementsAudioBoost(player.value)) {
			player.value.setAudioBoost(store.state.settings.audioBoost);
		}
	}
	if (implementsCaptions(player.value)) {
		captions.captionsTracks.value = player.value.getCaptionsTracks();
	}
	if (implementsQualities(player.value)) {
		qualities.videoTracks.value = player.value.getVideoTracks();
		qualities.isAutoQualitySupported.value = player.value.isAutoQualitySupported();
	}
	if (implementsPlaybackRate(player.value)) {
		playbackRate.availablePlaybackRates.value = player.value.getAvailablePlaybackRates();
		player.value.setPlaybackRate(playbackRate.playbackRate.value);
	}
	emit("apiready");
}

function onReady() {
	embeddedPlayerReady();
	currentPlaybackError.value = null;
	showBufferWarning.value = false;
	store.commit("PLAYBACK_STATUS", PlayerStatus.ready);
	emit("ready");
}

function hackReadyEdgeCase() {
	if (props.source && props.source.service === "youtube") {
		embeddedPlayerReady();
		store.commit("PLAYBACK_STATUS", PlayerStatus.ready);
	}
}

function onPlaying() {
	embeddedPlayerReady();
	currentPlaybackError.value = null;
	showBufferWarning.value = false;
	store.commit("PLAYBACK_STATUS", PlayerStatus.ready);
	controls.playing.value = true;
	emit("playing");
}

function onPaused() {
	hackReadyEdgeCase();
	controls.playing.value = false;
	emit("paused");
}

function onBuffering() {
	if (!usesNativeVideo.value) {
		loadingState.value = { phase: "buffering", currentTime: null, bufferAhead: null };
	}
	currentPlaybackError.value = null;
	store.commit("PLAYBACK_STATUS", PlayerStatus.buffering);
	emit("buffering");
}

const currentPlaybackError = ref<MediaPlayerError | null>(null);
const showPlaybackError = computed(() => {
	return store.state.playerStatus === PlayerStatus.error;
});

function onError(errorType?: MediaPlayerError) {
	showBufferWarning.value = false;
	currentPlaybackError.value = errorType ?? { type: "unknown" };
	store.commit("PLAYBACK_STATUS", PlayerStatus.error);
	emit("error");
}

async function retryLocalMedia() {
	const currentPlayer = player.value;
	if (!currentPlayer?.retry) {
		return;
	}
	loadingAttempt.value++;
	onLoadingState({ phase: "preparing", currentTime: null, bufferAhead: null });
	emit("retry");
	store.commit("PLAYBACK_BUFFER_RESET");
	showBufferWarning.value = false;
	onBuffering();
	try {
		await currentPlayer.retry();
	} catch {
		if (currentPlayer === player.value) {
			onError({ type: "unknown" });
		}
	}
}

function onBufferProgress(percent: number) {
	store.commit("PLAYBACK_BUFFER", percent);
}

async function onBufferSpans(spans: TimeRanges) {
	store.commit("PLAYBACK_BUFFER_SPANS", spans);

	const position = store.state.room.isPlaying
		? calculateCurrentPosition(
				store.state.room.playbackStartTime,
				new Date(),
				store.state.room.playbackPosition,
				store.state.room.playbackSpeed,
		  )
		: store.state.room.playbackPosition;
	const isInSpans = isInTimeRanges(spans, position);
	showBufferWarning.value =
		store.state.playerStatus === PlayerStatus.buffering && spans.length > 0 && !isInSpans;
}

const showBufferWarning = ref(false);
const renderedSpans = computed(() => {
	const spans = store.state.playerBufferSpans;
	if (!spans) {
		return [];
	}
	let result: string = "";
	for (let i = 0; i < spans.length; i++) {
		result += `${secondsToTimestamp(spans.start(i))} - ${secondsToTimestamp(spans.end(i))}`;
		if (i < spans.length - 1) {
			result += ", ";
		}
	}
	return result;
});

onBeforeUnmount(() => {
	if (controls.player.value === player.value) {
		controls.setPlayer(null);
		controls.playing.value = false;
	}
});
</script>

<style lang="scss" scoped>
.no-video {
	display: flex;
	height: 100%;
	align-items: center;
	flex-direction: column;
	justify-content: center;

	padding: 16px;
	background: var(--card);
	color: var(--muted-foreground);
	text-align: center;
	border-radius: inherit;
}

.player {
	width: 100%;
	height: 100%;
}

.in-player-notifs {
	display: block;
	width: 100%;
	padding: 0;
	position: absolute;
	top: 0;
	left: 0;
	font-size: 12px;
	z-index: 500;
}
.playback-error {
	color: var(--foreground);
	position: absolute;
	width: 100%;
	height: 100%;
	display: flex;
	align-items: center;
	justify-content: center;
	background-color: rgba(var(--v-theme-background), 1);
	z-index: 1;
	padding: 24px;
	text-align: center;
}

.playback-error-text {
	max-width: 640px;
}

.playback-error-retry {
	margin-top: 20px;

	p {
		margin-top: 12px;
		font-size: 0.875rem;
		color: var(--muted-foreground);
	}
}
</style>
