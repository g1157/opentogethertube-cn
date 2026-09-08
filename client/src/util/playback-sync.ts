interface PlaybackSyncState {
	source: object | null;
	player: object | null;
	ready: boolean;
	error: boolean;
	blocked: boolean;
	seeking: boolean;
	recovering: boolean;
	buffering: boolean;
	position: number;
}

interface PlaybackSyncOptions {
	getState(): PlaybackSyncState;
	getPosition(): number | Promise<number>;
	setPosition(position: number): void | Promise<void>;
	onError(error: unknown): void;
}

/** Give each range request time to finish; room seeks always take priority over drift correction. */
export function createPlaybackSync(options: PlaybackSyncOptions) {
	let source: object | null = null;
	let player: object | null = null;
	let generation = 0;
	let lastSeekAt = -Infinity;
	let bufferedSinceLastSeek = false;
	let pendingSeek = false;
	let inFlight: symbol | null = null;
	let disposed = false;

	function reset() {
		generation++;
		lastSeekAt = -Infinity;
		bufferedSinceLastSeek = false;
		pendingSeek = true;
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

	function canCorrect(state: PlaybackSyncState) {
		return (
			canSeek(state) &&
			!state.blocked &&
			!state.seeking &&
			!state.recovering &&
			Date.now() - lastSeekAt >= (state.buffering || bufferedSinceLastSeek ? 8000 : 2000)
		);
	}

	async function seek(state: PlaybackSyncState) {
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
		if (!canSeek(state)) {
			return;
		}
		if (pendingSeek) {
			pendingSeek = false;
			await seek(state);
			return;
		}
		if (inFlight !== null || !canCorrect(state)) {
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
				state.player !== latest.player ||
				!canCorrect(latest)
			) {
				return;
			}
			if (Number.isFinite(position) && Math.abs(latest.position - position) > 1) {
				await seek(latest);
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

	function requestSeek() {
		generation++;
		pendingSeek = true;
		inFlight = null;
		return tick();
	}

	function dispose() {
		disposed = true;
		generation++;
		inFlight = null;
	}

	return { tick, requestSeek, reset, dispose };
}
