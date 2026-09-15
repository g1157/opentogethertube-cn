interface PlaybackSyncState {
	source: object | null;
	player: object | null;
	ready: boolean;
	error: boolean;
	blocked: boolean;
	seeking: boolean;
	recovering: boolean;
	buffering: boolean;
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
	onError(error: unknown): void;
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
const BEND_FULL = 0.5;
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

/** Give each range request time to finish; room seeks always take priority over drift correction. */
export function createPlaybackSync(options: PlaybackSyncOptions) {
	let source: object | null = null;
	let player: object | null = null;
	let generation = 0;
	let lastSeekAt = -Infinity;
	let bufferedSinceLastSeek = false;
	let pendingSeek = false;
	let pendingSeekToleratesDrift = false;
	let pendingSeekReason = "";
	let inFlight: symbol | null = null;
	let disposed = false;
	let bendStartedAt: number | null = null;
	let bendBase: number | null = null;
	let appliedRate: number | null = null;
	/** Largest drift seen during the current bend; the deadline follows the catch-up size. */
	let bendPeak = 0;
	let bendDeadlineAt = 0;

	function getBendBase() {
		const base = options.getBendBase?.();
		return options.setLocalRate && base != null && Number.isFinite(base) && base > 0
			? base
			: null;
	}

	function writeRate(rate: number) {
		if (appliedRate !== null && Math.abs(rate - appliedRate) <= RATE_WRITE_THRESHOLD) {
			return;
		}
		appliedRate = rate;
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

	function cancelBend() {
		if (bendStartedAt !== null) {
			const base = getBendBase() ?? bendBase;
			if (base !== null) {
				void writeRate(base);
			}
		}
		bendStartedAt = null;
		bendBase = null;
		bendPeak = 0;
		bendDeadlineAt = 0;
		appliedRate = null;
	}

	/** A room speed/state update may have overwritten the last local rate. */
	function invalidateRate() {
		generation++;
		inFlight = null;
		cancelBend();
	}

	function reset() {
		invalidateRate();
		lastSeekAt = -Infinity;
		bufferedSinceLastSeek = false;
		pendingSeek = true;
		pendingSeekToleratesDrift = false;
		pendingSeekReason = "reset";
		inFlight = null;
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

	function canObserve(state: PlaybackSyncState) {
		return canSeek(state) && !state.blocked && !state.seeking && !state.recovering;
	}

	function canSeekNow(state: PlaybackSyncState) {
		return (
			canObserve(state) &&
			Date.now() - lastSeekAt >= (state.buffering || bufferedSinceLastSeek ? 8000 : 2000)
		);
	}

	async function seek(state: PlaybackSyncState, reason = "drift") {
		console.debug("playback-sync: hard seek", { reason, position: state.position });
		cancelBend();
		lastSeekAt = Date.now();
		bufferedSinceLastSeek = state.buffering;
		const currentGeneration = generation;
		try {
			await options.setPosition(state.position);
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
		if (disposed || source !== latest.source || player !== latest.player || !canSeek(latest)) {
			return;
		}
		const drift = Math.abs(latest.position - position);
		const canBend = latest.playing && !latest.temporarySpeed && getBendBase() !== null;
		// A room sync must not freeze playback for a drift the rate bend can absorb; without
		// a rate setter (or while paused) only the 300 ms dead band is forgiven.
		const limit = canBend ? HARD_SEEK_DRIFT : BEND_START;
		if (!Number.isFinite(position) || drift > limit) {
			await seek(latest, reason);
		}
	}

	async function tick() {
		if (disposed) {
			return;
		}
		const state = options.getState();
		if (source !== state.source || player !== state.player) {
			source = state.source;
			player = state.player;
			reset();
		}
		bufferedSinceLastSeek ||= state.buffering;
		if (!canObserve(state) || !state.playing || state.temporarySpeed) {
			cancelBend();
		}
		if (!canSeek(state)) {
			return;
		}
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
				cancelBend();
				return;
			}
			const drift = latest.position - position;
			const magnitude = Math.abs(drift);
			const base = getBendBase();
			const canBend = latest.playing && !latest.temporarySpeed && base !== null;
			// While playing, a rate change absorbs up to HARD_SEEK_DRIFT; a paused room or a
			// player without a rate setter still seeks as soon as the drift is visible.
			const seekLimit = canBend ? HARD_SEEK_DRIFT : 1;
			if (magnitude > seekLimit && canSeekNow(latest)) {
				await seek(latest, "drift-large");
				return;
			}
			if (!canBend) {
				cancelBend();
				return;
			}
			if (bendBase !== null && bendBase !== base) {
				cancelBend();
			}
			// Tolerate floating point subtraction at exactly 150 ms.
			if (bendStartedAt !== null ? magnitude <= BEND_STOP + 1e-9 : magnitude < BEND_START) {
				cancelBend();
				return;
			}
			const ceiling = bendCeiling(magnitude);
			if (bendStartedAt !== null && Date.now() >= bendDeadlineAt) {
				cancelBend();
				if (canSeekNow(latest)) {
					await seek(latest, "bend-deadline");
				}
				return;
			}
			// During seek cooldown even a large drift can improve without another range
			// request. Keep the original deadline while bending; restarting it each tick
			// would never expire. A growing drift extends it to the new catch-up size.
			bendStartedAt ??= Date.now();
			if (magnitude > bendPeak) {
				bendPeak = magnitude;
				bendDeadlineAt = bendStartedAt + bendDeadlineMs(magnitude, ceiling);
			}
			bendBase = base;
			const bend = Math.max(-1, Math.min(1, drift / BEND_FULL)) * ceiling;
			// Leave preservesPitch at the browser default (true).
			await writeRate(base * (1 + bend));
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
		cancelBend();
		disposed = true;
		generation++;
		inFlight = null;
	}

	return { tick, requestSeek, reset, invalidateRate, dispose };
}
