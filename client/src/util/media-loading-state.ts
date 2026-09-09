export interface MediaLoadingState {
	phase: "preparing" | "seeking" | "buffering" | "waiting-frame" | null;
	currentTime: number | null;
	bufferAhead: number | null;
}

interface MediaLoadingOptions {
	media: () => HTMLVideoElement | undefined;
	onChange: (state: MediaLoadingState) => void;
	isAudioOnly?: () => boolean;
}

interface FrameCounters {
	displayed?: number;
	decoded?: number;
}

const FRAME_OBSERVATION_INTERVAL_MS = 250;
const MAX_FRAME_OBSERVATIONS = 8;

function nonDroppedFrames(total: number | undefined, dropped: number | undefined) {
	return total !== undefined &&
		dropped !== undefined &&
		Number.isFinite(total) &&
		Number.isFinite(dropped) &&
		dropped >= 0 &&
		total >= dropped
		? total - dropped
		: undefined;
}

function readFrameCounters(media: HTMLVideoElement): FrameCounters {
	const counts: FrameCounters = {};
	try {
		const quality = media.getVideoPlaybackQuality?.();
		counts.displayed = nonDroppedFrames(quality?.totalVideoFrames, quality?.droppedVideoFrames);
	} catch {
		// Some WebViews expose the method without implementing it.
	}
	try {
		const webkit = media as HTMLVideoElement & {
			webkitDecodedFrameCount?: number;
			webkitDroppedFrameCount?: number;
		};
		counts.decoded = nonDroppedFrames(
			webkit.webkitDecodedFrameCount,
			webkit.webkitDroppedFrameCount,
		);
	} catch {
		// Native counters are optional, independent of the frame callback API.
	}
	return counts;
}

function hasDimensions(width: number | undefined, height: number | undefined) {
	return (
		width !== undefined &&
		height !== undefined &&
		width > 0 &&
		height > 0 &&
		Number.isFinite(width) &&
		Number.isFinite(height)
	);
}

/** Seconds in the continuous buffered range at position, not total downloaded coverage. */
export function getBufferAhead(buffered: TimeRanges, position: number): number | null {
	if (!Number.isFinite(position) || position < 0) {
		return null;
	}
	try {
		let end: number | undefined;
		for (let i = 0; i < buffered.length; i++) {
			const start = buffered.start(i);
			const rangeEnd = buffered.end(i);
			if (!Number.isFinite(start) || !Number.isFinite(rangeEnd) || rangeEnd < start) {
				return null;
			}
			if (end === undefined) {
				if (start <= position && rangeEnd >= position) {
					end = rangeEnd;
				}
			} else if (start <= end) {
				end = Math.max(end, rangeEnd);
			} else {
				break;
			}
		}
		return end === undefined ? 0 : Math.max(0, end - position);
	} catch {
		// A detached/changing media source can invalidate a TimeRanges read.
		return null;
	}
}

/** Tracks this browser's frame readiness independently of the room's playback clock. */
export function createMediaLoadingState(options: MediaLoadingOptions) {
	let attached: HTMLVideoElement | undefined;
	let active = true;
	let disposed = false;
	let generation = 0;
	let metadataReady = false;
	let awaitingSeek = false;
	let waiting = false;
	let hasFrame = false;
	let frameReady = false;
	let presentedPosition: number | undefined;
	let unmatchedFrames = 0;
	let frameApiFailed = false;
	let frameRequest: number | undefined;
	let frameCounterBaseline: FrameCounters = {};
	let frameCountersAvailable = false;
	let playbackObservationPosition: number | undefined;
	let observedPlaying = false;
	let frameObservationsRemaining = MAX_FRAME_OBSERVATIONS;
	let frameObservationTimer: ReturnType<typeof setTimeout> | undefined;
	let lastState: MediaLoadingState | undefined;

	function cancelFrameObservation() {
		clearTimeout(frameObservationTimer);
		frameObservationTimer = undefined;
	}

	function cancelFrame() {
		generation++;
		cancelFrameObservation();
		if (frameRequest !== undefined) {
			attached?.cancelVideoFrameCallback?.(frameRequest);
			frameRequest = undefined;
		}
	}

	function resetFrameEvidence() {
		const media = options.media();
		frameCounterBaseline = media ? readFrameCounters(media) : {};
		playbackObservationPosition = undefined;
		observedPlaying = false;
		frameObservationsRemaining = MAX_FRAME_OBSERVATIONS;
	}

	function measuredFrameIsReady(media: HTMLVideoElement) {
		const counts = readFrameCounters(media);
		frameCountersAvailable = counts.displayed !== undefined || counts.decoded !== undefined;
		if (
			media.readyState < 2 ||
			media.seeking ||
			awaitingSeek ||
			!hasDimensions(media.videoWidth, media.videoHeight)
		) {
			// Activity before current data, or during an unfinished seek, cannot prove its new frame.
			frameCounterBaseline = counts;
			playbackObservationPosition = undefined;
			return false;
		}
		if (Number.isFinite(media.currentTime)) {
			playbackObservationPosition ??= media.currentTime;
		}
		function advanced(kind: keyof FrameCounters, minimum: number) {
			const count = counts[kind];
			const baseline = frameCounterBaseline[kind];
			if (count === undefined) {
				return false;
			}
			if (baseline === undefined || count < baseline) {
				frameCounterBaseline[kind] = count;
				return false;
			}
			return count - baseline >= minimum;
		}
		// Standard counters count displayed + dropped frames. Decoding alone needs further evidence.
		return (
			advanced("displayed", 1) ||
			(advanced("decoded", 2) &&
				observedPlaying &&
				!media.paused &&
				playbackObservationPosition !== undefined &&
				media.currentTime - playbackObservationPosition >= 0.25)
		);
	}

	function observeFramesBriefly(media: HTMLVideoElement) {
		if (
			disposed ||
			!active ||
			lastState?.phase === null ||
			frameObservationTimer !== undefined ||
			frameObservationsRemaining <= 0 ||
			!frameCountersAvailable ||
			media.ownerDocument.hidden ||
			media.readyState < 2 ||
			media.seeking ||
			awaitingSeek
		) {
			return;
		}
		const observedGeneration = generation;
		frameObservationTimer = setTimeout(() => {
			if (disposed || !active || generation !== observedGeneration) {
				return;
			}
			frameObservationTimer = undefined;
			frameObservationsRemaining--;
			refresh();
		}, FRAME_OBSERVATION_INTERVAL_MS);
	}

	function publish(phase: MediaLoadingState["phase"]) {
		const media = options.media();
		const currentTime =
			metadataReady && media && Number.isFinite(media.currentTime) && media.currentTime >= 0
				? media.currentTime
				: null;
		const state: MediaLoadingState = {
			phase,
			currentTime,
			bufferAhead:
				media && currentTime !== null ? getBufferAhead(media.buffered, currentTime) : null,
		};
		if (
			lastState?.phase !== state.phase ||
			lastState?.currentTime !== state.currentTime ||
			lastState?.bufferAhead !== state.bufferAhead
		) {
			lastState = state;
			options.onChange(state);
		}
	}

	function isAudioOnly(media: HTMLVideoElement) {
		if (options.isAudioOnly?.()) {
			return true;
		}
		// Safari exposes native track lists, including for an audio-only HLS playlist.
		const tracks = media as HTMLVideoElement & {
			audioTracks?: { length: number };
			videoTracks?: { length: number };
		};
		return (
			metadataReady &&
			(tracks.audioTracks?.length ?? 0) > 0 &&
			tracks.videoTracks?.length === 0
		);
	}

	function requestFrame(media: HTMLVideoElement) {
		if (
			frameRequest !== undefined ||
			frameApiFailed ||
			typeof media.requestVideoFrameCallback !== "function" ||
			media.ownerDocument.hidden
		) {
			return;
		}
		const requestedGeneration = generation;
		const requestedAt = performance.now();
		const requestedPosition = media.currentTime;
		try {
			frameRequest = media.requestVideoFrameCallback((now, frame) => {
				if (
					disposed ||
					!active ||
					generation !== requestedGeneration ||
					options.media() !== media
				) {
					return;
				}
				frameRequest = undefined;
				// Main-thread delay can advance playback; a jump to another seek target cannot.
				const presentationDelay =
					!media.paused &&
					!media.seeking &&
					!awaitingSeek &&
					frame?.mediaTime >= requestedPosition - 0.5 &&
					Number.isFinite(frame?.presentationTime) &&
					frame.presentationTime >= requestedAt &&
					Number.isFinite(now) &&
					now >= frame.presentationTime
						? ((now - frame.presentationTime) / 1000) * Math.abs(media.playbackRate)
						: 0;
				const matchesPosition =
					!Number.isFinite(frame?.mediaTime) ||
					(frame.mediaTime >= media.currentTime - 0.5 - presentationDelay &&
						frame.mediaTime <= media.currentTime + 0.5);
				if (
					media.error ||
					media.readyState < 2 ||
					!Number.isFinite(media.currentTime) ||
					!(
						hasDimensions(frame?.width, frame?.height) ||
						hasDimensions(media.videoWidth, media.videoHeight)
					) ||
					!(matchesPosition || measuredFrameIsReady(media))
				) {
					// A queued old frame can precede the paused seek's only new frame.
					// Observe a bounded number of replacements even without another media event.
					if (!media.error && unmatchedFrames++ < 2) {
						requestFrame(media);
					}
					return;
				}
				metadataReady = true;
				hasFrame = true;
				frameReady = true;
				// Record the logical seek target, not a low-frame-rate video's earlier frame PTS.
				presentedPosition = media.currentTime;
				if (media.seeking || awaitingSeek) {
					publish("seeking");
					return;
				}
				waiting = false;
				cancelFrameObservation();
				publish(null);
			});
		} catch {
			// Older browsers can expose a partial implementation. Use native frame data below.
			frameApiFailed = true;
			refresh();
		}
	}

	function refresh() {
		const media = options.media();
		if (disposed || !active || !media || media.error) {
			return;
		}
		metadataReady ||= media.readyState >= 1;
		const seeking = media.seeking || awaitingSeek;
		const audioOnly = isAudioOnly(media);
		const nativeFallback =
			frameApiFailed || typeof media.requestVideoFrameCallback !== "function";
		const hasCurrentData = media.readyState >= 2 && !seeking;
		const measuredFrame = measuredFrameIsReady(media);
		if (
			hasCurrentData &&
			(audioOnly ||
				measuredFrame ||
				(nativeFallback && hasDimensions(media.videoWidth, media.videoHeight))) &&
			(!waiting || media.paused || media.readyState >= 3)
		) {
			hasFrame = true;
			frameReady = true;
			waiting = false;
		}
		if (frameReady && !seeking && !waiting) {
			cancelFrame();
			publish(null);
			return;
		}
		publish(
			seeking
				? "seeking"
				: !metadataReady || media.readyState < 1
					? "preparing"
					: waiting || media.readyState < 2
						? "buffering"
						: "waiting-frame",
		);
		if (!audioOnly) {
			requestFrame(media);
			observeFramesBriefly(media);
		}
	}

	function reset() {
		if (disposed) {
			return;
		}
		cancelFrame();
		active = true;
		metadataReady = false;
		awaitingSeek = false;
		waiting = false;
		hasFrame = false;
		frameReady = false;
		presentedPosition = undefined;
		unmatchedFrames = 0;
		resetFrameEvidence();
		publish("preparing");
	}

	function stop() {
		active = false;
		cancelFrame();
	}

	function onSourceLoading() {
		if (active) {
			reset();
			refresh();
		}
	}

	function onSeeking() {
		if (!active) {
			return;
		}
		cancelFrame();
		awaitingSeek = true;
		hasFrame = false;
		frameReady = false;
		presentedPosition = undefined;
		unmatchedFrames = 0;
		resetFrameEvidence();
		refresh();
	}

	function onSeeked() {
		awaitingSeek = false;
		waiting = false;
		const media = options.media();
		if (
			frameReady &&
			presentedPosition !== undefined &&
			media &&
			Math.abs(presentedPosition - media.currentTime) > 0.5
		) {
			frameReady = false;
			hasFrame = false;
		}
		refresh();
	}

	function onWaiting() {
		const media = options.media();
		if (!active || (media?.paused && hasFrame && !media.seeking)) {
			return;
		}
		cancelFrame();
		waiting = true;
		frameReady = false;
		unmatchedFrames = 0;
		resetFrameEvidence();
		refresh();
	}

	function onStalled() {
		const media = options.media();
		if (media && !media.paused && media.readyState < 3) {
			onWaiting();
		}
	}

	function onPlayable() {
		waiting = false;
		frameObservationsRemaining = MAX_FRAME_OBSERVATIONS;
		refresh();
	}

	function onPlaying() {
		observedPlaying = true;
		const position = options.media()?.currentTime;
		playbackObservationPosition = Number.isFinite(position) ? position : undefined;
		onPlayable();
	}

	function onPaused() {
		const media = options.media();
		if (media && hasFrame && !media.seeking && !awaitingSeek && media.readyState >= 2) {
			frameReady = true;
			waiting = false;
		}
		refresh();
	}

	function onTimeUpdate() {
		if (lastState?.phase !== null) {
			refresh();
		}
	}

	function onVisibilityChange() {
		if (attached?.ownerDocument.hidden) {
			cancelFrame();
		} else {
			frameObservationsRemaining = MAX_FRAME_OBSERVATIONS;
			refresh();
		}
	}

	function onError() {
		// A queued error from a detached source can arrive after the new source reset its error.
		if (options.media()?.error) {
			stop();
		}
	}

	const listeners: Partial<Record<keyof HTMLMediaElementEventMap, () => void>> = {
		loadstart: onSourceLoading,
		emptied: onSourceLoading,
		loadedmetadata: refresh,
		loadeddata: refresh,
		canplay: onPlayable,
		playing: onPlaying,
		seeking: onSeeking,
		seeked: onSeeked,
		waiting: onWaiting,
		stalled: onStalled,
		pause: onPaused,
		ended: onPaused,
		progress: refresh,
		timeupdate: onTimeUpdate,
		error: onError,
	};

	function attach() {
		if (disposed || attached || !options.media()) {
			return;
		}
		attached = options.media();
		for (const [event, handler] of Object.entries(listeners)) {
			attached!.addEventListener(event, handler);
		}
		attached!.ownerDocument.addEventListener("visibilitychange", onVisibilityChange);
	}

	function dispose() {
		stop();
		disposed = true;
		for (const [event, handler] of Object.entries(listeners)) {
			attached?.removeEventListener(event, handler);
		}
		attached?.ownerDocument.removeEventListener("visibilitychange", onVisibilityChange);
		attached = undefined;
	}

	return { attach, reset, refresh, stop, dispose };
}
