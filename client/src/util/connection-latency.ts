/**
 * Round-trip samples from the room connection's latency probes. A room sync message is
 * built at the server's clock and read at ours, so anchoring it at face value leaves this
 * viewer a fixed one-way delay behind the room. The estimate here lets the sync anchor
 * subtract that time, which is what Syncplay's forward-delay compensation does.
 *
 * A server that sends its own clock in the reply also lets us measure the offset between
 * the two clocks, so a sync no longer has to be anchored at the moment it was read at all.
 */
const MAX_SAMPLES = 8;
/** Longer than this is congestion or a stalled event loop, not link latency. */
const MAX_PLAUSIBLE_RTT_MS = 5000;
/** Samples older than this describe a connection state that may no longer hold. */
const SAMPLE_MAX_AGE_MS = 180_000;
/** A local clock that jumped further than this makes every measured offset wrong. */
const MAX_CLOCK_STEP_MS = 200;
/**
 * How long the room clock stays untrusted after such a jump while a fresh probe is on its
 * way. Bounded so a server that never answers cannot freeze correction for good.
 */
const CLOCK_UNCERTAIN_MS = 5000;

export interface LatencySample {
	rttMs: number;
	/** Server clock minus our clock; null when the server did not share its time. */
	offsetMs: number | null;
	/** Wall clock when the sample was taken; every sample expires on its own. */
	at: number;
}

/** A new sample arrived, or the samples were dropped because the local clock stepped. */
export type ServerClockEvent = "sample" | "reset";
type ServerClockListener = (event: ServerClockEvent) => void;

let samples: LatencySample[] = [];
/**
 * Monotonic deadline of the window after a detected clock jump in which nothing derived
 * from the wall clock can be trusted; null outside it. See isServerClockUncertain().
 */
let uncertainUntil: number | null = null;
/** `Date.now() − performance.now()` when the newest sample was taken; see the guard. */
let newestClockSkew: number | null = null;
let listeners: ServerClockListener[] = [];

/** The wall clock minus the monotonic one: only a clock step or a sleep moves this. */
function clockSkewNow(): number {
	return Date.now() - performance.now();
}

function notify(event: ServerClockEvent) {
	for (const listener of [...listeners]) {
		listener(event);
	}
}

function activeSamples(now: number): LatencySample[] {
	return samples.filter(sample => now - sample.at <= SAMPLE_MAX_AGE_MS);
}

/** The offset of the sample with the smallest round trip, i.e. the least uncertain one. */
function bestOffsetMs(now: number): number | null {
	let best: LatencySample | null = null;
	for (const sample of activeSamples(now)) {
		if (sample.offsetMs === null) {
			continue;
		}
		if (best === null || sample.rttMs < best.rttMs) {
			best = sample;
		}
	}
	return best === null ? null : best.offsetMs;
}

/**
 * A clock step (an NTP correction, a manual change) or a machine that slept invalidates
 * the mapping the offsets were measured against, so the samples are dropped and whoever
 * knows about the connection is asked to measure again straight away.
 *
 * The two causes cannot be told apart from here, and they need opposite corrections: after
 * a wall-clock step the old offset is wrong by the step, while after a sleep on a platform
 * whose monotonic clock stops (everything but Windows) the old offset is still right and
 * "adjusting" it would be wrong by the whole sleep. So no offset is reported at all until a
 * probe has been answered, and the window is flagged so the caller can hold off acting on
 * a room position it cannot trust.
 */
function dropSamplesIfClockStepped() {
	if (newestClockSkew === null || samples.length === 0) {
		return;
	}
	if (Math.abs(clockSkewNow() - newestClockSkew) <= MAX_CLOCK_STEP_MS) {
		return;
	}
	const hadOffset = samples.some(sample => sample.offsetMs !== null);
	samples = [];
	newestClockSkew = null;
	if (hadOffset) {
		uncertainUntil = performance.now() + CLOCK_UNCERTAIN_MS;
	}
	notify("reset");
}

/**
 * Record one round trip. The smallest of the recent samples rejects jitter spikes.
 * `offsetMs` comes from a reply that carried the server's clock; omit it for an older
 * server that only echoes the probe.
 */
export function noteLatencySample(rttMs: number, now = Date.now(), offsetMs: number | null = null) {
	if (!Number.isFinite(rttMs) || rttMs < 0 || rttMs > MAX_PLAUSIBLE_RTT_MS) {
		return;
	}
	if (offsetMs !== null && !Number.isFinite(offsetMs)) {
		return;
	}
	// A sample taken after a clock step must not sit next to the ones from before it: the
	// older offsets describe the previous mapping, and one of them with a shorter round trip
	// would keep winning the min-RTT pick for as long as it lives.
	dropSamplesIfClockStepped();
	samples.push({ rttMs, offsetMs, at: now });
	if (samples.length > MAX_SAMPLES) {
		samples = samples.slice(-MAX_SAMPLES);
	}
	if (offsetMs !== null) {
		// A fresh measurement against the clock as it is now ends the uncertainty.
		uncertainUntil = null;
	}
	newestClockSkew = clockSkewNow();
	notify("sample");
}

/** Half the smallest recent round trip; zero until a probe has been answered. */
export function getOneWayDelayMs(now = Date.now()): number {
	const rtt = getRttEstimateMs(now);
	return rtt === null ? 0 : rtt / 2;
}

/** Smallest recent round trip, or null before a probe / after every sample expired. */
export function getRttEstimateMs(now = Date.now()): number | null {
	const active = activeSamples(now);
	if (active.length === 0) {
		return null;
	}
	return Math.min(...active.map(sample => sample.rttMs));
}

/**
 * How far the server's clock is ahead of ours, so `Date.now() + offset` is the server's
 * clock and `serverTime − offset` is the local instant a sync describes. Null until a
 * reply has carried the server's time, after every sample has expired, and between a local
 * clock jump and the next answered probe; callers then fall back to arrival-time anchoring,
 * which does not depend on the two clocks agreeing.
 */
export function getServerClockOffsetMs(now = Date.now()): number | null {
	dropSamplesIfClockStepped();
	return bestOffsetMs(now);
}

/**
 * True between a detected local clock jump and the next answered probe (at most
 * CLOCK_UNCERTAIN_MS). The room position computed from the wall clock may be off by the
 * whole jump in that window, so drift correction should wait instead of seeking to it.
 */
export function isServerClockUncertain(): boolean {
	dropSamplesIfClockStepped();
	if (uncertainUntil === null) {
		return false;
	}
	if (performance.now() >= uncertainUntil) {
		uncertainUntil = null;
		return false;
	}
	return true;
}

/** Notified whenever the estimate changes or is invalidated. Returns an unsubscribe. */
export function subscribeServerClock(listener: ServerClockListener): () => void {
	listeners = [...listeners, listener];
	return () => {
		listeners = listeners.filter(entry => entry !== listener);
	};
}

export function resetLatencySamples() {
	samples = [];
	uncertainUntil = null;
	newestClockSkew = null;
}
