import express from "express";
import { z } from "zod";
import { Counter, Histogram } from "prom-client";
import { getLogger } from "../logger.js";
import { ALL_VIDEO_SERVICES } from "ott-common/constants.js";

// biome-ignore lint/correctness/noUnusedVariables: biome migration
const log = getLogger("api/playback");

/** Anything longer than a day is a broken client or a forgery, not a viewing session. */
const MAX_SECONDS = 24 * 60 * 60;
const MAX_EVENTS = 100_000;
/** Reports are counters, not events; one every few seconds per client is plenty. */
const REPORT_INTERVAL_MS = 5000;

const reportSchema = z.object({
	service: z.string().min(1).max(32),
	startup: z.number().finite().min(0).max(MAX_SECONDS).nullable(),
	rebuffers: z.number().int().min(0).max(MAX_EVENTS),
	rebufferSeconds: z.number().finite().min(0).max(MAX_SECONDS),
	playSeconds: z.number().finite().min(0).max(MAX_SECONDS),
	seeks: z.number().int().min(0).max(MAX_EVENTS),
	errors: z.number().int().min(0).max(MAX_EVENTS),
	// Sync diagnosis and dropped-frame counters. Optional so a cached older client (the
	// frontend reloads within minutes of a deploy) still validates.
	rateWrites: z.number().int().min(0).max(MAX_EVENTS).optional(),
	deadlineSeeks: z.number().int().min(0).max(MAX_EVENTS).optional(),
	maxDriftSeconds: z.number().finite().min(0).max(MAX_SECONDS).optional(),
	totalFrames: z.number().int().min(0).max(MAX_EVENTS).optional(),
	droppedFrames: z.number().int().min(0).max(MAX_EVENTS).optional(),
});

/**
 * The service string is a Prometheus label: arbitrary values would create a new time
 * series per unique attacker string and blow up both the registry and Prometheus.
 * Everything outside the known services collapses into "other".
 */
function metricServiceLabel(service: string): string {
	if (service === "other" || (ALL_VIDEO_SERVICES as readonly string[]).includes(service)) {
		return service;
	}
	return "other";
}

const counterStartupSamples = new Counter({
	name: "ott_playback_startup_samples",
	help: "Playback sessions that reached a first frame, by service",
	labelNames: ["service"],
});

const histogramStartupSeconds = new Histogram({
	name: "ott_playback_startup_seconds",
	help: "Seconds from source load to the first playing frame",
	labelNames: ["service"],
	buckets: [0.5, 1, 2, 4, 8, 15, 30, 60],
});

const counterRebuffers = new Counter({
	name: "ott_playback_rebuffers",
	help: "Playback stalls after playback had started, by service",
	labelNames: ["service"],
});

const counterRebufferSeconds = new Counter({
	name: "ott_playback_rebuffer_seconds",
	help: "Time spent stalled after playback had started, by service",
	labelNames: ["service"],
});

const counterPlaySeconds = new Counter({
	name: "ott_playback_play_seconds",
	help: "Time actually played, by service",
	labelNames: ["service"],
});

const counterSeeks = new Counter({
	name: "ott_playback_seeks",
	help: "Seeks performed by the client, including room sync corrections",
	labelNames: ["service"],
});

const counterErrors = new Counter({
	name: "ott_playback_errors",
	help: "Player errors reported by clients, by service",
	labelNames: ["service"],
});

const counterRateWrites = new Counter({
	name: "ott_playback_rate_writes",
	help: "playbackRate writes the sync engine sent to the player, by service",
	labelNames: ["service"],
});

const counterDeadlineSeeks = new Counter({
	name: "ott_playback_deadline_seeks",
	help: "Rate-bend deadlines that ended in a visible seek, by service",
	labelNames: ["service"],
});

const histogramMaxDrift = new Histogram({
	name: "ott_playback_max_drift_seconds",
	help: "Largest room-clock drift seen per source, by service",
	labelNames: ["service"],
	buckets: [0.15, 0.3, 0.5, 1, 3, 10],
});

const counterTotalFrames = new Counter({
	name: "ott_playback_total_frames",
	help: "Video frames produced by the media pipeline, by service",
	labelNames: ["service"],
});

const counterDroppedFrames = new Counter({
	name: "ott_playback_dropped_frames",
	help: "Video frames dropped rather than displayed, by service",
	labelNames: ["service"],
});

const lastReportAt = new Map<string, number>();

/**
 * One report per client per interval. Reports are cumulative counters, so a burst adds
 * nothing; the map is pruned once it grows past the size one process should track.
 */
export function isRateLimited(key: string, now: number) {
	const last = lastReportAt.get(key) ?? 0;
	if (now - last < REPORT_INTERVAL_MS) {
		return true;
	}
	lastReportAt.set(key, now);
	if (lastReportAt.size > 1024) {
		for (const [address, at] of lastReportAt) {
			if (now - at > 60_000) {
				lastReportAt.delete(address);
			}
		}
	}
	return false;
}

const router = express.Router();

/**
 * Anonymous, fire-and-forget quality counters from clients. Nothing here is stored per
 * viewer; the values feed the same Prometheus registry the rest of the server uses, so
 * "did playback get worse after this deploy?" is answerable without session records.
 */
router.post("/quality", (req, res) => {
	const now = Date.now();
	const source = req.ip ?? req.socket.remoteAddress ?? "unknown";
	if (isRateLimited(source, now)) {
		res.sendStatus(429);
		return;
	}
	const result = reportSchema.safeParse(req.body);
	if (!result.success) {
		res.sendStatus(400);
		return;
	}
	const report = result.data;
	const labels = { service: metricServiceLabel(report.service) };
	counterPlaySeconds.inc(labels, report.playSeconds);
	counterSeeks.inc(labels, report.seeks);
	counterErrors.inc(labels, report.errors);
	if (report.startup !== null) {
		counterStartupSamples.inc(labels, 1);
		histogramStartupSeconds.observe(labels, report.startup);
	}
	if (report.rebuffers > 0) {
		counterRebuffers.inc(labels, report.rebuffers);
	}
	counterRebufferSeconds.inc(labels, report.rebufferSeconds);
	if (report.rateWrites !== undefined) {
		counterRateWrites.inc(labels, report.rateWrites);
	}
	if (report.deadlineSeeks !== undefined) {
		counterDeadlineSeeks.inc(labels, report.deadlineSeeks);
	}
	if (report.maxDriftSeconds !== undefined) {
		histogramMaxDrift.observe(labels, report.maxDriftSeconds);
	}
	if (report.totalFrames !== undefined) {
		counterTotalFrames.inc(labels, report.totalFrames);
	}
	if (report.droppedFrames !== undefined) {
		counterDroppedFrames.inc(labels, report.droppedFrames);
	}
	res.sendStatus(204);
});

export default router;
