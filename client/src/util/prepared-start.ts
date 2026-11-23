import type { PlaybackPreparationState } from "@/util/playback-preparation";

/**
 * A multi-viewer round publishes `playbackPreparation.startAt` about a second ahead, on the
 * server's clock, so every viewer can begin on the same frame. A client that only waits for
 * the later `isPlaying` sync starts when that message happens to arrive, which spreads the
 * group by one round trip each. These helpers turn `startAt` into the local moment to start.
 */
export function preparedStartDelayMs(startAt: number, offsetMs: number, now = Date.now()): number {
	// `startAt` is a server clock instant; the offset is what places it on our clock.
	return Math.max(0, Math.round(startAt - offsetMs - now));
}

/**
 * Whether this viewer may begin the round itself. It has to be the round it acknowledged
 * (the preparation engine reached `waiting-ack`), the round has to have a scheduled start,
 * and a measured offset has to place that start on our clock. Without an offset — an older
 * server that shares no clock, or no answered probe yet — the old "start when `isPlaying`
 * arrives" behaviour is the only safe one.
 */
export function canStartPreparedLocally(
	phase: PlaybackPreparationState["phase"],
	startAt: number | null | undefined,
	offsetMs: number | null,
): boolean {
	return (
		phase === "waiting-ack" &&
		typeof startAt === "number" &&
		Number.isFinite(startAt) &&
		offsetMs !== null &&
		Number.isFinite(offsetMs)
	);
}
