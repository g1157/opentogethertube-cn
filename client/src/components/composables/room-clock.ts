import { onMounted, onUnmounted, ref } from "vue";
import clamp from "lodash/clamp";

/** The room clock ticks at 4 Hz, the rate the progress bar and drift correction follow. */
export const ROOM_CLOCK_INTERVAL_MS = 250;

export interface RoomClockOptions {
	/**
	 * Runs before the position is read on every tick. Reading the server clock offset also
	 * runs its clock-step guard, so a correction is applied to this tick's position instead
	 * of only being noticed by the next probe reply, up to a probe interval later.
	 */
	beforeTick?(): void;
	/** Current room position in seconds, from the store's playback start and speed. */
	roomPosition(): number;
	/** Length of the playable range in seconds, or null while it is unknown. */
	getLength(): number | null;
	/** Target of the in-flight local seek, if any. */
	getPendingSeekTarget(): number | null;
	/**
	 * Everything else that follows the clock. Returns whether it already applied the room's
	 * playback state, so a caller that would apply it too can skip the duplicate.
	 */
	onTick(): boolean;
}

/**
 * The room's position clock: `truePosition` follows the room, `sliderPosition` the progress
 * bar, which shows the target of an in-flight seek at once instead of waiting out the round
 * trip. The interval lives exactly as long as the room view.
 */
export function useRoomClock(options: RoomClockOptions) {
	const truePosition = ref(0);
	const sliderPosition = ref(0);
	let interval: ReturnType<typeof setInterval> | null = null;

	function tick(): boolean {
		options.beforeTick?.();
		truePosition.value = options.roomPosition();
		sliderPosition.value = clamp(
			options.getPendingSeekTarget() ?? truePosition.value,
			0,
			options.getLength() ?? 0,
		);
		return options.onTick();
	}

	function start() {
		if (interval === null) {
			interval = setInterval(tick, ROOM_CLOCK_INTERVAL_MS);
		}
	}

	function stop() {
		if (interval !== null) {
			clearInterval(interval);
			interval = null;
		}
	}

	onMounted(start);
	onUnmounted(stop);

	return { truePosition, sliderPosition, tick, start, stop };
}
