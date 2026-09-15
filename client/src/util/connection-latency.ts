/**
 * Round-trip samples from the room connection's latency probes. A room sync message is
 * built at the server's clock and read at ours, so anchoring it at face value leaves this
 * viewer a fixed one-way delay behind the room. The estimate here lets the sync anchor
 * subtract that time, which is what Syncplay's forward-delay compensation does.
 */
const MAX_SAMPLES = 8;
/** Longer than this is congestion or a stalled event loop, not link latency. */
const MAX_PLAUSIBLE_RTT_MS = 5000;
/** Samples older than this describe a connection state that may no longer hold. */
const SAMPLE_MAX_AGE_MS = 180_000;

let samples: number[] = [];
let lastSampleAt = 0;

/** Record one round trip. The smallest of the recent samples rejects jitter spikes. */
export function noteLatencySample(rttMs: number, now = Date.now()) {
	if (!Number.isFinite(rttMs) || rttMs < 0 || rttMs > MAX_PLAUSIBLE_RTT_MS) {
		return;
	}
	samples.push(rttMs);
	if (samples.length > MAX_SAMPLES) {
		samples = samples.slice(-MAX_SAMPLES);
	}
	lastSampleAt = now;
}

/** Half the smallest recent round trip; zero until a probe has been answered. */
export function getOneWayDelayMs(now = Date.now()): number {
	if (samples.length === 0 || now - lastSampleAt > SAMPLE_MAX_AGE_MS) {
		return 0;
	}
	return Math.min(...samples) / 2;
}

export function resetLatencySamples() {
	samples = [];
	lastSampleAt = 0;
}
