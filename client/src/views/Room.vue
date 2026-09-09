<template>
	<div>
		<!-- HACK: For some reason, safari really doesn't like typescript enums. As a result, we are forced to not use the enums, and use their literal values instead. -->
		<v-container
			fluid
			:class="{
				'room': true,
				'fullscreen': store.state.fullscreen,
				'layout-default': store.state.settings.roomLayout === 'default',
				'layout-theater': store.state.settings.roomLayout === 'theater',
			}"
			v-if="!showDisconnectedOverlay"
		>
			<div class="room-header" v-if="!store.state.fullscreen">
				<h1 class="room-title">
					{{
						store.state.room.title !== ""
							? store.state.room.title
							: store.state.room.isTemporary
							? $t("room.title-temp")
							: store.state.room.name
					}}
				</h1>
				<ClientSettingsDialog />
				<div class="grow"><!-- Spacer --></div>
				<div class="room-status">
					<v-btn
						class="room-visibility-badge"
						data-cy="room-visibility"
						variant="plain"
						size="default"
						slim
						:prepend-icon="roomVisibilityIcon"
						@click="onVisibilityClick"
					>
						{{ roomVisibilityLabel }}
						<v-tooltip activator="parent" location="top">
							{{ $t("room.visibility-badge-label") }}
						</v-tooltip>
					</v-btn>
					<v-icon :icon="mdiCircle" :color="connectionStatusColor" size="small" start />
					<span id="connectStatus">{{ connectionStatus }}</span>
				</div>
			</div>
			<RoomConnectionNotice />
			<div class="video-container">
				<div
					class="video-subcontainer"
					:class="{
						'player-fullscreen': store.state.fullscreen,
						'cursor-hidden': store.state.fullscreen && !controlsVisible,
					}"
					ref="fullscreenContainer"
					:style="{ '--player-controls-height': `${controlsHeight}px` }"
					@pointermove.capture="controls.mouseMove"
				>
					<div class="player-container">
						<OmniPlayer
							v-if="hasRoomSync"
							:source="currentSource"
							:playback-blocked="mediaPlaybackBlocked"
							:preparing-playback="playbackPreparationState.active"
							:preparation-failed="playbackPreparationState.failed"
							:waiting-for-prepared-playback="waitingForPreparedPlayback"
							@apiready="onPlayerApiReady"
							@playing="onPlaybackChange(true)"
							@paused="onPlaybackChange(false)"
							@ready="onPlayerReady"
							@loading-state="onMediaLoadingState"
							@retry="onPlayerRetry"
						/>
						<div
							v-else
							class="room-player-loading"
							data-cy="room-player-loading"
							role="status"
							aria-live="polite"
						>
							<v-progress-circular indeterminate size="28" width="3" />
							<span>{{ connectionStatus }}</span>
						</div>
						<div
							v-if="currentSource?.id && store.state.playerStatus !== 'error'"
							class="player-gesture-surface"
							:class="{ 'controls-hidden': !controlsVisible }"
							data-cy="player-gesture-surface"
							aria-hidden="true"
							@pointerdown="gestures.pointerDown"
							@pointermove="gestures.pointerMove"
							@pointerup="gestures.pointerUp"
							@pointercancel="gestures.pointerCancel"
							@lostpointercapture="gestures.pointerCancel"
							@pointerleave="gestures.pointerCancel"
							@contextmenu.prevent
							@click.prevent
							@dblclick.stop.prevent
						></div>
						<div
							class="player-gesture-hint"
							v-if="gestureHint"
							role="status"
							aria-live="polite"
						>
							{{ gestureHint }}
						</div>
						<div
							class="now-playing"
							v-if="currentSource?.id && controlsVisible"
							data-cy="now-playing"
						>
							<span>{{ $t("player.now-playing") }}</span>
							<strong v-if="episodeLabel">{{ episodeLabel }}</strong>
							<span class="now-playing-title">{{ nowPlaying.title }}</span>
						</div>
						<div
							class="in-video-chat"
							ref="inVideoChatTarget"
							v-show="chatInside"
						></div>
						<div class="playback-blocked-prompt" v-if="mediaPlaybackBlocked">
							<p role="status">{{ $t("player.loading.autoplay") }}</p>
							<v-btn
								:prepend-icon="mdiPlay"
								size="x-large"
								color="warning"
								@click="onClickUnblockPlayback"
							>
								{{ $t("common.play") }}
							</v-btn>
						</div>
					</div>
					<v-defaults-provider :defaults="fullscreenOverlayDefaults">
						<VideoControls
							:slider-position="sliderPosition"
							:true-position="truePosition"
							:controls-visible="controlsVisible"
							:key="currentSource?.id"
							:mode="controlsMode"
							@show-shortcuts="shortcutHelp = true"
							@resize="controlsHeight = $event"
						/>
						<PlayerShortcutsDialog v-model="shortcutHelp" />
					</v-defaults-provider>
				</div>
				<div class="out-video-chat" ref="outVideoChatTarget" v-show="!chatInside"></div>
				<Teleport v-if="chatTarget" :to="chatTarget">
					<Chat
						ref="chat"
						:draft="chatDraft"
						@update:draft="chatDraft = $event"
						:controls-visible="controlsVisible"
						@activation-change="chatOpen = $event"
						@link-click="setAddPreviewText"
					/>
				</Teleport>
			</div>
			<div class="banners" v-show="!store.state.fullscreen">
				<RestoreQueue />
				<VoteSkip />
			</div>
			<div class="under-video-grid" v-show="!store.state.fullscreen">
				<div class="under-video-tabs">
					<v-tabs fixed-tabs v-model="queueTab" color="primary">
						<v-tab>
							<v-icon :icon="mdiFormatListBulleted" />
							<span class="tab-text">{{ $t("room.tabs.queue") }}</span>
							<v-chip size="x-small">
								{{
									store.state.room.queue.length <= 99
										? $n(store.state.room.queue.length)
										: "99+"
								}}
							</v-chip>
						</v-tab>
						<v-tab>
							<v-icon :icon="mdiPlus" />
							<span class="tab-text">{{ $t("common.add") }}</span>
						</v-tab>
						<v-tab>
							<v-icon :icon="mdiWrench" />
							<span class="tab-text">{{ $t("room.tabs.settings") }}</span>
						</v-tab>
					</v-tabs>
					<v-window v-model="queueTab" class="queue-tab-content">
						<v-window-item>
							<VideoQueue @switchtab="queueTab = 1" />
						</v-window-item>
						<v-window-item>
							<AddPreview ref="addpreview" />
						</v-window-item>
						<v-window-item>
							<RoomSettingsForm ref="settings" />
						</v-window-item>
					</v-window>
				</div>
				<div class="user-invite-container">
					<div v-if="debugMode" class="debug-container">
						<v-card>
							<v-card-title> Debug (prod: {{ production }}) </v-card-title>
							<v-list-item>
								Player status: {{ store.state.playerStatus }}
							</v-list-item>
							<v-list-item v-if="store.state.playerBufferPercent">
								Buffered:
								{{ Math.round(store.state.playerBufferPercent * 10000) / 100 }}%
							</v-list-item>
							<v-list-item
								v-if="
									store.state.playerBufferSpans &&
									store.state.playerBufferSpans.length > 0
								"
							>
								Buffered spans:
								{{ store.state.playerBufferSpans.length }}
								{{
									Array.from(
										{ length: store.state.playerBufferSpans.length },
										(v, k) => k++,
									)
										.map(
											i =>
												`${i}: [${secondsToTimestamp(
													store.state.playerBufferSpans?.start(i) ?? 0,
												)} => ${secondsToTimestamp(
													store.state.playerBufferSpans?.end(i) ?? 0,
												)}]`,
										)
										.join(" ")
								}}
							</v-list-item>
							<v-list-item>
								<span>Is Mobile: {{ isMobile }}</span>
							</v-list-item>
							<v-list-item>
								<span>Device Orientation: {{ orientation }}</span>
							</v-list-item>
							<v-list-item>
								<span>
									Video controls: timeoutId:
									{{ videoControlsHideTimeout }} visible:
									{{ controlsVisible }}
								</span>
							</v-list-item>
							<v-list-item>
								<v-btn @click="roomapi.kickMe()" :disabled="!isConnected">
									{{ $t("room.kick-me") }}
								</v-btn>
								<v-btn @click="roomapi.kickMe(1000)" :disabled="!isConnected">
									Disconnect Me
								</v-btn>
							</v-list-item>
						</v-card>
					</div>
					<UserList :users="Array.from(store.state.users.users.values())" />
					<ShareInvite />
				</div>
			</div>
		</v-container>
		<AppFooter class="room-footer" v-show="!store.state.fullscreen" />
		<v-overlay
			class="overlay-disconnected"
			:model-value="showDisconnectedOverlay"
			content-class="content"
		>
			<RoomDisconnected />
		</v-overlay>
		<ServerMessageHandler />
		<WorkaroundPlaybackStatusUpdater />
		<WorkaroundUserStateNotifier />
	</div>
</template>

<script lang="ts">
import {
	mdiPlay,
	mdiFormatListBulleted,
	mdiPlus,
	mdiWrench,
	mdiEarth,
	mdiEyeOff,
	mdiLock,
	mdiCircle,
} from "@mdi/js";
import {
	defineComponent,
	ref,
	type Ref,
	unref,
	computed,
	watch,
	onMounted,
	onUnmounted,
	nextTick,
	provide,
	useTemplateRef,
} from "vue";
import AddPreview from "@/components/AddPreview.vue";
import { calculateCurrentPosition } from "ott-common/timestamp";
import _ from "lodash";
import OmniPlayer from "@/components/players/OmniPlayer.vue";
import Chat from "@/components/Chat.vue";
import UserList from "@/components/UserList.vue";
import VideoQueue from "@/components/VideoQueue.vue";
import { useGoTo } from "vuetify";
import RoomSettingsForm from "@/components/RoomSettingsForm.vue";
import ShareInvite from "@/components/ShareInvite.vue";
import ClientSettingsDialog from "@/components/ClientSettingsDialog.vue";
import RoomDisconnected from "../components/RoomDisconnected.vue";
import RoomConnectionNotice from "@/components/RoomConnectionNotice.vue";
import { useConnection } from "@/plugins/connection";
import { useRoomApi } from "@/util/roomapi";
import ServerMessageHandler from "@/components/ServerMessageHandler.vue";
import WorkaroundPlaybackStatusUpdater from "@/components/WorkaroundPlaybackStatusUpdater.vue";
import WorkaroundUserStateNotifier from "@/components/WorkaroundUserStateNotifier.vue";
import { useStore } from "@/store";
import { useI18n } from "vue-i18n";
import { useRouter, useRoute } from "vue-router";
import type { ServerMessageSync } from "ott-common/models/messages";
import { useScreenOrientation } from "@vueuse/core";
import { KeyboardShortcuts, RoomKeyboardShortcutsKey } from "@/util/keyboard-shortcuts";
import VideoControls from "@/components/controls/VideoControls.vue";
import RestoreQueue from "@/components/RestoreQueue.vue";
import VoteSkip from "@/components/VoteSkip.vue";
import { waitForToken } from "@/util/token";
import { useSfx } from "@/plugins/sfx";
import { secondsToTimestamp } from "@/util/timestamp";
import { useCaptions, useMediaPlayer, usePlaybackRate, useVolume } from "@/components/composables";
import { useGrants } from "@/components/composables/grants";
import { PlayerStatus, Visibility } from "ott-common/models/types";
import { createPlayerFullscreen, PlayerFullscreenKey } from "@/util/player-fullscreen";
import { PlayerControlsActivityKey, usePlayerControls } from "@/util/player-controls";
import { createPlayerGestures } from "@/util/player-gestures";
import { createPlaybackSync } from "@/util/playback-sync";
import {
	createPlaybackPreparation,
	type PlaybackPreparationState,
} from "@/util/playback-preparation";
import type { MediaLoadingState } from "@/util/media-loading-state";
import { useTemporaryPlaybackSpeed } from "@/util/temporary-playback-speed";
import { TEMPORARY_PLAYBACK_SPEED } from "ott-common/constants";
import PlayerShortcutsDialog from "@/components/PlayerShortcutsDialog.vue";
import AppFooter from "@/components/AppFooter.vue";
import { nowPlayingDetails } from "@/util/now-playing";

// biome-ignore lint/nursery/noVueOptionsApi: TODO: convert to setup
export default defineComponent({
	name: "room",
	components: {
		VideoControls,
		VideoQueue,
		OmniPlayer,
		Chat,
		AddPreview,
		UserList,
		RoomSettingsForm,
		ShareInvite,
		ClientSettingsDialog,
		RoomDisconnected,
		RoomConnectionNotice,
		ServerMessageHandler,
		WorkaroundPlaybackStatusUpdater,
		WorkaroundUserStateNotifier,
		RestoreQueue,
		VoteSkip,
		PlayerShortcutsDialog,
		AppFooter,
	},
	setup() {
		const store = useStore();
		const connection = useConnection();
		const roomapi = useRoomApi(connection);
		const { t } = useI18n();
		const router = useRouter();
		const route = useRoute();
		const goTo = useGoTo();
		// The shared store survives navigation. Never start its previous video before
		// this visit receives the room's current source and playback state.
		const hasRoomSync = ref(false);
		const currentSource = computed(() =>
			hasRoomSync.value ? store.state.room.currentSource : null,
		);
		const nowPlaying = computed(() => nowPlayingDetails(currentSource.value));
		const episodeLabel = computed(() =>
			nowPlaying.value.episode
				? t(
						nowPlaying.value.season ? "player.season-episode" : "player.episode",
						nowPlaying.value,
				  )
				: "",
		);
		const player = useMediaPlayer();
		const volume = useVolume();
		const playbackRate = usePlaybackRate();
		const granted = useGrants();
		const mediaPlaybackBlocked = ref(false);
		const chat = ref<InstanceType<typeof Chat> | null>(null);
		const chatOpen = ref(false);
		const chatDraft = ref("");
		const shortcutHelp = ref(false);
		const controlsHeight = ref(90);

		// video control visibility
		const controls = usePlayerControls(
			() =>
				!store.state.room.isPlaying ||
				!currentSource.value?.id ||
				mediaPlaybackBlocked.value ||
				store.state.playerStatus === PlayerStatus.error ||
				chatOpen.value ||
				shortcutHelp.value,
			() => store.state.settings.controlsHideSeconds,
		);
		const controlsVisible = controls.visible;
		const videoControlsHideTimeout = controls.timeout;
		provide(PlayerControlsActivityKey, controls);
		const fullscreenContainer = useTemplateRef<HTMLDivElement>("fullscreenContainer");
		const fullscreen = createPlayerFullscreen(
			() => fullscreenContainer.value,
			active => store.commit("SET_FULLSCREEN", active),
		);
		provide(PlayerFullscreenKey, fullscreen);
		onUnmounted(() => fullscreen.dispose());
		const fullscreenOverlayDefaults = computed(() => {
			const attach = store.state.fullscreen ? fullscreenContainer.value : false;
			return { VMenu: { attach }, VTooltip: { attach }, VDialog: { attach } };
		});
		function setVideoControlsVisibility(visible: boolean) {
			if (visible) {
				controls.activity();
			} else {
				controls.hide();
			}
		}
		function activateVideoControls() {
			controls.activity();
		}

		const controlsMode = computed(() =>
			currentSource.value?.service === "youtube" ? "outside-video" : "in-video",
		);
		const chatInside = computed(
			() => controlsMode.value === "in-video" || store.state.fullscreen,
		);
		const inVideoChatTarget = useTemplateRef<HTMLDivElement>("inVideoChatTarget");
		const outVideoChatTarget = useTemplateRef<HTMLDivElement>("outVideoChatTarget");
		// Mount after the targets exist, then move the same Chat instance across layout changes.
		const chatTarget = computed(() =>
			chatInside.value ? inVideoChatTarget.value : outVideoChatTarget.value,
		);

		// actively calculate the current position of the video
		const truePosition = ref(0);
		const sliderPosition = ref(0);
		const iTimestampUpdater: Ref<ReturnType<typeof setInterval> | null> = ref(null);
		let disposed = false;
		let playbackApplication = 0;
		const localPlaying = ref(false);
		const localMediaState = ref<MediaLoadingState | null>(null);
		let mediaFrameVersion = 0;
		const playbackPreparationState = ref<PlaybackPreparationState>({
			phase: "idle",
			active: false,
			priming: false,
			failed: false,
		});
		const waitingForPreparedPlayback = computed(
			() =>
				hasRoomSync.value &&
				!!store.state.room.playbackPreparation &&
				!store.state.room.isPlaying &&
				!playbackPreparationState.value.active,
		);
		const playbackPreparation = createPlaybackPreparation({
			getState: () => ({
				preparation: hasRoomSync.value ? store.state.room.playbackPreparation : null,
				clientId: store.state.users.you.id,
				source: currentSource.value?.id ? currentSource.value : null,
				player: player.player.value,
				connected: connection.connected.value,
				roomPlaying: store.state.room.isPlaying,
				ready: player.apiReady.value,
				playing: localPlaying.value,
				blocked: mediaPlaybackBlocked.value,
				error: store.state.playerStatus === PlayerStatus.error,
				seeking: player.isSeeking(),
				recovering: player.isRecovering(),
				loading: localMediaState.value,
				frameVersion: mediaFrameVersion,
			}),
			getPosition: () => player.getPosition(),
			setPosition: position => player.setPosition(position),
			pause: () => player.pause(),
			sendReady: playbackPrepared =>
				connection.send({ action: "status", status: PlayerStatus.ready, playbackPrepared }),
			onChange: state => {
				playbackPreparationState.value = state;
			},
			onError: error => console.warn("Could not prepare the saved playback position", error),
		});
		watch(
			[
				() => store.state.room.playbackPreparation,
				() => store.state.room.isPlaying,
				() => store.state.users.you.id,
				() => store.state.playerStatus,
				hasRoomSync,
				connection.connected,
				player.apiReady,
				mediaPlaybackBlocked,
			],
			() => void playbackPreparation.tick(),
			{ flush: "post" },
		);
		watch(
			() => playbackPreparationState.value.priming,
			() => void applyIsPlaying(),
			{ flush: "post" },
		);

		function roomPosition() {
			if (!currentSource.value?.id) {
				return 0;
			}
			return store.state.room.isPlaying
				? calculateCurrentPosition(
						store.state.room.playbackStartTime,
						new Date(),
						store.state.room.playbackPosition,
						store.state.room.playbackSpeed,
				  )
				: store.state.room.playbackPosition;
		}

		const playbackSync = createPlaybackSync({
			getState: () => ({
				source: currentSource.value?.id ? currentSource.value : null,
				player: player.player.value,
				ready: player.apiReady.value && !playbackPreparationState.value.active,
				error: store.state.playerStatus === PlayerStatus.error,
				blocked: mediaPlaybackBlocked.value,
				seeking: player.isSeeking(),
				recovering: player.isRecovering(),
				buffering: store.state.playerStatus === PlayerStatus.buffering,
				position: roomPosition(),
			}),
			getPosition: () => player.getPosition(),
			setPosition: position => player.setPosition(position),
			onError: error => console.warn("Could not synchronize playback position", error),
		});
		watch(
			[currentSource, player.player],
			() => {
				playbackApplication++;
				localPlaying.value = false;
				localMediaState.value = null;
				mediaFrameVersion++;
				mediaPlaybackBlocked.value = false;
				playbackSync.reset();
			},
			{ flush: "sync" },
		);

		function timestampUpdate() {
			truePosition.value = roomPosition();
			sliderPosition.value = _.clamp(
				truePosition.value,
				0,
				store.state.room.currentSource?.length ?? 0,
			);
			void playbackPreparation.tick();
			void playbackSync.tick();
		}

		onMounted(() => {
			iTimestampUpdater.value = setInterval(timestampUpdate, 250);
		});

		onUnmounted(() => {
			disposed = true;
			playbackApplication++;
			playbackPreparation.dispose();
			playbackSync.dispose();
			if (iTimestampUpdater.value) {
				clearInterval(iTimestampUpdater.value);
			}
		});

		// connection status
		const isConnected = computed(() => connection.connected.value);
		const connectionStatus = computed(() => {
			if (connection.connected.value) {
				return t("room.con-status.connected");
			}
			if (connection.issue.value === "timeout") {
				return t("room.con-status.timeout");
			}
			if (connection.issue.value === "network") {
				return t("room.con-status.reconnecting");
			}
			return t("room.con-status.connecting");
		});
		const connectionStatusColor = computed(() =>
			connection.connected.value ? "success" : "warning",
		);
		const showDisconnectedOverlay = computed(() => !!connection.kickReason.value);
		watch(showDisconnectedOverlay, disconnected => {
			if (disconnected) {
				void fullscreen.exit();
			}
		});

		function rewriteUrlToRoomName() {
			if (store.state.room.name.length === 0) {
				return;
			}
			if (route.params.roomId !== store.state.room.name) {
				console.debug(
					`room name does not match URL, rewriting to "${store.state.room.name}"`,
				);
				router.replace({
					name: "room",
					params: { roomId: store.state.room.name },
				});
			}
		}

		async function onSyncMsg(msg: ServerMessageSync) {
			if (disposed) {
				return;
			}
			if (typeof msg.name === "string" && "currentSource" in msg) {
				if (!hasRoomSync.value) {
					store.commit("PLAYBACK_STATUS", PlayerStatus.none);
					store.commit("PLAYBACK_BUFFER_RESET");
				}
				hasRoomSync.value = true;
			}
			if (!hasRoomSync.value) {
				return;
			}
			rewriteUrlToRoomName();
			const source = currentSource.value;
			if ("currentSource" in msg) {
				// Let the child load the new URL before applying its initial playback position.
				await nextTick();
				if (disposed || currentSource.value !== source) {
					return;
				}
			}
			void playbackPreparation.tick();
			if (msg.playbackPosition !== undefined || "currentSource" in msg) {
				if (!playbackPreparationState.value.active) {
					void playbackSync.requestSeek();
				}
				timestampUpdate();
			}
			if (msg.isPlaying !== undefined || "playbackPreparation" in msg) {
				await applyIsPlaying();
			}
		}

		let roomCreatedTimer: ReturnType<typeof setTimeout> | null = null;
		function onRoomCreated() {
			if (disposed) {
				return;
			}
			hasRoomSync.value = false;
			mediaPlaybackBlocked.value = false;
			if (connection.active.value) {
				connection.disconnect();
			}
			if (roomCreatedTimer !== null) {
				clearTimeout(roomCreatedTimer);
			}
			roomCreatedTimer = setTimeout(() => {
				roomCreatedTimer = null;
				if (!disposed && !connection.active.value) {
					connection.connect(route.params.roomId as string);
				}
			}, 100);
		}

		let roomCreatedUnsub: (() => void) | null = null;
		onMounted(async () => {
			await waitForToken(store);
			if (disposed) {
				return;
			}

			connection.addMessageHandler("sync", onSyncMsg);
			if (!connection.active.value) {
				connection.connect(route.params.roomId as string);
			}

			roomCreatedUnsub = store.subscribe(mutation => {
				if (mutation.type === "misc/ROOM_CREATED") {
					onRoomCreated();
				}
			});
		});

		onUnmounted(() => {
			if (roomCreatedTimer !== null) {
				clearTimeout(roomCreatedTimer);
				roomCreatedTimer = null;
			}
			connection.removeMessageHandler("sync", onSyncMsg);
			connection.disconnect();

			if (roomCreatedUnsub) {
				roomCreatedUnsub();
			}
		});

		// player management
		function togglePlayback() {
			playbackPreparation.cancel();
			if (store.state.room.isPlaying) {
				roomapi.pause();
			} else {
				roomapi.play();
			}
		}

		function seekDelta(delta: number) {
			const bounds = seekBounds();
			if (bounds && connection.connected.value) {
				playbackPreparation.cancel();
				roomapi.seek(_.clamp(truePosition.value + delta, bounds.start, bounds.end));
				activateVideoControls();
			}
		}

		// Indicates that starting playback is blocked by the browser. This usually means that the user needs
		// to interact with the page before playback can start. This is because browsers block autoplaying videos.

		function wantsPlayback() {
			return store.state.room.isPlaying || playbackPreparationState.value.priming;
		}

		async function applyIsPlaying(unblock = false): Promise<void> {
			const application = ++playbackApplication;
			const source = currentSource.value;
			const currentPlayer = player.player.value;
			const playing = wantsPlayback();
			const preparationId = store.state.room.playbackPreparation?.id;
			if (
				disposed ||
				!source?.id ||
				!currentPlayer ||
				!player.apiReady.value ||
				store.state.playerStatus === PlayerStatus.error ||
				(playing && mediaPlaybackBlocked.value && !unblock)
			) {
				return;
			}
			const stillCurrent = () =>
				!disposed &&
				application === playbackApplication &&
				currentSource.value === source &&
				player.player.value === currentPlayer &&
				playing === wantsPlayback() &&
				preparationId === store.state.room.playbackPreparation?.id;
			try {
				if (playing) {
					await player.play();
				} else {
					await player.pause();
				}
				if (stillCurrent()) {
					mediaPlaybackBlocked.value = false;
					void playbackPreparation.tick();
				}
			} catch (error) {
				if (!stillCurrent()) {
					return;
				}
				if (error instanceof DOMException && error.name === "NotAllowedError") {
					localPlaying.value = false;
					mediaPlaybackBlocked.value = true;
				} else {
					localPlaying.value = false;
					playbackPreparation.fail(error);
					console.warn("Could not apply room playback state", error);
				}
			}
		}

		function onClickUnblockPlayback(): void {
			if (!playbackPreparationState.value.active) {
				void playbackSync.requestSeek();
			}
			void applyIsPlaying(true);
		}

		function onMediaLoadingState(state: MediaLoadingState) {
			localMediaState.value = state;
			mediaFrameVersion++;
			void playbackPreparation.tick();
		}

		function onPlayerRetry() {
			localPlaying.value = false;
			mediaPlaybackBlocked.value = false;
			playbackPreparation.retry();
		}

		function onPlayerApiReady() {
			console.debug("internal player API is now ready");
			timestampUpdate();
			void applyIsPlaying();
		}

		async function onPlaybackChange(changeTo: boolean) {
			console.debug(`onPlaybackChange: ${changeTo}`);
			localPlaying.value = changeTo;
			void playbackPreparation.tick();
			if (!changeTo) {
				setVideoControlsVisibility(true);
			} else {
				activateVideoControls();
			}
			if (changeTo === wantsPlayback()) {
				return;
			}

			await applyIsPlaying();
		}
		function onPlayerReady() {
			timestampUpdate();
			void applyIsPlaying();
		}

		const captions = useCaptions();
		function isCaptionsSupported() {
			return captions.isCaptionsSupported.value;
		}
		function getCaptionsTracks() {
			return captions.captionsTracks.value;
		}

		// misc UI stuff
		const isMobile = computed(
			() => window.matchMedia("only screen and (max-width: 760px)").matches,
		);
		const orientation = useScreenOrientation();
		const queueTab = ref(0);
		const roomSettingsForm = ref<typeof RoomSettingsForm | null>(null);

		onMounted(() => {
			if (!orientation.isSupported.value) {
				return;
			}

			watch(orientation.orientation, async newOrientation => {
				if (!newOrientation) {
					return;
				}
				if (isMobile.value) {
					if (newOrientation.startsWith("landscape")) {
						await fullscreen.enter();
					} else {
						await fullscreen.exit();
					}
				}
			});
		});

		watch(queueTab, async newTab => {
			if (roomSettingsForm.value && newTab === 2) {
				await roomSettingsForm.value.loadRoomSettings();
			}
		});

		function onVideoTap() {
			if (chatOpen.value) {
				chat.value?.setActivated(false);
				controls.hide();
			} else if (controlsVisible.value) {
				controls.hide();
			} else {
				activateVideoControls();
			}
		}

		function onVideoDoubleTap() {
			activateVideoControls();
			if (!connection.connected.value) {
				return;
			}
			if (!granted("playback.play-pause")) {
				showInteractionNotice("play-pause-denied");
				return;
			}
			togglePlayback();
		}

		function seekBounds() {
			const video = currentSource.value;
			if (!video || !Number.isFinite(video.length) || (video.length ?? 0) <= 0) {
				return null;
			}
			const start = 0;
			const end = Math.min(video.length!, video.endAt ?? video.length!);
			return end > start ? { start, end } : null;
		}

		const interactionNotice = ref("");
		let noticeTimer: ReturnType<typeof setTimeout> | null = null;
		function showInteractionNotice(key: string) {
			interactionNotice.value = t(`player.interactions.${key}`);
			if (noticeTimer !== null) {
				clearTimeout(noticeTimer);
			}
			noticeTimer = setTimeout(() => {
				interactionNotice.value = "";
			}, 2000);
		}
		const temporarySpeed = useTemporaryPlaybackSpeed({
			connected: () => connection.connected.value,
			clientId: () => store.state.users.you.id,
			currentVideo: () => currentSource.value,
			roomGesture: () => store.state.room.temporaryPlaybackSpeed,
			canStart: () => {
				if (!granted("playback.speed")) {
					showInteractionNotice("speed-denied");
					return false;
				}
				if (store.state.room.temporaryPlaybackSpeed) {
					showInteractionNotice("speed-busy");
					return false;
				}
				if (
					!store.state.room.isPlaying ||
					mediaPlaybackBlocked.value ||
					!seekBounds() ||
					!playbackRate.availablePlaybackRates.value.includes(TEMPORARY_PLAYBACK_SPEED)
				) {
					showInteractionNotice("speed-unavailable");
					return false;
				}
				return true;
			},
			send: (action, id, video) => roomapi.temporaryPlaybackRate(action, id, video),
			onRejected: () => showInteractionNotice("speed-unavailable"),
		});
		const gestures = createPlayerGestures({
			getPosition: () => truePosition.value,
			getBounds: seekBounds,
			getSeekStep: () => store.state.settings.swipeSeekSeconds,
			canSeek: () => connection.connected.value && granted("playback.seek"),
			isPlaying: () => store.state.room.isPlaying && !mediaPlaybackBlocked.value,
			onTap: onVideoTap,
			onDoubleTap: onVideoDoubleTap,
			onDoubleClick: () => {
				void fullscreen.toggle();
			},
			onSeek: position => {
				playbackPreparation.cancel();
				roomapi.seek(position);
				activateVideoControls();
			},
			onSeekDenied: () => showInteractionNotice("seek-denied"),
			onHoldStart: temporarySpeed.start,
			onHoldEnd: temporarySpeed.stop,
		});
		const gestureHint = computed(() => {
			if (interactionNotice.value) {
				return interactionNotice.value;
			}
			if (gestures.preview.value) {
				const { position, delta } = gestures.preview.value;
				return t("player.interactions.seek-preview", {
					delta: `${delta >= 0 ? "+" : ""}${Math.round(delta)}`,
					time: secondsToTimestamp(position),
				});
			}
			if (store.state.room.temporaryPlaybackSpeed) {
				return t(
					temporarySpeed.gestureId.value ===
						store.state.room.temporaryPlaybackSpeed.gestureId
						? "player.interactions.holding"
						: "player.interactions.room-holding",
				);
			}
			return "";
		});
		function cancelGestures() {
			gestures.cancel();
			temporarySpeed.stop();
		}
		function onVisibilityChange() {
			if (document.hidden) {
				cancelGestures();
			}
		}
		watch(currentSource, () => {
			cancelGestures();
			activateVideoControls();
		});
		watch(
			() => store.state.room.isPlaying,
			playing => {
				if (!playing) {
					cancelGestures();
				}
			},
		);
		watch(connection.connected, connected => {
			if (!connected) {
				cancelGestures();
			}
		});
		onMounted(() => {
			document.addEventListener("visibilitychange", onVisibilityChange);
			window.addEventListener("blur", cancelGestures);
			window.addEventListener("pagehide", cancelGestures);
		});
		onUnmounted(() => {
			cancelGestures();
			if (noticeTimer !== null) {
				clearTimeout(noticeTimer);
			}
			document.removeEventListener("visibilitychange", onVisibilityChange);
			window.removeEventListener("blur", cancelGestures);
			window.removeEventListener("pagehide", cancelGestures);
		});

		const addpreview = ref<typeof AddPreview | null>(null);
		async function setAddPreviewText(text: string) {
			queueTab.value = 1;
			await nextTick();
			if (!addpreview.value) {
				// HACK: the tab is not yet mounted, so we need to wait for it to be mounted
				// this will be more elegant when we have a new vue 3 style global event bus.
				await nextTick();
			}
			if (addpreview.value) {
				addpreview.value.setAddPreviewText(text);
			} else {
				console.error("addpreview is not mounted, can't set text");
			}
		}

		// keyboard shortcuts
		const shortcuts = new KeyboardShortcuts();
		shortcuts.bind([{ code: "Space" }, { code: "KeyK" }], () => {
			if (granted("playback.play-pause")) {
				togglePlayback();
			}
		});
		shortcuts.bind(
			["ArrowLeft", "ArrowRight", "KeyJ", "KeyL"].map(code => ({ code, repeat: true })),
			(e: KeyboardEvent) => {
				if (granted("playback.seek")) {
					let seekIncrement = 5;
					if (e.ctrlKey || e.code === "KeyJ" || e.code === "KeyL") {
						seekIncrement = 10;
					}
					if (e.code === "ArrowLeft" || e.code === "KeyJ") {
						seekIncrement *= -1;
					}

					seekDelta(seekIncrement);
				}
			},
		);
		shortcuts.bind({ code: "Home" }, () => {
			if (granted("playback.seek")) {
				playbackPreparation.cancel();
				roomapi.seek(0);
			}
		});
		shortcuts.bind({ code: "End" }, () => {
			if (granted("playback.skip")) {
				playbackPreparation.cancel();
				roomapi.skip();
			}
		});
		shortcuts.bind(
			[
				{ code: "ArrowUp", repeat: true },
				{ code: "ArrowDown", repeat: true },
			],
			(e: KeyboardEvent) => {
				volume.volume.value = _.clamp(
					volume.volume.value + 5 * (e.code === "ArrowDown" ? -1 : 1),
					0,
					100,
				);
				activateVideoControls();
			},
		);
		shortcuts.bind({ code: "KeyM" }, () => {
			volume.isMuted.value = !volume.isMuted.value;
			activateVideoControls();
		});
		shortcuts.bind({ code: "KeyT" }, () => chat.value?.setActivated(!chatOpen.value));
		shortcuts.bind([{ code: "Enter" }, { code: "NumpadEnter" }], () =>
			chat.value?.activateAndFocus(),
		);
		shortcuts.bind({ code: "KeyF" }, () => {
			void fullscreen.toggle();
		});
		shortcuts.bind({ code: "Slash", shiftKey: true }, () => {
			shortcutHelp.value = true;
		});
		shortcuts.bind({ code: "Escape" }, () => {
			if (chatOpen.value) {
				chat.value?.setActivated(false);
			} else if (store.state.fullscreen) {
				void fullscreen.exit();
			}
		});
		shortcuts.bind({ code: "F12", ctrlKey: true, shiftKey: true }, () => {
			debugMode.value = !debugMode.value;
		});
		function onKeyDown(e: KeyboardEvent) {
			shortcuts.handleKeyDown(e);
		}
		provide(RoomKeyboardShortcutsKey, shortcuts);

		onMounted(() => {
			window.addEventListener("keydown", onKeyDown);
		});

		onUnmounted(() => {
			window.removeEventListener("keydown", onKeyDown);
		});

		const roomVisibility = computed(() => store.state.room.visibility);

		const roomVisibilityIcon = computed(() => {
			switch (roomVisibility.value) {
				case Visibility.Public:
					return mdiEarth;
				case Visibility.Unlisted:
					return mdiEyeOff;
				case Visibility.Private:
					return mdiLock;
				default:
					return mdiEyeOff;
			}
		});

		const roomVisibilityLabel = computed(() => {
			switch (roomVisibility.value) {
				case Visibility.Public:
					return t("room-settings.public");
				case Visibility.Unlisted:
					return t("room-settings.unlisted");
				case Visibility.Private:
					return t("room-settings.private");
				default:
					return "This is a bug";
			}
		});

		async function onVisibilityClick() {
			queueTab.value = 2;
			await nextTick();
			if (roomSettingsForm.value) {
				await roomSettingsForm.value.loadRoomSettings();
				await nextTick();
				roomSettingsForm.value.openVisibilityMenu();
				goTo(roomSettingsForm.value.$el);
			}
		}

		// small helper aliases
		const production = computed(() => store.state.production);

		// debug mode
		const debugMode = ref(!unref(production));
		provide("debugMode", debugMode);

		const sfx = useSfx();
		onMounted(async () => {
			await sfx.loadSfx();
		});

		return {
			store,
			roomapi,
			granted,

			controlsVisible,
			controlsHeight,
			controls,
			gestures,
			gestureHint,
			onVideoTap,
			chat,
			chatOpen,
			chatDraft,
			chatInside,
			chatTarget,
			shortcutHelp,
			fullscreenOverlayDefaults,
			videoControlsHideTimeout,
			controlsMode,

			truePosition,
			sliderPosition,

			isConnected,
			hasRoomSync,
			connectionStatus,
			connectionStatusColor,
			showDisconnectedOverlay,

			player,
			volume,
			togglePlayback,
			onPlayerApiReady,
			onPlayerReady,
			onPlaybackChange,
			onMediaLoadingState,
			onPlayerRetry,
			playbackPreparationState,
			waitingForPreparedPlayback,
			isCaptionsSupported,
			getCaptionsTracks,

			isMobile,
			queueTab,
			settings: roomSettingsForm,
			addpreview,
			setAddPreviewText,

			currentSource,
			nowPlaying,
			episodeLabel,
			production,
			debugMode,
			orientation: orientation.orientation,

			mediaPlaybackBlocked,
			onClickUnblockPlayback,
			secondsToTimestamp,

			roomVisibilityIcon,
			roomVisibilityLabel,
			onVisibilityClick,

			// MDI Icons
			mdiPlay,
			mdiFormatListBulleted,
			mdiPlus,
			mdiWrench,
			mdiCircle,
		};
	},
});
</script>

<!-- biome-ignore lint/nursery/useScopedStyles: biome migration -->
<style lang="scss">
@use "../variables.scss";

$video-player-max-height: 75vh;
$video-player-max-height-theater: 90vh;
$in-video-chat-width: 400px;
$in-video-chat-width-small: 250px;

.video-container {
	display: grid;
	grid-template-columns: minmax(0, 1fr) auto;
	grid-template-rows: minmax(400px, 70vh);
	width: 100%;
}

.video-subcontainer {
	position: relative;
	display: flex;
	flex-direction: column;
	height: 100%;
	min-width: 0;
	border: 1px solid var(--line-strong);
	border-radius: 8px;
	background: #000;
	box-shadow: var(--shadow-panel);
}

.player-container {
	position: relative;
	flex: 1 1 0;
	min-height: 0;
	width: 100%;
	height: 100%;
	border-radius: inherit;
	overflow: hidden;
}

.layout-default {
	.video-subcontainer {
		width: 80%;
		justify-self: center;

		@media (max-width: variables.$md-max) {
			width: 100%;
		}
	}
}

.layout-theater {
	padding: 0;

	.video-container {
		grid-template-rows: minmax(400px, 85vh);
	}

	.room-title {
		font-size: 24px;
	}
}

.video-subcontainer.player-fullscreen {
	position: fixed;
	inset: 0;
	z-index: 3000;
	width: 100%;
	height: 100vh;
	height: 100dvh;
	max-height: none;
	padding: 0;
	border: 0;
	border-radius: 0;
	background: #000;
	overflow: hidden;
	overscroll-behavior: none;

	.player-container {
		position: relative;
		flex: 1 1 0;
		min-height: 0;
		height: auto;
	}

	.video-controls-wrapper {
		flex: 0 0 auto;
	}

	&.cursor-hidden,
	&.cursor-hidden * {
		cursor: none !important;
	}
}

.in-video-chat {
	z-index: 110;
	padding: 5px 10px;

	position: absolute;
	bottom: var(--player-controls-height, 90px);
	right: 0;
	width: $in-video-chat-width;
	height: 70%;
	max-height: calc(100% - var(--player-controls-height, 90px) - 8px);
	min-height: 70px;
	@media screen and (max-width: variables.$sm-max) {
		width: $in-video-chat-width-small;
	}
	pointer-events: none;
}

.out-video-chat {
	padding: 5px 10px;

	width: $in-video-chat-width;
	height: 300px;
	min-height: 100px;
	@media screen and (max-width: variables.$sm-max) {
		width: $in-video-chat-width-small;
	}
	pointer-events: none;
}

.player-gesture-surface {
	position: absolute;
	inset: 0;
	z-index: 2;
	touch-action: pan-y pinch-zoom;
	user-select: none;
	-webkit-user-select: none;
	-webkit-touch-callout: none;

	&.controls-hidden {
		cursor: none;
	}
}

.player-gesture-hint {
	position: absolute;
	top: 12%;
	left: 50%;
	transform: translateX(-50%);
	z-index: 120;
	max-width: 90%;
	padding: 10px 16px;
	border-radius: 8px;
	background: rgba(0, 0, 0, 0.78);
	color: white;
	text-align: center;
	pointer-events: none;
}

.now-playing {
	position: absolute;
	inset: 0 0 auto;
	z-index: 3;
	display: flex;
	gap: 10px;
	align-items: center;
	padding: max(12px, env(safe-area-inset-top)) 16px 24px;
	background: linear-gradient(rgba(0, 0, 0, 0.75), transparent);
	color: white;
	font-size: clamp(12px, 2.5vw, 16px);
	pointer-events: none;

	> span:first-child,
	strong {
		flex-shrink: 0;
	}
	.now-playing-title {
		overflow: hidden;
		white-space: nowrap;
		text-overflow: ellipsis;
	}
}

.user-invite-container {
	flex: 0 0 340px;
	max-width: 35%;
	min-width: 0;

	> * {
		margin-bottom: 10px;
	}
}

.queue-tab-content {
	// HACK: the save button in room settings is not sticky if overflow is not "visible"
	overflow: visible;
}

.tab-text {
	margin: 0 8px;
}

.playback-blocked-prompt {
	position: absolute;
	top: 0;
	left: 0;
	width: 100%;
	height: 100%;
	z-index: 200;
	display: flex;
	flex-direction: column;
	gap: 12px;
	padding: 20px;
	text-align: center;
	color: white;
	background: rgba(0, 0, 0, 0.6);
	justify-content: center;
	align-items: center;
}

.room-player-loading {
	display: flex;
	align-items: center;
	justify-content: center;
	gap: 12px;
	width: 100%;
	height: 100%;
	min-height: 180px;
}

.flip-list-move {
	transition: transform 0.5s;
}
.no-move {
	transition: transform 0s;
}

.room {
	width: 100%;
	max-width: 1600px;
	margin: 0 auto;
	padding: 24px;
}

.room-header {
	display: flex;
	flex-direction: row;
	flex-wrap: wrap;
	align-items: center;
	gap: 12px;
	margin: 0 0 20px;
	> .grow {
		display: none;
	}
}

.room-title {
	position: relative;
	min-width: 0;
	padding-left: 16px;
	font-size: 30px;
	overflow-wrap: anywhere;

	&::before {
		content: "";
		position: absolute;
		left: 0;
		top: 0.1em;
		bottom: 0.1em;
		width: 4px;
		background: var(--primary);
		box-shadow: 0 0 12px var(--primary);
	}
}

.room-footer {
	max-width: 1552px;
	margin: 40px auto 24px;
	padding-inline: 24px;
}

.overlay-disconnected {
	display: flex;
	flex-direction: column;
	align-items: center;
	justify-content: center;
	width: 100%;
	height: 100%;

	.content {
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		width: 100%;
		height: 100%;
		position: inherit;
	}
}

.banners {
	margin: 10px 0;
}

.grow {
	flex-grow: 1;
}

.under-video-grid {
	display: flex;
	gap: 20px;
	align-items: flex-start;
	width: 100%;

	@media screen and (max-width: variables.$sm-max) {
		flex-direction: column;
	}
}

.under-video-tabs {
	flex: 1 1 0;
	min-width: 0;
	border: 1px solid var(--line);
	border-radius: var(--radius-lg);
	background: var(--card);

	> .v-tabs {
		border-bottom: 1px solid var(--line-strong);
	}

	@media screen and (max-width: variables.$sm-max) {
		width: 100%;
	}
}

.room-status {
	display: flex;
	align-items: center;
	margin-left: auto;
	font-family: var(--font-mono);
	font-size: 12px;
	font-weight: 500;
	white-space: nowrap;
}

.room.layout-theater {
	max-width: none;
	padding: 0;

	.room-header,
	.under-video-grid {
		padding: 16px;
	}
}

@media (max-width: variables.$sm-max) {
	.room {
		padding: 16px 12px;
	}
	.video-container {
		grid-template-columns: minmax(0, 1fr);
		grid-template-rows: minmax(240px, 56.25vw) auto;
	}
	.out-video-chat {
		width: 100%;
	}
	.user-invite-container {
		flex-basis: auto;
		width: 100%;
		max-width: none;
	}
}

@media (max-width: variables.$xs-max) {
	.room-title {
		flex: 1;
		font-size: 21px;
	}
	.room-status {
		width: 100%;
		justify-content: flex-end;
	}
	.room-status .room-visibility-badge {
		margin-right: auto;
	}
	.tab-text {
		margin: 0 4px;
		font-size: 12px;
	}
	.under-video-tabs .v-tab {
		padding: 0 10px;
	}
}
</style>
