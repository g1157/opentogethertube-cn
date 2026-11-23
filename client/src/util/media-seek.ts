/**
 * Below this distance a hard seek costs more than it corrects: pausing and seeking a
 * playing element flushes the audio pipeline, which is audible as a stutter. The playback
 * sync dead band and the preparation tolerance are both at least this wide, so skipping
 * the seek does not make either state machine inconsistent.
 */
const SEEK_TOLERANCE_SECONDS = 0.25;

/** Hold native playback while a new position is being fetched and decoded. */
export function createMediaSeek(getMedia: () => HTMLVideoElement | undefined) {
	let target: number | null = null;

	function seek(position: number) {
		const media = getMedia();
		if (!media || !Number.isFinite(position) || position < 0) {
			return;
		}
		if (Math.abs(media.currentTime - position) <= SEEK_TOLERANCE_SECONDS) {
			return;
		}
		// Set the hold before pause: a parent's pause handler may immediately request play.
		target = position;
		media.pause();
		try {
			media.currentTime = position;
		} catch (error) {
			target = null;
			throw error;
		}
	}

	function ready() {
		const media = getMedia();
		// A completed seek with current-frame data is enough to restart fetching. Some
		// mobile browsers will not preload future data until play() is requested again.
		if (!media || media.error || media.seeking || media.readyState < 2) {
			return false;
		}
		if (target !== null && Math.abs(media.currentTime - target) > 0.5) {
			return false;
		}
		target = null;
		return true;
	}

	return {
		seek,
		ready,
		pending: () => target !== null,
		reset: () => {
			target = null;
		},
	};
}
