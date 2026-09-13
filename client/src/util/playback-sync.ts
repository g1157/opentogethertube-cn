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

// Engineering starting points, not an industry standard. See docs/playback-sync.zh-CN.md.
const BEND_START = 0.3;
const BEND_STOP = 0.15;
const BEND_FULL = 0.5;
const MAX_BEND = 0.08;
const BEND_DEADLINE_MS = 8000;
const RATE_WRITE_THRESHOLD = 0.002;

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
		if (!Number.isFinite(position) || getBendBase() === null || drift > BEND_START) {
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
			if (magnitude > 1 && canSeekNow(latest)) {
				await seek(latest, "drift-large");
				return;
			}
			const base = getBendBase();
			if (!latest.playing || latest.temporarySpeed || base === null) {
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
			if (bendStartedAt !== null && Date.now() - bendStartedAt >= BEND_DEADLINE_MS) {
				cancelBend();
				if (canSeekNow(latest)) {
					await seek(latest, "bend-deadline");
				}
				return;
			}
			// During seek cooldown even a >1 s drift can improve without another range request.
			// Keep the original deadline while bending; restarting it each tick would never expire.
			bendStartedAt ??= Date.now();
			bendBase = base;
			const bend = Math.max(-1, Math.min(1, drift / BEND_FULL)) * MAX_BEND;
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
