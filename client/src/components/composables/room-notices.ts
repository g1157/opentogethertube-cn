import { onUnmounted, ref } from "vue";
import type { LevelSide } from "@/util/player-gestures";
import type { usePlayerBrightness } from "@/util/player-brightness";

/** How long a one-off interaction message (a denied action, a busy gesture) stays up. */
export const INTERACTION_NOTICE_MS = 2000;
/** How long the brightness/volume read-out stays up after the finger leaves. */
export const LEVEL_NOTICE_MS = 800;

type Translate = (key: string, named?: Record<string, unknown>) => string;

export interface RoomNoticesOptions {
	t: Translate;
	/** Simulated panel brightness, shared with the scrim and the swipe levels. */
	brightness: ReturnType<typeof usePlayerBrightness>;
	/** Current settings volume, as a percentage. */
	getVolume(): number;
	/** Commit the already clamped percentage back to settings. */
	setVolume(percent: number): void;
}

/**
 * The gesture read-outs: one-off interaction messages for actions the room or the browser
 * refused, and the fullscreen swipe levels (left dims the picture, right moves the volume,
 * the way phone players do it). Both are transient, so they live here with their timers.
 */
export function useRoomNotices(options: RoomNoticesOptions) {
	const interactionNotice = ref("");
	const levelNotice = ref("");
	let noticeTimer: ReturnType<typeof setTimeout> | null = null;
	let levelTimer: ReturnType<typeof setTimeout> | null = null;

	function showInteractionNotice(key: string) {
		interactionNotice.value = options.t(`player.interactions.${key}`);
		if (noticeTimer !== null) {
			clearTimeout(noticeTimer);
		}
		noticeTimer = setTimeout(() => {
			interactionNotice.value = "";
		}, INTERACTION_NOTICE_MS);
	}

	function onLevelStart() {
		if (levelTimer !== null) {
			clearTimeout(levelTimer);
			levelTimer = null;
		}
	}

	function onLevelMove(side: LevelSide, delta: number) {
		// A full-height drag moves the level through its whole range; the clamp discards
		// any overshoot instead of making the user undo it before the value comes back.
		if (side === "left") {
			options.brightness.setBrightness(options.brightness.brightness.value + delta);
			levelNotice.value = options.t("player.interactions.level-brightness", {
				value: Math.round(options.brightness.brightness.value * 100),
			});
		} else {
			const next = options.getVolume() / 100 + delta;
			options.setVolume(Math.round(Math.min(1, Math.max(0, next)) * 100));
			levelNotice.value = options.t("player.interactions.level-volume", {
				value: Math.round(options.getVolume()),
			});
		}
	}

	function onLevelEnd() {
		if (levelTimer !== null) {
			clearTimeout(levelTimer);
		}
		levelTimer = setTimeout(() => {
			levelTimer = null;
			levelNotice.value = "";
		}, LEVEL_NOTICE_MS);
	}

	onUnmounted(() => {
		if (noticeTimer !== null) {
			clearTimeout(noticeTimer);
			noticeTimer = null;
		}
		if (levelTimer !== null) {
			clearTimeout(levelTimer);
			levelTimer = null;
		}
	});

	return {
		interactionNotice,
		levelNotice,
		showInteractionNotice,
		onLevelStart,
		onLevelMove,
		onLevelEnd,
	};
}
