/**
 * Per-source playback quality, measured on the client because only the client sees
 * startup, rebuffering and real play time. Reports go to the server as counters so the
 * deployment can answer "is playback getting worse?" without any per-viewer records.
 *
 * The counter set follows the one the industry converges on for this — startup time,
 * rebuffering, dropped frames, errors (what Netflix/YouTube-style QoE dashboards read) —
 * plus this fork's sync diagnosis counters. Deliberately per-session aggregates, not the
 * per-second samples a full ITU-T P.1203 quality model would need.
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
	/** Sync-engine deltas: rate writes actually sent to the player (the "4 Hz re-timing"
	 * diagnosis) and bend deadlines that ended in a visible seek. */
	rateWrites: number;
	deadlineSeeks: number;
	/** The largest drift the sync engine saw for this source, in seconds. Bending only
	 * engages past 0.3s, so this says whether the field even reaches that zone. */
	maxDriftSeconds: number;
	/** Media-pipeline frame deltas: frames produced and frames dropped rather than
	 * displayed — the industry-standard stutter counters. */
	totalFrames: number;
	droppedFrames: number;
}

interface PlaybackQualityOptions {
	service: () => string | null;
	send: (report: PlaybackQualityReport) => void;
	now?: () => number;
	/** Live sync counters; their per-window deltas ride along with every report. */
	getSyncCounters?: () => { rateWrites: number; deadlineSeeks: number; maxAbsDrift: number };
	/** Media-pipeline frame counters (`getVideoPlaybackQuality`); null when unavailable. */
	getFrameQuality?: () => { total: number; dropped: number } | null;
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
	// Window bases for the counters that keep running between reports.
	let lastSyncCounters = { rateWrites: 0, deadlineSeeks: 0 };
	let lastFrameCounters = { total: 0, dropped: 0 };

	/**
	 * A counter that went backwards was reset under us (a new source, a reloaded media
	 * element); its whole value then belongs to the current window instead of the delta.
	 */
	function deltaOf(current: number, previous: number): number {
		return current >= previous ? current - previous : Math.max(0, current);
	}

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
		const sync = options.getSyncCounters?.();
		const frames = options.getFrameQuality?.() ?? null;
		const rateWrites = sync ? deltaOf(sync.rateWrites, lastSyncCounters.rateWrites) : 0;
		const deadlineSeeks = sync
			? deltaOf(sync.deadlineSeeks, lastSyncCounters.deadlineSeeks)
			: 0;
		const totalFrames = frames ? deltaOf(frames.total, lastFrameCounters.total) : 0;
		const droppedFrames = frames ? deltaOf(frames.dropped, lastFrameCounters.dropped) : 0;
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
			rateWrites,
			deadlineSeeks,
			// A maximum, not a counter: reporting the same value again after a mid-session
			// flush is honest, and the engine resets it per source.
			maxDriftSeconds: sync ? Math.round(sync.maxAbsDrift * 1000) / 1000 : 0,
			totalFrames,
			droppedFrames,
		};
	}

	/** Report what has accumulated so far; safe to call mid-session. */
	function flush() {
		collectPlayTime();
		const report = build();
		if (report) {
			options.send(report);
		}
		// Advance the window bases whether or not the report was worth sending.
		const sync = options.getSyncCounters?.();
		if (sync) {
			lastSyncCounters = { rateWrites: sync.rateWrites, deadlineSeeks: sync.deadlineSeeks };
		}
		const frames = options.getFrameQuality?.() ?? null;
		if (frames) {
			lastFrameCounters = { total: frames.total, dropped: frames.dropped };
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
