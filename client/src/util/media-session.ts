/**
 * Lock-screen, headset and media-key integration. A watch party keeps playing while the
 * viewer does something else, so the OS-level controls are the ones they actually reach
 * for; browsers without the API simply get their existing behavior.
 */
export interface MediaSessionMetadata {
	title: string;
	artist?: string;
	album?: string;
	artwork?: string;
}

export interface MediaSessionPositionState {
	duration: number;
	position: number;
	playbackRate: number;
}

interface MediaSessionOptions {
	getMetadata: () => MediaSessionMetadata | null;
	getPositionState: () => MediaSessionPositionState | null;
	getPlaybackState: () => MediaSessionPlaybackState;
	onPlay: () => void;
	onPause: () => void;
	onSeekTo: (position: number) => void;
}

/** Position updates are cheap but pointless at the player's 250 ms cadence. */
const POSITION_UPDATE_INTERVAL_MS = 1000;

export function installMediaSession(options: MediaSessionOptions) {
	if (typeof navigator === "undefined" || !("mediaSession" in navigator)) {
		return { update: (_force?: boolean) => undefined, dispose: () => undefined };
	}
	const session = navigator.mediaSession;
	let lastPositionUpdateAt = 0;
	let disposed = false;

	function setHandler(action: MediaSessionAction, handler: MediaSessionActionHandler) {
		try {
			session.setActionHandler(action, handler);
		} catch {
			// Actions the browser does not know are not an error.
		}
	}

	setHandler("play", () => options.onPlay());
	setHandler("pause", () => options.onPause());
	setHandler("seekto", details => {
		if (typeof details.seekTime === "number" && Number.isFinite(details.seekTime)) {
			options.onSeekTo(details.seekTime);
		}
	});

	function update(force = false) {
		if (disposed) {
			return;
		}
		const now = Date.now();
		if (!force && now - lastPositionUpdateAt < POSITION_UPDATE_INTERVAL_MS) {
			return;
		}
		lastPositionUpdateAt = now;
		const metadata = options.getMetadata();
		if (metadata && metadata.title) {
			try {
				session.metadata =
					typeof MediaMetadata === "undefined"
						? null
						: new MediaMetadata({
								title: metadata.title,
								artist: metadata.artist,
								album: metadata.album,
								artwork: metadata.artwork ? [{ src: metadata.artwork }] : undefined,
							});
			} catch {
				// Metadata is decoration; a rejection must not break playback.
			}
		} else {
			session.metadata = null;
		}
		try {
			session.playbackState = options.getPlaybackState();
		} catch {
			// An unsupported playback state must not stop the position update below.
		}
		const state = options.getPositionState();
		if (!state || !Number.isFinite(state.duration) || state.duration <= 0) {
			// Sources without a known duration still show metadata and transport state.
			return;
		}
		try {
			session.setPositionState({
				duration: state.duration,
				position: Math.min(Math.max(state.position, 0), state.duration),
				playbackRate: state.playbackRate > 0 ? state.playbackRate : 1,
			});
		} catch {
			// Browsers reject inconsistent position states; the next update retries.
		}
	}

	return {
		update,
		dispose() {
			disposed = true;
			session.metadata = null;
			try {
				session.playbackState = "none";
				session.setPositionState();
			} catch {
				// Clearing is best effort.
			}
			for (const action of ["play", "pause", "seekto"] as MediaSessionAction[]) {
				try {
					session.setActionHandler(action, null);
				} catch {
					// Clearing an action the browser does not know is fine.
				}
			}
		},
	};
}
