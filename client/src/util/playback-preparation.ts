import { playbackReadyBufferSeconds } from "ott-common/constants";
import type { PlaybackPreparation, PlaybackPrepared } from "ott-common/models/messages";
import type { VideoId } from "ott-common/models/video";
import type { MediaLoadingState } from "./media-loading-state";

export interface PlaybackPreparationState {
	phase: "idle" | "aligning" | "preparing" | "buffering" | "parking" | "waiting-ack" | "failed";
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
	/** A background tab should not become the room's readiness blocker. */
	visible?: boolean;
}

interface PreparationOptions {
	getState(): PreparationInput;
	getPosition(): number | Promise<number>;
	setPosition(position: number): void | Promise<void>;
	pause(): void | Promise<void>;
	sendReady(prepared: PlaybackPrepared): void;
	sendFailed?(preparationId: string, reason: string): void;
	onChange(state: PlaybackPreparationState): void;
	onError(error: unknown): void;
	/** Injectable clock so the paused-wait fallback can be driven in tests. */
	now?(): number;
}

const POSITION_TOLERANCE = 0.25;
/** A parked frame this close to the target is exact; anything else is a player estimate. */
const PARKED_PRECISION = 0.05;
const MAX_REALIGNMENTS = 2;
/**
 * A browser that keeps buffering while paused fills the runway on its own. One that does not
 * (some mobile browsers stop the download until the element plays) would wait here forever,
 * so after this window without progress the round continues while playing instead.
 */
const PAUSED_WAIT_MS = 2000;
/** Growth of the runway that counts as "it is still filling" over one paused window. */
const PAUSED_WAIT_PROGRESS_SECONDS = 0.25;

/**
 * 0 while this browser is inside a preparation round and the room is not playing yet, so
 * none of the opening is audible, and 1 as soon as the room starts or the round ends. The
 * video volume is multiplied by it instead of muting the element: un-muting without a user
 * gesture can pause playback under autoplay policies.
 */
export function preparationSilenceFactor(
	state: PlaybackPreparationState,
	roomPlaying: boolean,
): number {
	return state.active && !roomPlaying ? 0 : 1;
}

/** Only the server-selected first viewer may prime a paused, previously empty room. */
export function createPlaybackPreparation(options: PreparationOptions) {
	const now = options.now ?? (() => Date.now());
	let context: (PlaybackPreparation & { source: VideoId; player: object | null }) | null = null;
	let phase: PlaybackPreparationState["phase"] = "idle";
	let generation = 0;
	let inFlight: symbol | null = null;
	let positioned = false;
	let realignments = 0;
	let cancelledId: string | null = null;
	/** The preparation this viewer already reported itself hidden for. */
	let hiddenReportedId: string | null = null;
	let disposed = false;
	/**
	 * "align" ends at the first confirmed frame on the target. From there on the element is
	 * expected to move forward while the runway fills, so a distance from the target is no
	 * longer a missed frame; "park" brings it back before acknowledging.
	 */
	let stage: "align" | "runway" | "park" = "align";
	/** Park seeks are issued once; the parked position is only re-read afterwards. */
	let parkAttempts = 0;
	/** Start of the current paused wait and the runway it saw, for the mobile fallback. */
	let pausedWaitSince: number | null = null;
	let pausedWaitRunway = 0;
	/** Some players only fill their buffer while playing, so this lasts for the round. */
	let playingWait = false;

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

	function resetStage() {
		stage = "align";
		parkAttempts = 0;
		pausedWaitSince = null;
		pausedWaitRunway = 0;
		playingWait = false;
	}

	function isOwner(state: PreparationInput) {
		const preparation = state.preparation;
		const eligible = preparation?.eligible
			? preparation.eligible.includes(state.clientId)
			: preparation?.clientId === state.clientId;
		return (
			!disposed &&
			state.connected &&
			state.visible !== false &&
			!state.roomPlaying &&
			!!state.clientId &&
			!!preparation &&
			preparation.id !== cancelledId &&
			eligible &&
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
		const preparation = state.preparation;
		// A background tab cannot show the first frame the round is waiting for. Tell the
		// room instead of letting every other viewer wait out the full deadline; once the
		// server drops this viewer, returning to the tab does not rejoin the snapshot.
		if (
			!disposed &&
			preparation &&
			state.visible === false &&
			preparation.id !== cancelledId &&
			preparation.id !== hiddenReportedId &&
			state.connected &&
			state.clientId &&
			(preparation.eligible
				? preparation.eligible.includes(state.clientId)
				: preparation.clientId === state.clientId) &&
			preparation.video.service === state.source?.service &&
			preparation.video.id === state.source?.id
		) {
			hiddenReportedId = preparation.id;
			try {
				options.sendReady({
					id: preparation.id,
					position: preparation.position,
					firstFrame: false,
					visible: false,
				});
			} catch (error) {
				options.onError(error);
			}
		}
		if (matches(state)) {
			return;
		}
		generation++;
		inFlight = null;
		positioned = false;
		realignments = 0;
		resetStage();
		context = isOwner(state)
			? { ...state.preparation!, source: state.source!, player: state.player }
			: null;
		publish(context ? "aligning" : "idle");
	}

	/**
	 * "On screen" is the loading state's business: it only clears its phase once the target
	 * position has current data with real dimensions. Waiting for a fresh compositor callback
	 * on top of that kept every viewer waiting for a frame the browser may only deliver once
	 * playback resumes — the picture was already there.
	 */
	function hasFrame(state: PreparationInput) {
		return (
			state.loading?.phase === null &&
			state.loading.currentTime !== null &&
			Number.isFinite(state.loading.currentTime)
		);
	}

	/**
	 * Seconds of media buffered ahead of the position the room will start at. Measured from
	 * the target, not from the moving currentTime: playing forward does not make the runway
	 * the room needs any longer. A browser with no readable buffer counts as satisfied.
	 */
	function runwayFromTarget(state: PreparationInput, target: number): number | null {
		const loading = state.loading;
		if (!loading || loading.currentTime === null || !Number.isFinite(loading.currentTime)) {
			return null;
		}
		const ahead = loading.bufferAhead;
		if (ahead === null || !Number.isFinite(ahead)) {
			return null;
		}
		// Milliseconds are the resolution a readiness value needs; the sum of two floats is not.
		return Math.max(0, Math.round((loading.currentTime + ahead - target) * 1000) / 1000);
	}

	function canPosition(state: PreparationInput) {
		return state.ready && !state.error && !state.seeking;
	}

	function usable(state: PreparationInput) {
		return canPosition(state) && !state.recovering;
	}

	function fail(error: unknown) {
		const state = options.getState();
		if (!matches(state)) {
			return;
		}
		generation++;
		inFlight = null;
		publish("failed");
		const preparation = state.preparation;
		if (preparation) {
			const reason = error instanceof Error ? error.message : String(error);
			try {
				options.sendFailed?.(preparation.id, reason);
			} catch (sendError) {
				options.onError(sendError);
			}
		}
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
			(stage === "align"
				? // Before the first confirmed frame the element has to be playing, because only
					// a playing picture proves the frame is really on screen.
					positioned &&
					(!usable(state) || !hasFrame(state) || !state.playing || state.blocked)
				: !usable(state) || state.blocked)
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
			if (stage === "align") {
				// Stage 1: put the picture on the saved frame. Until a frame lands there the
				// element may still be anywhere, so a repeated miss is a real failure.
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
						throw new Error(
							"The first visible frame repeatedly missed the saved position",
						);
					}
					publish("aligning");
					await options.pause();
					if (!current() || !canContinue()) {
						return;
					}
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
				const aligned = options.getState();
				if (!usable(aligned) || !aligned.playing || aligned.blocked || !hasFrame(aligned)) {
					return;
				}
				// The frame at the target is confirmed. Everything below may deliberately move
				// the element away from it, so only the stage above may count a miss.
				stage = "runway";
			}
			if (stage === "runway") {
				const waiting = options.getState();
				const requiredBuffer = playbackReadyBufferSeconds(waiting.source?.service);
				const runway = runwayFromTarget(waiting, preparation.position);
				if (runway !== null && runway < requiredBuffer) {
					if (playingWait) {
						// Already waiting while playing: pausing again would stop the very
						// download that is supposed to catch up.
						publish("preparing");
						return;
					}
					const at = now();
					const entering = pausedWaitSince === null;
					const waitingSince = pausedWaitSince ?? at;
					if (entering) {
						pausedWaitSince = at;
						pausedWaitRunway = runway;
					}
					// Paused, so the picture stays on the first frame and the element cannot
					// run away from the target while the download catches up.
					publish("buffering");
					if (at - waitingSince >= PAUSED_WAIT_MS) {
						if (runway - pausedWaitRunway < PAUSED_WAIT_PROGRESS_SECONDS) {
							// Nothing arrived in a whole paused window: this browser does not
							// buffer while paused, so spend the rest of the round playing.
							playingWait = true;
							publish("preparing");
							return;
						}
						// Still filling: judge the next window on its own progress.
						pausedWaitSince = at;
						pausedWaitRunway = runway;
					}
					if (entering) {
						// Room.vue also pauses for this phase; pausing here keeps the engine
						// self-contained for a harness that only reacts to the phase.
						await options.pause();
					}
					return;
				}
				pausedWaitSince = null;
				stage = "park";
			}
			// Stage 3: park exactly on the saved frame and acknowledge that position, so every
			// viewer starts the room on the same frame instead of wherever its element stopped.
			publish("parking");
			if (parkAttempts === 0) {
				await options.pause();
				if (!current() || !usable(options.getState()) || options.getState().blocked) {
					return;
				}
				await options.setPosition(preparation.position);
				if (!current()) {
					return;
				}
			}
			parkAttempts++;
			const parked = await options.getPosition();
			if (!current()) {
				return;
			}
			const latest = options.getState();
			if (!usable(latest) || latest.blocked || !hasFrame(latest)) {
				// The seek is still running; the loading state ticks again when it is done.
				return;
			}
			const offset = Number.isFinite(parked)
				? Math.abs(parked - preparation.position)
				: Number.POSITIVE_INFINITY;
			// The park seek is issued once: a player that snaps to a nearby keyframe cannot be
			// improved by seeking again, so it is accepted at the old tolerance, not in a loop.
			const landed =
				offset <= PARKED_PRECISION || (parkAttempts >= 1 && offset <= POSITION_TOLERANCE);
			if (!landed) {
				return;
			}
			publish("waiting-ack");
			options.sendReady({
				id: preparation.id,
				// Where the element really is, so the server's own position check still means
				// something; the room starts from the round's position either way.
				position: parked,
				firstFrame: true,
				bufferAhead: runwayFromTarget(latest, preparation.position),
				...(latest.visible === false ? { visible: false } : {}),
			});
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
		resetStage();
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
