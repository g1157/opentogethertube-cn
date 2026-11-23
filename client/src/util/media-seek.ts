/**
 * Below this distance a hard seek costs more than it corrects: pausing and seeking a
 * playing element flushes the audio pipeline, which is audible as a stutter. The playback
 * sync dead band and the preparation tolerance are both at least this wide, so skipping
 * the seek does not make either state machine inconsistent.
 */
const SEEK_TOLERANCE_SECONDS = 0.25;

/**
 * A paused element has no audio pipeline running to flush, so it can be placed on the exact
 * frame the room named. Viewers frozen a fraction of a second apart after a pause are the
 * symptom of applying the playing tolerance here.
 */
const PAUSED_SEEK_TOLERANCE_SECONDS = 0.02;

/** Hold native playback while a new position is being fetched and decoded. */
export function createMediaSeek(getMedia: () => HTMLVideoElement | undefined) {
	let target: number | null = null;

	function seek(position: number) {
		const media = getMedia();
		if (!media || !Number.isFinite(position) || position < 0) {
			return;
		}
		// The element clamps a target past its end, and ready() below would then wait for a
		// position the media does not have. Hold the position that can actually be reached.
		if (Number.isFinite(media.duration) && media.duration > 0 && position > media.duration) {
			position = media.duration;
		}
		const tolerance = media.paused ? PAUSED_SEEK_TOLERANCE_SECONDS : SEEK_TOLERANCE_SECONDS;
		if (Math.abs(media.currentTime - position) <= tolerance) {
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
