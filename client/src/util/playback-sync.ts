import {
	PLAYBACK_DRIFT_BUCKET_SECONDS,
	PLAYBACK_INITIAL_MAX_DRIFT_SECONDS,
	PLAYBACK_INITIAL_SYNC_COOLDOWN_MS,
	PLAYBACK_MIN_SEEK_BUFFER_SECONDS,
} from "ott-common/constants";

interface PlaybackSyncState {
	source: object | null;
	player: object | null;
	ready: boolean;
	error: boolean;
	blocked: boolean;
	seeking: boolean;
	recovering: boolean;
	buffering: boolean;
	bufferAhead?: number | null;
	/** Live sources follow their own edge; the VOD room clock must not seek them. */
	live?: boolean;
	playing: boolean;
	temporarySpeed?: boolean;
	position: number;
}

interface PlaybackSyncOptions {
	getState(): PlaybackSyncState;
	getPosition(): number | Promise<number>;
	setPosition(position: number): void | Promise<void>;
	/** Null for players with discrete rates (YouTube/PeerTube) or no rate setter (Vimeo). */
	getBendBase?(): number | null;
	setLocalRate?(rate: number): void | Promise<void>;
	/**
	 * Toggles the browser's pitch-preserving time-stretch. The micro band plays resampled:
	 * Chromium's own media code notes that WSOLA time-stretching warbles most close to 1.0,
	 * while resampling is clean but shifts pitch, which costs nothing for a few percent on a
	 * drift too small to hear as a tempo change. Return false when the element cannot switch,
	 * which disables the micro band entirely.
	 */
	setPreservesPitch?(preserve: boolean): boolean | void;
	/**
	 * Starting latency estimates for the seek lead, in seconds. The first seek after a reset
	 * pays for a cold load of a new source; every later seek only pays for the fetch of the
	 * region it jumps into. Overridable so tests about something other than the lead can pin
	 * it to zero.
	 */
	initialSeekLeadSeconds?: { load: number; seek: number };
	/**
	 * The last position a seek may target (the media's end or its trim), or null when it is
	 * unknown. A predicted target past it would be clamped by the element, and the native
	 * seek hold would then wait for a position the media does not have.
	 */
	getSeekLimit?(): number | null;
	/** The slow-device A/B switch; false makes the engine behave like a player that
	 * cannot change rates (coarser seeks instead of a continuously re-timed bend). */
	allowRateBend?(): boolean;
	/**
	 * A player whose seek is a reload or an imprecise estimate (YouTube, Vimeo, PeerTube,
	 * Bilibili) must not be nudged for sub-second drift: each correction is far more
	 * disruptive than the drift. Native media can seek cheaply, so it gets the tight limit.
	 */
	seekIsExpensive?(): boolean;
	onError(error: unknown): void;
}

export interface PlaybackSyncMetrics {
	/** Rate writes actually sent to the player (the diagnosis for "4 Hz re-timing"). */
	rateWrites: number;
	/** Bend deadlines that expired into a visible seek. */
	deadlineSeeks: number;
	/** Largest absolute drift seen since the counters last reset. Bending only engages
	 * past 0.3s, so this says whether the field even reaches that zone. */
	maxAbsDrift: number;
	/** Seconds spent with |drift| in each bucket of PLAYBACK_DRIFT_BUCKET_SECONDS, so a
	 * session that sat 20ms off throughout is distinguishable from one that sat 280ms off. */
	driftSeconds: number[];
	/** Seconds during which a rate bend (or the micro band) was actually applied. */
	bendSeconds: number;
	/** Current lead added to a seek target after the first one, in seconds. */
	seekLeadSeconds: number;
	/** Current lead added to the first seek after a reset (cold load), in seconds. */
	loadLeadSeconds: number;
}

interface SeekRequestOptions {
	/**
	 * A room sync only needs a hard seek when the drift is too large for the rate bend.
	 * Explicit seeks (user gestures, unblocking) keep seeking immediately.
	 */
	tolerateSmallDrift?: boolean;
}

// Engineering starting points aligned with what Syncplay and Jellyfin ship, not an
// industry standard. See docs/playback-sync.zh-CN.md.
const BEND_START = 0.3;
const BEND_STOP = 0.15;
/** Ceiling inside the gentle zone; an 8% rate change is not noticeable on speech or video. */
const MAX_BEND = 0.08;
/** Only a seek can close more than this; below it a rate change recovers the drift. */
const HARD_SEEK_DRIFT = 3;
/** Drift that turns the gentle bend into a deliberate catch-up. */
const CATCHUP_FULL = 1;
/**
 * Catch-up ceiling. Jellyfin runs `1 + drift/1000` (up to 4x) for the same window and
 * Syncplay slows a fixed 5%; 15% stays under the point where speech or music tempo is
 * distracting while still recovering seconds of drift in tens of seconds.
 */
const CATCHUP_MAX_BEND = 0.15;
const BEND_DEADLINE_MS = 8000;
/** A catch-up that cannot converge inside this long is worth one visible seek after all. */
const MAX_BEND_DEADLINE_MS = 30000;
const RATE_WRITE_THRESHOLD = 0.002;
/** Non-bend drift a cheap native seek may correct; also the sync path's old dead band. */
const CHEAP_SEEK_DRIFT = BEND_START;
/** Embedded players seek by reload/estimation; only a visible drift is worth that. */
const EXPENSIVE_SEEK_DRIFT = 1;
/**
 * A paused native element has no audio pipeline running, so placing it on the room's exact
 * frame costs nothing. Without this, every viewer froze wherever its own element was (up to
 * the 300ms dead band apart) and the room never showed the same frame twice.
 */
const PAUSED_FRAME_DRIFT = 0.04;
/**
 * Longest gap a single drift observation may be credited with. A throttled background tab or
 * a stalled timer otherwise turns minutes of wall clock into "minutes of perfect sync".
 */
const MAX_OBSERVATION_STEP_SECONDS = 1;
/**
 * A hard seek while the room plays targets the room position plus the time the player needs to
 * fetch, decode and resume. Without it every seek leaves the viewer behind by exactly that
 * latency and the bend spends the next 10-20s at 8-15% recovering it.
 */
// Starting points before a device has taught the engine its own latency. Deliberately on the
// low side: an overestimate leaves the viewer ahead of the room, which only a slow-down can
// undo, while an underestimate is the lag the engine always had.
const DEFAULT_LOAD_LEAD_SECONDS = 0.5;
const DEFAULT_SEEK_LEAD_SECONDS = 0.3;
/** An estimate outside this range is a measurement error, not a slow device. */
const MAX_SEEK_LEAD_SECONDS = 3;
/** Fraction of the observed prediction error applied to the estimate. */
const LEAD_CORRECTION = 0.5;
/**
 * Fine band below the bend start: two viewers could otherwise sit 300ms apart forever, and the
 * bend's own 150ms stop left its residual uncorrected. Small enough that 1-2% of rate is not
 * heard as a tempo change.
 */
const MICRO_START = 0.06;
const MICRO_STOP = 0.02;
/** Quantisation of the micro rate offset; rewriting the rate every tick is audible. */
const MICRO_STEP = 0.005;
const MICRO_MAX_OFFSET = 0.02;
/** |drift| that saturates the band: 0.08s of drift is the largest micro correction worth it. */
const MICRO_DRIFT_FULL = 4;
/** Consecutive observations needed before a noisy read may start the micro band. */
const MICRO_WINDOW = 3;

/**
 * The one passive policy shared by the periodic tick and the room-sync path. A rate bend
 * absorbs seconds of drift while playing; when it is unavailable, a paused native element
 * gets one frame, other native media keeps its 300ms dead band, and an embedded player
 * keeps the 1s one it always had in the tick.
 */
function passiveSeekLimit(
	canBend: boolean,
	initialSync: boolean,
	seekIsExpensive: boolean,
	pausedNative: boolean,
): number {
	if (canBend) {
		return initialSync ? PLAYBACK_INITIAL_MAX_DRIFT_SECONDS : HARD_SEEK_DRIFT;
	}
	if (pausedNative) {
		return PAUSED_FRAME_DRIFT;
	}
	return seekIsExpensive ? EXPENSIVE_SEEK_DRIFT : CHEAP_SEEK_DRIFT;
}

/**
 * The rate ceiling for a drift: 8% inside the gentle zone, growing linearly once a full
 * second has to be recovered. Only drifts past HARD_SEEK_DRIFT are seeked instead.
 */
function bendCeiling(magnitude: number): number {
	if (magnitude <= CATCHUP_FULL) {
		return MAX_BEND;
	}
	const progress = Math.min(magnitude, HARD_SEEK_DRIFT) - CATCHUP_FULL;
	return MAX_BEND + (progress / (HARD_SEEK_DRIFT - CATCHUP_FULL)) * (CATCHUP_MAX_BEND - MAX_BEND);
}

/** How long the ceiling may take to converge, with slack before falling back to a seek. */
function bendDeadlineMs(magnitude: number, ceiling: number): number {
	const needed = (magnitude / ceiling) * 1000 * 1.25;
	return Math.min(MAX_BEND_DEADLINE_MS, Math.max(BEND_DEADLINE_MS, needed));
}

/** A configured or default lead, kept inside the range a real device can produce. */
function leadOrDefault(value: number | undefined, fallback: number): number {
	const lead = value ?? fallback;
	return Number.isFinite(lead) ? Math.min(MAX_SEEK_LEAD_SECONDS, Math.max(0, lead)) : fallback;
}

/**
 * Micro offsets are quantised to MICRO_STEP so the rate is written once per audible step
 * instead of once per 250ms tick. Rounding is half up: |drift| / 4 clamped to 0.005-0.02,
 * divided by the step and rounded (0.03s -> 0.0075 -> 2 steps -> 0.01). The epsilon keeps a
 * binary 2.4999999999999996 from rounding the wrong way (0.05s -> 0.015, not 0.01).
 */
function quantiseMicroOffset(drift: number): number {
	const size = Math.min(
		MICRO_MAX_OFFSET,
		Math.max(MICRO_STEP, Math.abs(drift) / MICRO_DRIFT_FULL),
	);
	const steps = Math.round(size / MICRO_STEP + 1e-9);
	return Math.sign(drift) * Math.min(MICRO_MAX_OFFSET / MICRO_STEP, steps) * MICRO_STEP;
}

/** Give each range request time to finish; room seeks always take priority over drift correction. */
export function createPlaybackSync(options: PlaybackSyncOptions) {
	let source: object | null = null;
	let player: object | null = null;
	let generation = 0;
	let lastSeekAt = -Infinity;
	let bufferedSinceLastSeek = false;
	let initialSyncUntil = 0;
	let pendingSeek = false;
	let pendingSeekToleratesDrift = false;
	let pendingSeekReason = "";
	let inFlight: symbol | null = null;
	let disposed = false;
	let bendStartedAt: number | null = null;
	let bendBase: number | null = null;
	/** Signed rate offset held for the whole bend, so playbackRate is not rewritten every tick. */
	let bendOffset: number | null = null;
	let appliedRate: number | null = null;
	/** Largest drift seen during the current bend; the deadline follows the catch-up size. */
	let bendPeak = 0;
	let bendDeadlineAt = 0;
	/** The room position a paused correction already targeted, so one attempt is the limit. */
	let pausedSeekTarget: number | null = null;
	/**
	 * Latency estimates for a seek target. They survive reset(): a new source on the same
	 * device is as slow as the last one, so only the "cold load" estimate has to be
	 * re-learned per source.
	 */
	const seekLeadSeconds = {
		load: leadOrDefault(options.initialSeekLeadSeconds?.load, DEFAULT_LOAD_LEAD_SECONDS),
		seek: leadOrDefault(options.initialSeekLeadSeconds?.seek, DEFAULT_SEEK_LEAD_SECONDS),
	};
	/** The next lead-bearing seek is the cold one that follows a reset(). */
	let coldSeekPending = true;
	/** Which estimate the in-flight seek used, so the next observation can correct exactly it. */
	let pendingSeekLead: "load" | "seek" | null = null;
	/** The micro band's rate offset, held until its quantised value changes. */
	let microActive = false;
	let microOffset: number | null = null;
	let microBase: number | null = null;
	/** Signed drifts of the last consecutive observations, for the micro band's entry rule. */
	let microWindow: number[] = [];
	let microWindowSequence = -1;
	/** What the element's pitch preservation is set to; null when unknown after a reset. */
	let appliedPreservesPitch: boolean | null = null;
	/** A player that cannot switch pitch preservation keeps the pre-micro behaviour. */
	let pitchUnsupported = false;
	let rateWrites = 0;
	let deadlineSeeks = 0;
	let maxAbsDrift = 0;
	const driftSeconds: number[] = PLAYBACK_DRIFT_BUCKET_SECONDS.map(() => 0);
	let bendSeconds = 0;
	/**
	 * Drift is credited for the gap between two consecutive observations. Every tick takes the
	 * next sequence number, so a tick that could not observe (paused, buffering, seeking, a
	 * pending read) leaves a hole and the next observation starts a fresh chain instead of
	 * crediting time the room did not actually spend playing.
	 */
	let tickSequence = 0;
	let lastObservationSequence = -1;
	let lastObservationAt = 0;

	function getBendBase() {
		// The diagnostic switch in the playback details panel turns the engine into a
		// player without a rate setter, so an A/B can compare the same clip with and
		// without the continuous re-timing.
		if (options.allowRateBend && !options.allowRateBend()) {
			return null;
		}
		const base = options.getBendBase?.();
		return options.setLocalRate && base != null && Number.isFinite(base) && base > 0
			? base
			: null;
	}

	/**
	 * The room's own speed, whether or not this viewer lets the engine bend it. Seek
	 * prediction and "what rate does the room expect" must not change with a correction
	 * preference; only the corrections themselves do.
	 */
	function roomSpeed(): number | null {
		const base = options.getBendBase?.();
		return base != null && Number.isFinite(base) && base > 0 ? base : null;
	}

	function writeRate(rate: number) {
		if (appliedRate !== null && Math.abs(rate - appliedRate) <= RATE_WRITE_THRESHOLD) {
			return;
		}
		appliedRate = rate;
		rateWrites++;
		const currentGeneration = generation;
		const failed = (error: unknown) => {
			if (!disposed && currentGeneration === generation) {
				appliedRate = null;
				options.onError(error);
			}
		};
		try {
			// Native setters also update recovery snapshots. Never write the shared UI rate ref.
			const result = options.setLocalRate?.(rate);
			if (result) {
				return result.catch(failed);
			}
		} catch (error) {
			failed(error);
		}
	}

	/**
	 * Returns whether the element accepted the request. A player that does not implement the
	 * setter, or reports that its element has no `preservesPitch`, leaves the micro band off:
	 * without resampling, a 1-2% rate change is exactly where time-stretch artifacts peak.
	 */
	function applyPreservesPitch(preserve: boolean): boolean {
		if (appliedPreservesPitch === preserve) {
			return true;
		}
		const setter = options.setPreservesPitch;
		if (!setter) {
			pitchUnsupported = true;
			return false;
		}
		let supported = true;
		try {
			supported = setter(preserve) !== false;
		} catch {
			// An element that throws on the property simply keeps preserving pitch.
			supported = false;
		}
		if (!supported) {
			pitchUnsupported = true;
			appliedPreservesPitch = null;
			return false;
		}
		appliedPreservesPitch = preserve;
		return true;
	}

	function cancelBend() {
		if (bendStartedAt !== null) {
			// The speed the room has now, not the one the bend started from: a room speed
			// change is applied to the element before this runs, and must not be undone.
			const base = roomSpeed() ?? bendBase;
			if (base !== null) {
				void writeRate(base);
			}
		}
		bendStartedAt = null;
		bendBase = null;
		bendOffset = null;
		bendPeak = 0;
		bendDeadlineAt = 0;
		appliedRate = null;
	}

	/**
	 * The micro band shares the element's rate with the bend, so every interrupt that ends a
	 * bend has to end it too: restore the base rate and the element's pitch preservation.
	 */
	function cancelMicroBend() {
		const wasActive = microActive;
		const base = microBase;
		microActive = false;
		microOffset = null;
		microBase = null;
		if (!wasActive) {
			return;
		}
		// Restore the speed the room has now. The band only starts at a room speed of 1, but
		// it is often ended by a speed change (a temporary 2x gesture, the speed menu) that
		// the player has already applied; writing the old base back would silently undo it.
		void writeRate(roomSpeed() ?? base ?? 1);
		applyPreservesPitch(true);
	}

	/** Every path that cancels a correction: pause, seek, recovery, buffering, source change... */
	function cancelCorrections() {
		cancelBend();
		cancelMicroBend();
		// A gap, a seek or a reset always restarts the micro band's entry window.
		microWindow = [];
		microWindowSequence = -1;
	}

	/** A room speed/state update may have overwritten the last local rate. */
	function invalidateRate() {
		generation++;
		inFlight = null;
		cancelCorrections();
		// A reloaded element preserves pitch by default, so what was applied is unknown again.
		appliedPreservesPitch = null;
	}

	function resetMetrics() {
		rateWrites = 0;
		deadlineSeeks = 0;
		maxAbsDrift = 0;
		driftSeconds.fill(0);
		bendSeconds = 0;
		lastObservationSequence = -1;
		lastObservationAt = 0;
	}

	function driftBucket(magnitude: number) {
		const index = PLAYBACK_DRIFT_BUCKET_SECONDS.findIndex(bound => magnitude < bound);
		return index === -1 ? PLAYBACK_DRIFT_BUCKET_SECONDS.length - 1 : index;
	}

	/** Time-weighted distribution of the drift; the first observation of a chain adds nothing. */
	function recordDriftObservation(magnitude: number, bending: boolean, sequence: number) {
		const at = Date.now();
		if (sequence === lastObservationSequence + 1) {
			const step = Math.min((at - lastObservationAt) / 1000, MAX_OBSERVATION_STEP_SECONDS);
			if (step > 0) {
				driftSeconds[driftBucket(magnitude)] += step;
				if (bending) {
					bendSeconds += step;
				}
			}
		}
		lastObservationSequence = sequence;
		lastObservationAt = at;
	}

	/**
	 * The micro band may only start on the median of the last three consecutive observations.
	 * A single noisy read is not a drift, and a hole in the chain (a gap, a seek, a reset)
	 * restarts the window rather than mixing observations from before it.
	 */
	function recordMicroObservation(drift: number, sequence: number) {
		if (microWindow.length > 0 && sequence === microWindowSequence + 1) {
			microWindow.push(drift);
			if (microWindow.length > MICRO_WINDOW) {
				microWindow.shift();
			}
		} else {
			microWindow = [drift];
		}
		microWindowSequence = sequence;
	}

	/** Signed median of the entry window, or null while the window is not full. */
	function microMedian() {
		if (microWindow.length < MICRO_WINDOW) {
			return null;
		}
		const sorted = [...microWindow].sort((left, right) => left - right);
		return sorted[Math.floor(sorted.length / 2)];
	}

	/**
	 * The micro band plays the element resampled, which is only inaudible while the audio is not
	 * already time-stretched: at any other room speed resampling would shift the pitch.
	 */
	function microBendAvailable(base: number) {
		return base === 1 && !pitchUnsupported && options.setPreservesPitch !== undefined;
	}

	/**
	 * Below the bend start the drift is too small for a bounce in tempo but large enough to keep
	 * two viewers apart forever. The rate is rewritten only when the quantised offset changes.
	 */
	async function regulateMicroBend(base: number, drift: number, magnitude: number) {
		if (!microBendAvailable(base) || magnitude <= MICRO_STOP) {
			cancelMicroBend();
			return;
		}
		if (!microActive) {
			// Both the current read and the median have to be in the band: one read is noise,
			// and a drift already on its way down needs no correction.
			const median = microMedian();
			if (magnitude < MICRO_START || median === null || Math.abs(median) < MICRO_START) {
				return;
			}
		}
		const offset = quantiseMicroOffset(drift);
		if (offset === 0) {
			return;
		}
		if (!microActive) {
			if (!applyPreservesPitch(false)) {
				// A player that cannot resample keeps today's behaviour: nothing below 0.3s.
				cancelMicroBend();
				return;
			}
			microActive = true;
			microBase = base;
			microOffset = offset;
			await writeRate(base * (1 + offset));
			return;
		}
		if (offset !== microOffset) {
			microOffset = offset;
			await writeRate(base * (1 + offset));
		}
	}

	function reset() {
		invalidateRate();
		appliedPreservesPitch = null;
		pitchUnsupported = false;
		lastSeekAt = -Infinity;
		bufferedSinceLastSeek = false;
		pausedSeekTarget = null;
		// A new source is a cold load again: the next seek pays for the fetch, not a jump.
		coldSeekPending = true;
		pendingSeekLead = null;
		initialSyncUntil = Date.now() + PLAYBACK_INITIAL_SYNC_COOLDOWN_MS;
		pendingSeek = true;
		pendingSeekToleratesDrift = false;
		pendingSeekReason = "reset";
		inFlight = null;
		// Counter readings are meant per source; a new source starts them over.
		resetMetrics();
	}

	function canSeek(state: PlaybackSyncState) {
		return (
			!disposed &&
			state.source !== null &&
			state.player !== null &&
			state.ready &&
			!state.error &&
			Number.isFinite(state.position) &&
			state.position >= 0
		);
	}

	/**
	 * A paused room on a cheap native seek can be aligned to the frame immediately. Buffering
	 * is excluded because a stopped element with no buffer says nothing about where it sits, and
	 * embedded players are excluded because their seek is a reload.
	 */
	function isPausedNative(state: PlaybackSyncState) {
		return !state.playing && !state.buffering && !(options.seekIsExpensive?.() ?? false);
	}

	/**
	 * Only one corrective seek per paused target: a player that snaps to a keyframe keeps
	 * reporting drift, and seeking it every tick would never land and never stop moving.
	 */
	function claimPausedSeek(position: number) {
		if (pausedSeekTarget === position) {
			return false;
		}
		pausedSeekTarget = position;
		return true;
	}

	/**
	 * Drift correction pauses while the element is buffering: its clock is stopped, so the
	 * measured drift says nothing useful, and a rate written for it would only carry into
	 * the catch-up when playback resumes. The buffering stop is recorded in
	 * bufferedSinceLastSeek, which lengthens the cooldown after recovery. Explicit seeks
	 * bypass this check on purpose (see the pendingSeek branch in tick).
	 */
	function canObserve(state: PlaybackSyncState) {
		return (
			canSeek(state) &&
			!state.blocked &&
			!state.seeking &&
			!state.recovering &&
			!state.buffering
		);
	}

	function hasSeekBuffer(state: PlaybackSyncState) {
		return (
			state.bufferAhead === undefined ||
			state.bufferAhead === null ||
			state.bufferAhead >= PLAYBACK_MIN_SEEK_BUFFER_SECONDS
		);
	}

	function canSeekNow(state: PlaybackSyncState) {
		return (
			canObserve(state) &&
			// A source that was buffering keeps the longer cooldown after recovery.
			Date.now() - lastSeekAt >= (bufferedSinceLastSeek ? 8000 : 2000)
		);
	}

	/**
	 * A seek while the room is playing lands where the room will be when the player is able to
	 * resume, not where it is now: the fetch, decode and resume after the jump otherwise leave
	 * the viewer behind by exactly that latency. A paused room has no clock to run ahead of, an
	 * embedded player reloads instead of seeking, and a live edge owns its own timeline.
	 */
	function seekLeadApplies(state: PlaybackSyncState) {
		return state.playing && !state.live && !(options.seekIsExpensive?.() ?? false);
	}

	/**
	 * The target of a hard seek plus the estimate it used. The estimate is learned from the
	 * drift the seek leaves behind (see tick), not from a stopwatch: the residual drift at the
	 * next observation is exactly the prediction error.
	 */
	function seekTarget(state: PlaybackSyncState) {
		if (!seekLeadApplies(state)) {
			return state.position;
		}
		const kind: "load" | "seek" = coldSeekPending ? "load" : "seek";
		coldSeekPending = false;
		// The room clock runs at the room speed, so the latency it runs through scales with it.
		const target = state.position + seekLeadSeconds[kind] * (roomSpeed() ?? 1);
		const limit = options.getSeekLimit?.();
		if (limit != null && Number.isFinite(limit) && target > limit) {
			// Near the end there is nothing to run ahead into. Seek where the room is (or to
			// the end itself) and learn nothing from a seek that was not a prediction.
			pendingSeekLead = null;
			return Math.max(state.position, Math.min(target, limit));
		}
		pendingSeekLead = kind;
		return target;
	}

	async function seek(state: PlaybackSyncState, reason = "drift") {
		// A newer seek replaces the guess the previous one was going to learn from.
		pendingSeekLead = null;
		cancelCorrections();
		const target = seekTarget(state);
		console.debug("playback-sync: hard seek", { reason, position: target });
		if (reason === "bend-deadline") {
			// The catch-up a rate bend could not converge is the "8-second fallback" the
			// investigation doc wants measured on real devices.
			deadlineSeeks++;
		}
		lastSeekAt = Date.now();
		bufferedSinceLastSeek = state.buffering;
		const currentGeneration = generation;
		try {
			await options.setPosition(target);
		} catch (error) {
			if (!disposed && currentGeneration === generation) {
				options.onError(error);
			}
		}
	}

	/** A room sync must not freeze playback for a drift the rate bend can absorb. */
	async function seekIfDriftIsLarge(state: PlaybackSyncState, reason: string) {
		const read = options.getPosition();
		// Native players report the position synchronously; keep the seek in the same task
		// as the sync message instead of deferring it by a microtask.
		const position = read instanceof Promise ? await read : read;
		const latest = options.getState();
		if (
			disposed ||
			latest.live ||
			source !== latest.source ||
			player !== latest.player ||
			!canSeek(latest)
		) {
			return;
		}
		const drift = Math.abs(latest.position - position);
		maxAbsDrift = Math.max(maxAbsDrift, drift);
		const canBend = latest.playing && !latest.temporarySpeed && getBendBase() !== null;
		const pausedNative = isPausedNative(latest);
		// A room sync must not freeze playback for a drift the rate bend can absorb. Without
		// a bend, the shared passive policy picks the dead band by state and seek cost.
		const limit = passiveSeekLimit(
			canBend,
			false,
			options.seekIsExpensive?.() ?? false,
			pausedNative,
		);
		if (
			(!Number.isFinite(position) || drift > limit) &&
			hasSeekBuffer(latest) &&
			(!pausedNative || claimPausedSeek(latest.position))
		) {
			await seek(latest, reason);
		}
	}

	async function tick() {
		if (disposed) {
			return;
		}
		const sequence = ++tickSequence;
		const state = options.getState();
		if (source !== state.source || player !== state.player) {
			source = state.source;
			player = state.player;
			reset();
		}
		if (state.live) {
			// Live HLS owns its timeline (sliding window/live edge). Treating its currentTime
			// as a VOD position would hard-seek it backwards on every sync message.
			cancelCorrections();
			return;
		}
		if (state.playing) {
			// Playback resumed: the next pause is a new frame every viewer has to land on.
			pausedSeekTarget = null;
		}
		bufferedSinceLastSeek ||= state.buffering;
		if (!canObserve(state) || !state.playing || state.temporarySpeed) {
			cancelCorrections();
		}
		if (!state.playing) {
			// A paused room has no latency to learn from. Buffering and seeking keep the marker:
			// the element is simply not observable yet, and the first real read after the seek
			// carries the prediction error.
			pendingSeekLead = null;
		}
		if (!canSeek(state)) {
			return;
		}
		// Explicit seeks (user gestures, room syncs) run before the observation gate: a
		// buffering element must still follow the room's instruction.
		if (pendingSeek) {
			pendingSeek = false;
			const reason = pendingSeekReason;
			const tolerateDrift = pendingSeekToleratesDrift;
			pendingSeekToleratesDrift = false;
			if (tolerateDrift) {
				await seekIfDriftIsLarge(state, reason);
			} else {
				await seek(state, reason);
			}
			return;
		}
		if (inFlight !== null || !canObserve(state)) {
			return;
		}
		const request = Symbol("playback-position");
		const currentGeneration = generation;
		inFlight = request;
		try {
			const position = await options.getPosition();
			const latest = options.getState();
			if (
				inFlight !== request ||
				currentGeneration !== generation ||
				state.source !== latest.source ||
				state.player !== latest.player
			) {
				return;
			}
			if (!canObserve(latest) || !Number.isFinite(position)) {
				cancelCorrections();
				return;
			}
			const drift = latest.position - position;
			const magnitude = Math.abs(drift);
			maxAbsDrift = Math.max(maxAbsDrift, magnitude);
			// The residual drift of the first observation after a seek is the seek's prediction
			// error: a positive drift means the player is still behind, so the latency was
			// underestimated. One correction per seek, and a paused room has no error to learn.
			if (pendingSeekLead !== null) {
				if (latest.playing) {
					const kind = pendingSeekLead;
					// Drift is media time; the estimate is wall time. They differ by the room speed.
					const error = Math.max(
						-MAX_SEEK_LEAD_SECONDS,
						Math.min(MAX_SEEK_LEAD_SECONDS, drift / (roomSpeed() ?? 1)),
					);
					seekLeadSeconds[kind] = Math.min(
						MAX_SEEK_LEAD_SECONDS,
						Math.max(0, seekLeadSeconds[kind] + LEAD_CORRECTION * error),
					);
				}
				pendingSeekLead = null;
			}
			// Only a playing room has a drift worth distributing over time; a paused or stalled
			// observation is a hole in the chain, not a bucket entry.
			if (latest.playing) {
				recordDriftObservation(magnitude, bendStartedAt !== null || microActive, sequence);
				recordMicroObservation(drift, sequence);
			}
			const base = getBendBase();
			const canBend = latest.playing && !latest.temporarySpeed && base !== null;
			// A viewer that just joined or switched sources gets a short grace period. During
			// it, only a very large drift may seek; otherwise we would discard the buffer that
			// is still filling and start the seek/rebuffer loop.
			const initialSync = Date.now() < initialSyncUntil;
			const pausedNative = isPausedNative(latest);
			// While playing, a rate change absorbs up to HARD_SEEK_DRIFT; a paused room or a
			// player without a rate setter still seeks as soon as the drift is visible, and a
			// paused native element is not held back by the cooldown it does not pay for.
			const seekLimit = passiveSeekLimit(
				canBend,
				initialSync,
				options.seekIsExpensive?.() ?? false,
				pausedNative,
			);
			const maySeek = () =>
				pausedNative ? claimPausedSeek(latest.position) : canSeekNow(latest);
			if (magnitude > seekLimit && hasSeekBuffer(latest) && maySeek()) {
				await seek(latest, pausedNative ? "paused-frame" : "drift-large");
				return;
			}
			if (!canBend) {
				cancelCorrections();
				return;
			}
			if (
				(bendBase !== null && bendBase !== base) ||
				(microBase !== null && microBase !== base)
			) {
				cancelCorrections();
			}
			// A drift past the bend start belongs to the bend alone: give back the micro rate and
			// the element's pitch preservation before the bend writes its own rate.
			if (magnitude >= BEND_START) {
				cancelMicroBend();
			}
			// Tolerate floating point subtraction at exactly 150 ms. The bend keeps the band
			// between its stop and its start; below the stop it ends and leaves the remainder
			// to the micro band on a later tick.
			if (bendStartedAt !== null && magnitude <= BEND_STOP + 1e-9) {
				cancelBend();
				return;
			}
			// A running bend holds its rate down to its stop, so only a drift with no bend behind
			// it is handed to the micro band below the bend start.
			if (magnitude < BEND_START && bendStartedAt === null) {
				await regulateMicroBend(base, drift, magnitude);
				return;
			}
			const ceiling = bendCeiling(magnitude);
			if (bendStartedAt !== null && Date.now() >= bendDeadlineAt) {
				cancelBend();
				if (canSeekNow(latest) && hasSeekBuffer(latest)) {
					await seek(latest, "bend-deadline");
				}
				return;
			}
			// During seek cooldown even a large drift can improve without another range
			// request. Keep the original deadline while bending; restarting it each tick
			// would never expire. A growing drift extends it to the new catch-up size.
			bendBase = base;
			const sign = Math.sign(drift);
			if (bendStartedAt === null) {
				bendStartedAt = Date.now();
				bendPeak = magnitude;
				bendDeadlineAt = bendStartedAt + bendDeadlineMs(magnitude, ceiling);
				bendOffset = sign * ceiling;
				// Hold this rate for the whole bend. Rewriting playbackRate every tick makes
				// the browser re-time audio continuously, which is audible as repeated
				// micro-stutters on the opening catch-up.
				await writeRate(base * (1 + bendOffset));
				return;
			}
			// A drift that changes direction is a different correction; switch once.
			if (bendOffset !== null && Math.sign(bendOffset) !== sign) {
				bendPeak = magnitude;
				bendDeadlineAt = Date.now() + bendDeadlineMs(magnitude, ceiling);
				bendOffset = sign * ceiling;
				await writeRate(base * (1 + bendOffset));
				return;
			}
			if (magnitude > bendPeak) {
				bendPeak = magnitude;
				bendDeadlineAt = bendStartedAt + bendDeadlineMs(magnitude, ceiling);
				const next = sign * ceiling;
				if (bendOffset === null || Math.abs(next - bendOffset) > RATE_WRITE_THRESHOLD) {
					bendOffset = next;
					await writeRate(base * (1 + next));
				}
			} else if (appliedRate === null && bendOffset !== null) {
				// The previous native write was rejected; retry the held rate instead of
				// silently leaving the element at the room's base speed for the whole bend.
				await writeRate(base * (1 + bendOffset));
			}
		} catch (error) {
			if (!disposed && currentGeneration === generation) {
				options.onError(error);
			}
		} finally {
			if (inFlight === request) {
				inFlight = null;
			}
		}
	}

	function requestSeek(reason = "explicit", options?: SeekRequestOptions) {
		pendingSeek = true;
		pendingSeekToleratesDrift = options?.tolerateSmallDrift ?? false;
		pendingSeekReason = reason;
		invalidateRate();
		inFlight = null;
		return tick();
	}

	function dispose() {
		pendingSeekLead = null;
		cancelCorrections();
		disposed = true;
		generation++;
		inFlight = null;
	}

	function getMetrics(): PlaybackSyncMetrics {
		return {
			rateWrites,
			deadlineSeeks,
			maxAbsDrift,
			driftSeconds: [...driftSeconds],
			bendSeconds,
			seekLeadSeconds: seekLeadSeconds.seek,
			loadLeadSeconds: seekLeadSeconds.load,
		};
	}

	return { tick, requestSeek, reset, invalidateRate, dispose, getMetrics, resetMetrics };
}
