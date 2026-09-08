import type { MediaPlayerError } from "@/components/composables/media-player";

const NETWORK_RETRY_DELAYS_MS = [1000, 3000, 6000];
const RECOVERY_TIMEOUT_MS = 30000;

interface PlaybackSnapshot {
	position: number;
	rate: number;
}

interface MediaRecoveryOptions {
	media: () => HTMLVideoElement | undefined;
	restart: (error: MediaPlayerError, manual: boolean) => void | Promise<void>;
	onRecovering: () => void;
	onError: (error: MediaPlayerError) => void;
}

/** A failed request must not turn into an endless reload loop for an expired or broken source. */
export function createMediaRecovery(options: MediaRecoveryOptions) {
	let phase: "loading" | "ready" | "scheduled" | "recovering" | "failed" | "disposed" = "loading";
	let desiredPlaying = false;
	let snapshot: PlaybackSnapshot | undefined = { position: 0, rate: 1 };
	let networkAttempts = 0;
	let decodeAttempts = 0;
	let generation = 0;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let lastError: MediaPlayerError = { type: "network" };

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
		clearTimer();
		networkAttempts = 0;
		decodeAttempts = 0;
		lastError = { type: "network" };
		snapshot = { position: 0, rate: options.media()?.playbackRate ?? 1 };
		phase = "loading";
	}

	function fail(error: MediaPlayerError) {
		clearTimer();
		phase = "failed";
		options.onError(error);
	}

	function runRecovery(manual: boolean) {
		clearTimer();
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
			if (Math.abs(media.currentTime - position) > 0.05) {
				media.currentTime = position;
			}
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
			(options.media()?.readyState ?? 0) < 3
		) {
			return false;
		}
		if (!restoreMetadata()) {
			return false;
		}
		snapshot = undefined;
		clearTimer();
		phase = "ready";
		// Read the latest requested state, including pauses received during the retry delay.
		// The room's ready handler applies playback and handles browser autoplay restrictions.
		if (!desiredPlaying) {
			options.media()?.pause();
		}
		return true;
	}

	function play(): void | Promise<void> {
		desiredPlaying = true;
		const media = options.media();
		const hasSource = !!(media?.currentSrc || media?.getAttribute("src") || media?.srcObject);
		// Mobile browsers may ignore preload until play() is called. Start an attached source
		// in the caller's user gesture and let autoplay rejections reach the room's unblock UI.
		if (phase === "ready" || (phase === "loading" && hasSource)) {
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
			media.currentTime = position;
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
		isFailed: () => phase === "failed",
	};
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
