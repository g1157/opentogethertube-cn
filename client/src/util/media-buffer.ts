/**
 * A hidden tab usually still plays audio, but nobody sees the picture. Buffering the full
 * configured window there spends bandwidth and memory on frames that were never shown.
 *
 * Kept as a pure function so the HLS and DASH players use the same budget. It is a cap,
 * not a guarantee: the player may already hold more than this when the tab is hidden.
 */
export const HIDDEN_TAB_BUFFER_SECONDS = 60;

export function visibleBufferSeconds(configured: number, hidden: boolean): number {
	return hidden ? Math.min(configured, HIDDEN_TAB_BUFFER_SECONDS) : configured;
}
