import { calculateCurrentPosition } from "ott-common/timestamp";
import type { RoomState } from "@/stores/room";

/**
 * Where this client should begin loading: the room's current position when it is playing,
 * the saved position when it is paused, and the recovery snapshot as a last resort.
 *
 * A live source returns null. The room clock describes a VOD timeline, while a live window
 * slides on its own; an offset taken from the room would open the player minutes behind the
 * edge (or in a hole the window no longer holds), so live keeps the player's default.
 */
export function roomStartPosition(room: RoomState, recoveryPosition = 0): number | null {
	if (room.currentSource?.isLive === true) {
		return null;
	}
	const position =
		room.isPlaying && room.playbackStartTime
			? calculateCurrentPosition(
					room.playbackStartTime,
					Date.now(),
					room.playbackPosition,
					room.playbackSpeed,
				)
			: room.playbackPosition || recoveryPosition;
	return Number.isFinite(position) ? Math.max(0, position) : null;
}
