import { computed, onMounted, onUnmounted, watch, type Ref } from "vue";
import type { Store } from "vuex";
import { TEMPORARY_PLAYBACK_SPEED } from "ott-common/constants";
import type { PermissionName } from "ott-common/permissions";
import type { QueueItem } from "ott-common/models/video";
import type { FullOTTStoreState } from "@/store";
import type { useRoomApi } from "@/util/roomapi";
import { createPlayerGestures } from "@/util/player-gestures";
import type { usePlayerBrightness } from "@/util/player-brightness";
import { useTemporaryPlaybackSpeed } from "@/util/temporary-playback-speed";
import { secondsToTimestamp } from "@/util/timestamp";
import type { useRoomNotices } from "./room-notices";

type Translate = (key: string, named?: Record<string, unknown>) => string;

export interface RoomGesturesOptions {
	getPosition(): number;
	getBounds(): { start: number; end: number } | null;
	granted(permission: PermissionName): boolean;
	connected: Ref<boolean>;
	store: Store<FullOTTStoreState>;
	requestRoomSeek(position: number): void;
	/** Fullscreen toggle for a double click on the picture. */
	toggleFullscreen(): void;
	onTap(): void;
	onDoubleTap(): void;
	/** Room playing and not blocked locally; a hold only previews speed while it plays. */
	isPlaying(): boolean;
	mediaPlaybackBlocked(): boolean;
	availablePlaybackRates(): readonly number[];
	roomapi: ReturnType<typeof useRoomApi>;
	currentSource: Ref<QueueItem | null>;
	/** The one brightness instance of the room; the scrim, the swipe and the read-out share it. */
	brightness: ReturnType<typeof usePlayerBrightness>;
	t: Translate;
	/** Transient read-outs for denied actions and the swipe levels. */
	notices: ReturnType<typeof useRoomNotices>;
	/** Controls react to a source change the way they react to a tap. */
	activateControls(): void;
	/** Mouse right-click on the picture; touch suppresses it for the long-press hold. */
	onContextMenu(): void;
	/** Called after a visibility change cancelled the gestures. */
	onVisibilityChange?(): void;
}

/**
 * Touch gestures on the picture and the keyboard/touch hold-to-play-fast gesture they share.
 * The gesture state machine itself is `util/player-gestures`; this wires it to the room's
 * permissions, clock, temporary speed request and fullscreen brightness/volume levels, and
 * owns the window listeners that have to cancel a gesture the page can no longer follow.
 */
export function useRoomGestures(options: RoomGesturesOptions) {
	const { notices } = options;
	const temporarySpeed = useTemporaryPlaybackSpeed({
		connected: () => options.connected.value,
		clientId: () => options.store.state.users.you.id,
		currentVideo: () => options.currentSource.value,
		roomGesture: () => options.store.state.room.temporaryPlaybackSpeed,
		canStart: () => {
			if (!options.granted("playback.speed")) {
				notices.showInteractionNotice("speed-denied");
				return false;
			}
			if (options.store.state.room.temporaryPlaybackSpeed) {
				notices.showInteractionNotice("speed-busy");
				return false;
			}
			if (
				!options.store.state.room.isPlaying ||
				options.mediaPlaybackBlocked() ||
				!options.getBounds() ||
				!options.availablePlaybackRates().includes(TEMPORARY_PLAYBACK_SPEED)
			) {
				notices.showInteractionNotice("speed-unavailable");
				return false;
			}
			return true;
		},
		send: (action, id, video) => options.roomapi.temporaryPlaybackRate(action, id, video),
		onRejected: () => notices.showInteractionNotice("speed-unavailable"),
	});
	// Fullscreen swipe levels: the left half dims the picture, the right half moves the
	// volume, the way phone players do it. The gesture reports increments, so the finger
	// can keep pulling in either direction without the screen edge being a limit.
	const playerBrightness = options.brightness;
	const gestures = createPlayerGestures({
		getPosition: options.getPosition,
		getBounds: options.getBounds,
		getSeekStep: () => options.store.state.settings.seekSeconds,
		canSeek: () => options.connected.value && options.granted("playback.seek"),
		isPlaying: options.isPlaying,
		onTap: options.onTap,
		onDoubleTap: options.onDoubleTap,
		onDoubleClick: () => {
			options.toggleFullscreen();
		},
		onSeek: position => {
			options.requestRoomSeek(position);
		},
		onSeekDenied: () => notices.showInteractionNotice("seek-denied"),
		onHoldStart: temporarySpeed.start,
		onHoldEnd: temporarySpeed.stop,
		canAdjustLevels: () => options.store.state.fullscreen,
		onLevelStart: notices.onLevelStart,
		onLevelMove: notices.onLevelMove,
		onLevelEnd: notices.onLevelEnd,
	});
	/** Black scrim over the picture standing in for the screen's own brightness. */
	const dimmerOpacity = playerBrightness.dimmerOpacity;
	// Android's long-press fires contextmenu while the hold gesture is already showing
	// the 2x preview, and both used to run at once: the details panel opened on top of
	// it. Touch keeps the hold gesture (the panel stays reachable from the settings
	// menu); right-click is a mouse shortcut.
	let surfacePointerType = "mouse";
	function onSurfacePointerDown(event: PointerEvent) {
		surfacePointerType = event.pointerType || "mouse";
		gestures.pointerDown(event);
	}
	function onSurfaceContextMenu(event: MouseEvent) {
		if (((event as PointerEvent).pointerType || surfacePointerType) === "touch") {
			return;
		}
		options.onContextMenu();
	}
	const gestureHint = computed(() => {
		if (notices.levelNotice.value) {
			return notices.levelNotice.value;
		}
		if (notices.interactionNotice.value) {
			return notices.interactionNotice.value;
		}
		if (gestures.preview.value) {
			const { position, delta } = gestures.preview.value;
			return options.t("player.interactions.seek-preview", {
				delta: `${delta >= 0 ? "+" : ""}${Math.round(delta)}`,
				time: secondsToTimestamp(position),
			});
		}
		if (options.store.state.room.temporaryPlaybackSpeed) {
			return options.t(
				temporarySpeed.gestureId.value ===
					options.store.state.room.temporaryPlaybackSpeed.gestureId
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
		options.onVisibilityChange?.();
	}
	watch(options.currentSource, () => {
		cancelGestures();
		options.activateControls();
	});
	watch(
		() => options.store.state.room.isPlaying,
		playing => {
			if (!playing) {
				cancelGestures();
			}
		},
	);
	watch(options.connected, connected => {
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
		document.removeEventListener("visibilitychange", onVisibilityChange);
		window.removeEventListener("blur", cancelGestures);
		window.removeEventListener("pagehide", cancelGestures);
	});

	return {
		gestures,
		gestureHint,
		dimmerOpacity,
		onSurfacePointerDown,
		onSurfaceContextMenu,
		cancelGestures,
		temporarySpeed,
		playerBrightness,
	};
}
