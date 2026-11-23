/**
 * hls.js' `maxBufferSize` is not a hard memory cap: the engine derives a length from
 * `8 * maxBufferSize / levelBitrate` and then takes the *larger* of that and
 * `maxBufferLength`. With the old 300 s target and a 20 Mbps rendition, that allowed
 * hundreds of megabytes per video element. This helper turns the byte budget into time
 * targets and keeps both the forward and the backward window inside it.
 */
export interface HlsBufferBudget {
	/** Target forward buffer, in seconds. */
	forwardSeconds: number;
	/** Absolute forward cap; deliberately equal to the target so growth cannot exceed it. */
	maxForwardSeconds: number;
	/** Rewind/dvr retention, in seconds. */
	backSeconds: number;
}

const MIN_FORWARD_SECONDS = 4;
const FALLBACK_BITRATE_BPS = 5_000_000;
const FORWARD_SHARE = 0.6;
const BACK_SHARE = 0.35;

export function hlsBufferBudget(
	configuredSeconds: number,
	maxBytes: number,
	bitrateBps: number,
	backCapSeconds: number,
): HlsBufferBudget {
	const bitrate =
		Number.isFinite(bitrateBps) && bitrateBps > 0 ? bitrateBps : FALLBACK_BITRATE_BPS;
	const budgetSeconds = maxBytes / (bitrate / 8);
	const forward = Math.max(
		MIN_FORWARD_SECONDS,
		Math.min(configuredSeconds, budgetSeconds * FORWARD_SHARE),
	);
	const back = Math.max(0, Math.min(backCapSeconds, budgetSeconds * BACK_SHARE));
	return {
		forwardSeconds: forward,
		maxForwardSeconds: forward,
		backSeconds: back,
	};
}
