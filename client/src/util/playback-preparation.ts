import type { PlaybackPreparation, PlaybackPrepared } from "ott-common/models/messages";
import type { VideoId } from "ott-common/models/video";
import type { MediaLoadingState } from "./media-loading-state";

export interface PlaybackPreparationState {
	phase: "idle" | "aligning" | "preparing" | "waiting-ack" | "failed";
	active: boolean;
	priming: boolean;
	failed: boolean;
}

interface PreparationInput {
	preparation: PlaybackPreparation | null;
	clientId: string;
	source: VideoId | null;
	player: object | null;
	connected: boolean;
	roomPlaying: boolean;
	ready: boolean;
	playing: boolean;
	blocked: boolean;
	error: boolean;
	seeking: boolean;
	recovering: boolean;
	loading: MediaLoadingState | null;
	frameVersion: number;
}

interface PreparationOptions {
	getState(): PreparationInput;
	getPosition(): number | Promise<number>;
	setPosition(position: number): void | Promise<void>;
	pause(): void | Promise<void>;
	sendReady(prepared: PlaybackPrepared): void;
	onChange(state: PlaybackPreparationState): void;
	onError(error: unknown): void;
}

const POSITION_TOLERANCE = 0.25;
const MAX_REALIGNMENTS = 2;

/** Only the server-selected first viewer may prime a paused, previously empty room. */
export function createPlaybackPreparation(options: PreparationOptions) {
	let context: (PlaybackPreparation & { source: VideoId; player: object | null }) | null = null;
	let phase: PlaybackPreparationState["phase"] = "idle";
	let generation = 0;
	let inFlight: symbol | null = null;
	let positioned = false;
	let realignments = 0;
	let minimumFrameVersion = 0;
	let cancelledId: string | null = null;
	let disposed = false;

	function publish(next: PlaybackPreparationState["phase"]) {
		if (phase === next) {
			return;
		}
		phase = next;
		options.onChange({
			phase,
			active: phase !== "idle",
			priming: phase === "preparing",
			failed: phase === "failed",
		});
	}

	function isOwner(state: PreparationInput) {
		const preparation = state.preparation;
		return (
			!disposed &&
			state.connected &&
			!state.roomPlaying &&
			!!state.clientId &&
			!!preparation &&
			preparation.id !== cancelledId &&
			preparation.clientId === state.clientId &&
			preparation.video.service === state.source?.service &&
			preparation.video.id === state.source?.id &&
			Number.isFinite(preparation.position) &&
			preparation.position >= 0
		);
	}

	function matches(state: PreparationInput) {
		return (
			isOwner(state) &&
			!!context &&
			context.id === state.preparation?.id &&
			context.clientId === state.clientId &&
			context.position === state.preparation.position &&
			context.source === state.source &&
			context.player === state.player
		);
	}

	function reconcile() {
		const state = options.getState();
		if (matches(state)) {
			return;
		}
		generation++;
		inFlight = null;
		positioned = false;
		realignments = 0;
		minimumFrameVersion = 0;
		context = isOwner(state)
			? { ...state.preparation!, source: state.source!, player: state.player }
			: null;
		publish(context ? "aligning" : "idle");
	}

	function hasFrame(state: PreparationInput) {
		return (
			state.loading?.phase === null &&
			state.loading.currentTime !== null &&
			Number.isFinite(state.loading.currentTime) &&
			state.frameVersion >= minimumFrameVersion
		);
	}

	function canPosition(state: PreparationInput) {
		return state.ready && !state.error && !state.seeking;
	}

	function usable(state: PreparationInput) {
		return canPosition(state) && !state.recovering;
	}

	function fail(error: unknown) {
		if (!matches(options.getState())) {
			return;
		}
		generation++;
		inFlight = null;
		publish("failed");
		options.onError(error);
		try {
			void Promise.resolve(options.pause()).catch(options.onError);
		} catch (pauseError) {
			options.onError(pauseError);
		}
	}

	async function tick() {
		reconcile();
		const state = options.getState();
		if (
			!context ||
			inFlight !== null ||
			phase === "failed" ||
			phase === "waiting-ack" ||
			!canPosition(state) ||
			(positioned && (!usable(state) || !hasFrame(state) || !state.playing || state.blocked))
		) {
			return;
		}
		const preparation = context;
		const request = Symbol("playback-preparation");
		const currentGeneration = generation;
		const initialPosition = !positioned;
		const canContinue = () =>
			initialPosition ? canPosition(options.getState()) : usable(options.getState());
		inFlight = request;
		const current = () =>
			generation === currentGeneration && inFlight === request && matches(options.getState());
		try {
			const position = await options.getPosition();
			if (!current() || !canContinue()) {
				return;
			}
			if (!Number.isFinite(position) || position < 0) {
				throw new Error("The player did not report a valid preparation position");
			}
			const needsSeek = Math.abs(position - preparation.position) > POSITION_TOLERANCE;
			if (needsSeek) {
				if (positioned && realignments++ >= MAX_REALIGNMENTS) {
					throw new Error("The first visible frame repeatedly missed the saved position");
				}
				publish("aligning");
				await options.pause();
				if (!current() || !canContinue()) {
					return;
				}
				// A pause can publish the existing frame. Require a later frame from this seek.
				minimumFrameVersion = options.getState().frameVersion + 1;
				await options.setPosition(preparation.position);
				if (!current()) {
					return;
				}
				positioned = true;
				publish("preparing");
				return;
			}
			positioned = true;
			publish("preparing");
			const latest = options.getState();
			if (!usable(latest) || !latest.playing || latest.blocked || !hasFrame(latest)) {
				return;
			}

			// Freeze this browser too while the ready message makes its round trip. Otherwise
			// a slow connection would silently consume more of the saved scene before resume.
			publish("waiting-ack");
			await options.pause();
			if (!current() || !usable(options.getState()) || options.getState().blocked) {
				if (current()) {
					publish("preparing");
				}
				return;
			}
			const pausedPosition = await options.getPosition();
			if (!current() || !usable(options.getState()) || options.getState().blocked) {
				if (current()) {
					publish("preparing");
				}
				return;
			}
			if (
				!Number.isFinite(pausedPosition) ||
				Math.abs(pausedPosition - preparation.position) > POSITION_TOLERANCE
			) {
				// Recheck after pausing rather than acknowledge an old, asynchronously read time.
				publish("preparing");
				return;
			}
			options.sendReady({ id: preparation.id, position: pausedPosition });
		} catch (error) {
			if (current()) {
				fail(error);
			}
		} finally {
			if (inFlight === request) {
				inFlight = null;
			}
		}
	}

	function retry() {
		reconcile();
		if (!context) {
			return;
		}
		generation++;
		inFlight = null;
		positioned = false;
		realignments = 0;
		minimumFrameVersion = options.getState().frameVersion + 1;
		publish("aligning");
	}

	function cancel() {
		cancelledId = options.getState().preparation?.id ?? null;
		reconcile();
	}

	function dispose() {
		disposed = true;
		reconcile();
	}

	return { tick, retry, cancel, fail, dispose };
}
