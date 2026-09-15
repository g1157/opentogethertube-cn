import express from "express";
import { z } from "zod";
import { getThumbnailFrame } from "../thumbnails.js";
import { getLogger } from "../logger.js";

const log = getLogger("api/thumbnails");

const MAX_URL_LENGTH = 2048;
/** A scrub can ask for several previews a second; this bounds one client's share. */
const RATE_LIMIT_WINDOW_MS = 10_000;
const RATE_LIMIT_MAX = 30;

const querySchema = z.object({
	url: z.string().min(1).max(MAX_URL_LENGTH),
	time: z.coerce.number().finite().min(0),
});

const requests = new Map<string, number[]>();

function isRateLimited(key: string, now: number) {
	const timestamps = (requests.get(key) ?? []).filter(at => now - at < RATE_LIMIT_WINDOW_MS);
	if (timestamps.length >= RATE_LIMIT_MAX) {
		requests.set(key, timestamps);
		return true;
	}
	timestamps.push(now);
	requests.set(key, timestamps);
	if (requests.size > 1024) {
		for (const [address, times] of requests) {
			if (times.every(at => now - at >= RATE_LIMIT_WINDOW_MS)) {
				requests.delete(address);
			}
		}
	}
	return false;
}

const router = express.Router();

/**
 * A preview frame for the progress bar. Frames come from the same public source the
 * viewer's player uses; nothing is stored beyond the process's small LRU cache.
 */
router.get("/frame", async (req, res) => {
	const source = req.ip ?? req.socket.remoteAddress ?? "unknown";
	if (isRateLimited(source, Date.now())) {
		res.sendStatus(429);
		return;
	}
	const parsed = querySchema.safeParse(req.query);
	if (!parsed.success) {
		res.sendStatus(400);
		return;
	}
	try {
		const frame = await getThumbnailFrame(parsed.data.url, parsed.data.time);
		if (!frame) {
			res.sendStatus(404);
			return;
		}
		res.setHeader("Content-Type", "image/jpeg");
		// A frame for a time bucket never changes; let the browser keep it.
		res.setHeader("Cache-Control", "private, max-age=3600");
		res.send(frame.jpeg);
	} catch (error) {
		// A private address, an unresolvable host or a rejected URL are all client errors.
		log.debug(`thumbnail request rejected: ${String(error)}`);
		res.sendStatus(400);
	}
});

export default router;
