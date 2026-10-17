/** A duration the player can honestly show: finite, positive, and actually known. */
export function isUsableDuration(value: number | null | undefined): value is number {
	return typeof value === "number" && Number.isFinite(value) && value > 0;
}

/**
 * The length the player UI runs on: the server-provided length wins, and the locally
 * measured media duration fills in when it is missing (a failed metadata probe queues a
 * direct link with an unknown length). The local value never leaves the client.
 */
export function resolveVideoLength(
	sourceLength: number | null | undefined,
	playerDuration: number | null | undefined,
): number | null {
	if (isUsableDuration(sourceLength)) {
		return sourceLength;
	}
	if (isUsableDuration(playerDuration)) {
		return playerDuration;
	}
	return null;
}
