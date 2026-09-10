/** Hold native playback while a new position is being fetched and decoded. */
export function createMediaSeek(getMedia: () => HTMLVideoElement | undefined) {
	let target: number | null = null;

	function seek(position: number) {
		const media = getMedia();
		if (!media || !Number.isFinite(position) || position < 0) {
			return;
		}
		if (Math.abs(media.currentTime - position) <= 0.05) {
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
