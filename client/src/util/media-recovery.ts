import type { MediaPlayerError } from "@/components/composables/media-player";
import { createMediaSeek } from "./media-seek";

const NETWORK_RETRY_DELAYS_MS = [1000, 3000, 6000];
const RECOVERY_TIMEOUT_MS = 30000;
/**
 * A stall is playback that stops advancing: the element is neither paused nor seeking, but
 * has too little buffered to continue. Bad ranges survive seeks — a browser will not
 * re-fetch what it already buffered — so recovery has to fetch the same spot again.
 */
const STALL_TRIGGER_MS = 8000;
const STALL_CHECK_INTERVAL_MS = 1000;
/** Inside the room sync's 0.3s dead band, so a nudge is invisible and never fought over. */
const STALL_NUDGE_SECONDS = 0.3;
/** Last resort for a source genuinely missing this region; the viewer is told about it. */
const STALL_SKIP_SECONDS = 3;
/** Wider than a nudge, so a nudged playhead still counts as "the same spot". */
const STALL_POSITION_EPSILON = 0.5;

interface PlaybackSnapshot {
	position: number;
	rate: number;
}

interface MediaRecoveryOptions {
	media: () => HTMLVideoElement | undefined;
	restart: (error: MediaPlayerError, manual: boolean) => void | Promise<void>;
	onRecovering: () => void;
	onError: (error: MediaPlayerError) => void;
	/** Re-fetch the current position when the player can do better than a full reload. */
	onStallRefetch?: () => boolean | void;
	/** Called after the ladder had to move the playhead; the UI reports the jump. */
	onStallSkip?: (skippedSeconds: number) => void;
}

/** A failed request must not turn into an endless reload loop for an expired or broken source. */
export function createMediaRecovery(options: MediaRecoveryOptions) {
	const seek = createMediaSeek(options.media);
	let phase: "loading" | "ready" | "scheduled" | "recovering" | "failed" | "disposed" = "loading";
	let desiredPlaying = false;
	let snapshot: PlaybackSnapshot | undefined = { position: 0, rate: 1 };
	let networkAttempts = 0;
	let decodeAttempts = 0;
	let generation = 0;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let lastError: MediaPlayerError = { type: "network" };
	let stallWatch: ReturnType<typeof setInterval> | undefined;
	let lastStallPosition = -1;
	let lastStallProgressAt = 0;
	let stallAnchor: number | null = null;
	let stallAttemptsAtAnchor = 0;

	function clearTimer() {
		if (timer !== undefined) {
			clearTimeout(timer);
			timer = undefined;
		}
	}

	function capture() {
		if (snapshot) {
			return;
		}
		const media = options.media();
		snapshot = {
			position: Number.isFinite(media?.currentTime) ? Math.max(0, media!.currentTime) : 0,
			rate: media?.playbackRate ?? 1,
		};
	}

	function reset() {
		generation++;
		seek.reset();
		clearTimer();
		stopStallWatch();
		stallAnchor = null;
		stallAttemptsAtAnchor = 0;
		networkAttempts = 0;
		decodeAttempts = 0;
		lastError = { type: "network" };
		snapshot = { position: 0, rate: options.media()?.playbackRate ?? 1 };
		phase = "loading";
	}

	function fail(error: MediaPlayerError) {
		clearTimer();
		stopStallWatch();
		phase = "failed";
		options.onError(error);
	}

	function runRecovery(manual: boolean) {
		clearTimer();
		seek.reset();
		phase = "recovering";
		const currentGeneration = generation;
		// Some browsers never send another error after load(). Bound that attempt too.
		timer = setTimeout(() => {
			timer = undefined;
			handleError(lastError);
		}, RECOVERY_TIMEOUT_MS);
		try {
			Promise.resolve(options.restart(lastError, manual)).catch(() => {
				if (generation === currentGeneration && phase !== "disposed") {
					handleError(lastError);
				}
			});
		} catch {
			handleError(lastError);
		}
	}

	function handleError(error: MediaPlayerError) {
		if (phase === "disposed" || phase === "failed") {
			return;
		}
		capture();
		if (error.retryable === false || !["network", "decode"].includes(error.type)) {
			lastError = error;
			fail(error);
			return;
		}
		// A native media error and an hls.js error may describe the same failed request.
		if (phase === "scheduled") {
			return;
		}
		lastError = error;
		clearTimer();
		let delay: number | undefined;
		if (error.type === "network") {
			delay = NETWORK_RETRY_DELAYS_MS[networkAttempts++];
		} else if (decodeAttempts++ === 0) {
			delay = 1000;
		}
		if (delay === undefined) {
			fail(error);
			return;
		}
		phase = "scheduled";
		options.onRecovering();
		timer = setTimeout(() => runRecovery(false), delay);
	}

	function retry() {
		if (phase === "disposed") {
			return;
		}
		generation++;
		capture();
		networkAttempts = 0;
		decodeAttempts = 0;
		options.onRecovering();
		runRecovery(true);
	}

	function stopStallWatch() {
		if (stallWatch !== undefined) {
			clearInterval(stallWatch);
			stallWatch = undefined;
		}
	}

	function noteStallProgress(media: HTMLVideoElement) {
		lastStallPosition = media.currentTime;
		lastStallProgressAt = Date.now();
	}

	/**
	 * Playback that stops advancing is the one failure an error handler never sees: the
	 * element keeps "playing" a buffered range it cannot decode, or one with a hole.
	 */
	function startStallWatch() {
		if (stallWatch !== undefined) {
			return;
		}
		const media = options.media();
		if (media) {
			noteStallProgress(media);
		}
		stallWatch = setInterval(() => {
			const current = options.media();
			if (!current || phase !== "ready") {
				return;
			}
			// Background tabs buffer slowly; that is not a stall the viewer can see.
			if (typeof document !== "undefined" && document.hidden) {
				noteStallProgress(current);
				return;
			}
			if (current.paused || current.seeking || current.readyState >= 3) {
				noteStallProgress(current);
				return;
			}
			if (Math.abs(current.currentTime - lastStallPosition) > 0.05) {
				noteStallProgress(current);
				return;
			}
			if (Date.now() - lastStallProgressAt < STALL_TRIGGER_MS) {
				return;
			}
			recoverFromStall(current);
		}, STALL_CHECK_INTERVAL_MS);
	}

	/**
	 * One rung per attempt: fetch the same region again, then nudge past the bad spot, and
	 * only skip once the source itself is missing the region (which the viewer is told).
	 */
	function recoverFromStall(media: HTMLVideoElement) {
		const position = media.currentTime;
		const sameSpot =
			stallAnchor !== null && Math.abs(position - stallAnchor) <= STALL_POSITION_EPSILON;
		stallAttemptsAtAnchor = sameSpot ? stallAttemptsAtAnchor + 1 : 1;
		stallAnchor = position;
		noteStallProgress(media);
		if (stallAttemptsAtAnchor === 1) {
			// Nothing is skipped: the player either re-fetches this region itself or reloads.
			capture();
			if (options.onStallRefetch?.() !== true) {
				runRecovery(false);
			}
			return;
		}
		const skipped = stallAttemptsAtAnchor === 2 ? STALL_NUDGE_SECONDS : STALL_SKIP_SECONDS;
		seek.seek(position + skipped);
		Promise.resolve(media.play()).catch(() => undefined);
		if (stallAttemptsAtAnchor >= 3) {
			options.onStallSkip?.(STALL_SKIP_SECONDS);
		}
	}

	function restoreMetadata(): boolean {
		const media = options.media();
		if (!media || media.readyState < 1 || ["scheduled", "failed", "disposed"].includes(phase)) {
			return false;
		}
		if (!snapshot) {
			return true;
		}
		const position =
			Number.isFinite(media.duration) && media.duration > 0
				? Math.min(snapshot.position, Math.max(0, media.duration - 0.1))
				: snapshot.position;
		try {
			seek.seek(position);
			media.playbackRate = snapshot.rate;
			return true;
		} catch {
			// Safari can reject a seek until the first playable range is available.
			// canplay will retry the restoration after loadedmetadata.
			return false;
		}
	}

	function canPlay(): boolean {
		if (
			phase === "scheduled" ||
			phase === "failed" ||
			phase === "disposed" ||
			(options.media()?.readyState ?? 0) < 2
		) {
			return false;
		}
		if (!restoreMetadata() || !seek.ready()) {
			return false;
		}
		snapshot = undefined;
		clearTimer();
		phase = "ready";
		startStallWatch();
		// Read the latest requested state, including pauses received during the retry delay.
		// The room's ready handler applies playback and handles browser autoplay restrictions;
		// a dropped play() there is recovered by the room's periodic self-heal tick instead.
		if (!desiredPlaying) {
			options.media()?.pause();
		}
		return true;
	}

	function play(userInitiated = false): void | Promise<void> {
		desiredPlaying = true;
		const media = options.media();
		const hasSource = !!(media?.currentSrc || media?.getAttribute("src") || media?.srcObject);
		// Mobile browsers may ignore preload until play() is called. Start an attached source
		// in the caller's user gesture and let autoplay rejections reach the room's unblock UI.
		if (
			(!seek.pending() || userInitiated) &&
			(phase === "ready" || (phase === "loading" && hasSource))
		) {
			return media?.play();
		}
	}

	function pause() {
		desiredPlaying = false;
		options.media()?.pause();
	}

	function getPosition() {
		return snapshot?.position ?? options.media()?.currentTime ?? 0;
	}

	function setPosition(position: number) {
		if (!Number.isFinite(position) || position < 0) {
			return;
		}
		if (snapshot) {
			snapshot.position = position;
			return;
		}
		const media = options.media();
		if (media) {
			seek.seek(position);
		}
	}

	function setPlaybackRate(rate: number) {
		if (snapshot) {
			snapshot.rate = rate;
		}
		const media = options.media();
		if (media) {
			media.playbackRate = rate;
		}
	}

	function dispose() {
		generation++;
		phase = "disposed";
		clearTimer();
		stopStallWatch();
	}

	return {
		reset,
		retry,
		handleError,
		restoreMetadata,
		canPlay,
		play,
		pause,
		getPosition,
		setPosition,
		setPlaybackRate,
		dispose,
		isRecovering: () => ["loading", "scheduled", "recovering"].includes(phase),
		isSeeking: () => seek.pending() || (options.media()?.seeking ?? false),
		isFailed: () => phase === "failed",
	};
}

const SOURCE_PROBE_TIMEOUT_MS = 6000;

/**
 * Answers whether this device can reach the source at all. Chrome reports MEDIA_ERR_SRC_NOT_SUPPORTED
 * both for formats it cannot decode and for hosts it cannot resolve or connect to (blocked network,
 * dead proxy), hiding the difference. A no-cors HEAD request separates them: any HTTP response —
 * including 403 — proves the host is reachable, while a rejected request proves it is not.
 */
export async function probeSourceReachability(url: string): Promise<boolean> {
	// AbortSignal.timeout is not available everywhere (jsdom, older Safari), and an expired
	// probe must not hang the error message.
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), SOURCE_PROBE_TIMEOUT_MS);
	try {
		await fetch(url, {
			method: "HEAD",
			mode: "no-cors",
			cache: "no-store",
			signal: controller.signal,
		});
		return false;
	} catch {
		return true;
	} finally {
		clearTimeout(timer);
	}
}

/** Aborts caused by source changes are expected; unsupported formats should not be retried. */
export function nativeMediaError(error: MediaError | null): MediaPlayerError | undefined {
	switch (error?.code) {
		case 1:
			return undefined;
		case 2:
			return { type: "network" };
		case 3:
			return { type: "decode" };
		case 4:
			return { type: "unsupported", retryable: false };
		default:
			return undefined;
	}
}
