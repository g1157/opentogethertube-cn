/**
 * Per-source playback quality, measured on the client because only the client sees
 * startup, rebuffering and real play time. Reports go to the server as counters so the
 * deployment can answer "is playback getting worse?" without any per-viewer records.
 */
export interface PlaybackQualityReport {
	service: string;
	/** Seconds from source load to the first playing frame; null when it never played. */
	startup: number | null;
	rebuffers: number;
	rebufferSeconds: number;
	playSeconds: number;
	seeks: number;
	errors: number;
}

interface PlaybackQualityOptions {
	service: () => string | null;
	send: (report: PlaybackQualityReport) => void;
	now?: () => number;
}

/** Shorter sessions say nothing useful about quality and are not reported. */
const MIN_REPORTABLE_PLAY_SECONDS = 5;

export function createPlaybackQuality(options: PlaybackQualityOptions) {
	const now = options.now ?? (() => Date.now());
	let service: string | null = null;
	let loadedAt: number | null = null;
	let startup: number | null = null;
	let hasPlayed = false;
	let playing = false;
	let playingSince: number | null = null;
	let bufferingSince: number | null = null;
	let playSeconds = 0;
	let rebufferSeconds = 0;
	let rebuffers = 0;
	let seeks = 0;
	let errors = 0;

	function collectPlayTime() {
		if (playingSince !== null) {
			playSeconds += (now() - playingSince) / 1000;
			playingSince = null;
		}
	}

	function resetReport() {
		playSeconds = 0;
		rebufferSeconds = 0;
		rebuffers = 0;
		seeks = 0;
		errors = 0;
	}

	function resetSource() {
		loadedAt = now();
		startup = null;
		hasPlayed = false;
		playing = false;
		playingSince = null;
		bufferingSince = null;
		resetReport();
	}

	function build(): PlaybackQualityReport | null {
		if (service === null || playSeconds < MIN_REPORTABLE_PLAY_SECONDS) {
			return null;
		}
		return {
			service,
			startup: startup === null ? null : Math.round(startup * 1000) / 1000,
			rebuffers,
			rebufferSeconds: Math.round(rebufferSeconds * 1000) / 1000,
			playSeconds: Math.round(playSeconds),
			seeks,
			errors,
		};
	}

	/** Report what has accumulated so far; safe to call mid-session. */
	function flush() {
		collectPlayTime();
		const report = build();
		if (report) {
			options.send(report);
		}
		resetReport();
		if (playing && bufferingSince === null) {
			playingSince = now();
		}
	}

	return {
		noteSourceChanged(nextService: string | null) {
			if (service !== null) {
				flush();
			}
			service = nextService;
			resetSource();
		},
		notePlaying(nextPlaying: boolean) {
			if (nextPlaying === playing) {
				return;
			}
			playing = nextPlaying;
			if (nextPlaying) {
				hasPlayed = true;
				if (startup === null && loadedAt !== null) {
					startup = (now() - loadedAt) / 1000;
				}
				if (bufferingSince === null) {
					playingSince = now();
				}
				return;
			}
			collectPlayTime();
		},
		noteBuffering(nextBuffering: boolean) {
			if (nextBuffering) {
				if (bufferingSince !== null || !hasPlayed) {
					// The first load is startup, not a rebuffer.
					return;
				}
				bufferingSince = now();
				collectPlayTime();
				return;
			}
			if (bufferingSince === null) {
				return;
			}
			rebuffers++;
			rebufferSeconds += (now() - bufferingSince) / 1000;
			bufferingSince = null;
			if (playing) {
				playingSince = now();
			}
		},
		noteSeek() {
			seeks++;
		},
		noteError() {
			errors++;
		},
		flush,
	};
}

function qualityUrl() {
	const base = (import.meta.env.OTT_BASE_URL as string | undefined) ?? "";
	return `${base}/api/playback/quality`;
}

/**
 * Fire-and-forget report. A beacon survives the page being closed, which is exactly when
 * most sessions end; fetch with keepalive is the fallback where beacons are unavailable.
 */
export function sendPlaybackQualityReport(report: PlaybackQualityReport) {
	const body = JSON.stringify(report);
	try {
		if (typeof navigator !== "undefined" && typeof navigator.sendBeacon === "function") {
			const blob = new Blob([body], { type: "application/json" });
			if (navigator.sendBeacon(qualityUrl(), blob)) {
				return;
			}
		}
	} catch {
		// Fall through to fetch.
	}
	try {
		void fetch(qualityUrl(), {
			method: "POST",
			body,
			headers: { "Content-Type": "application/json" },
			keepalive: true,
			credentials: "same-origin",
		}).catch(() => undefined);
	} catch {
		// Reporting must never affect playback.
	}
}
