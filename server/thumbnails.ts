import childProcess from "node:child_process";
import { getLogger } from "./logger.js";
import { assertPublicMediaUrl } from "./ffprobe.js";

const log = getLogger("thumbnails");

/** One extraction is a seek plus one decoded frame; this bounds the whole attempt. */
const THUMBNAIL_TIMEOUT_MS = 20_000;
/** Bounds a stalled upstream read inside ffmpeg itself. */
const READ_TIMEOUT_US = 12_000_000;
const TILE_WIDTH = 160;
/** JPEG quality scale for ffmpeg (2 best, 31 worst). */
const JPEG_QUALITY = 6;
/** Hover positions repeat and a scrub lands on many; the cache makes most of them free. */
const MAX_CACHE_ENTRIES = 200;
/** Preview times closer than this show the same picture. */
export const TIME_BUCKET_SECONDS = 5;
/** One extraction at a time keeps this small VM from being starved by preview work. */
const MAX_CONCURRENT = 1;
const MAX_TIME_SECONDS = 24 * 60 * 60;

interface CachedThumbnail {
	jpeg: Buffer;
}

const cache = new Map<string, CachedThumbnail>();
let running = 0;
const waiting: Array<() => void> = [];
let ffmpegUnavailable = false;

function acquireSlot(): Promise<void> {
	if (running < MAX_CONCURRENT) {
		running++;
		return Promise.resolve();
	}
	return new Promise(resolve => {
		waiting.push(() => {
			running++;
			resolve();
		});
	});
}

function releaseSlot() {
	running--;
	const next = waiting.shift();
	if (next) {
		next();
	}
}

function cacheKey(url: string, time: number) {
	const bucket = Math.floor(time / TIME_BUCKET_SECONDS) * TIME_BUCKET_SECONDS;
	return `${bucket}:${url}`;
}

function remember(key: string, jpeg: Buffer) {
	cache.set(key, { jpeg });
	while (cache.size > MAX_CACHE_ENTRIES) {
		const oldest = cache.keys().next().value;
		if (oldest === undefined) {
			break;
		}
		cache.delete(oldest);
	}
}

/** Extract one preview frame, or null when ffmpeg is missing or the source has no frame there. */
function extractFrame(url: string, time: number): Promise<Buffer | null> {
	return new Promise(resolve => {
		let settled = false;
		const finish = (result: Buffer | null) => {
			if (!settled) {
				settled = true;
				clearTimeout(timer);
				resolve(result);
			}
		};
		const child = childProcess.spawn(
			"ffmpeg",
			[
				"-hide_banner",
				"-loglevel",
				"error",
				"-rw_timeout",
				String(READ_TIMEOUT_US),
				// Seek before the input so ffmpeg does not decode everything up to it.
				"-ss",
				time.toFixed(3),
				"-i",
				url,
				"-frames:v",
				"1",
				"-vf",
				`scale=${TILE_WIDTH}:-2`,
				"-f",
				"mjpeg",
				"-q:v",
				String(JPEG_QUALITY),
				"pipe:1",
			],
			{ stdio: ["ignore", "pipe", "ignore"] },
		);
		const chunks: Buffer[] = [];
		child.stdout?.on("data", chunk => chunks.push(Buffer.from(chunk)));
		const timer = setTimeout(() => {
			try {
				child.kill("SIGKILL");
			} catch {
				// The child may already be gone.
			}
			finish(null);
		}, THUMBNAIL_TIMEOUT_MS);
		child.once("error", error => {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") {
				ffmpegUnavailable = true;
				// The operator needs to know why previews stop appearing.
				log.warn("ffmpeg is not installed; previews are disabled");
			}
			finish(null);
		});
		child.once("close", () => {
			const jpeg = Buffer.concat(chunks);
			// An error frame is empty or a partial header; require a plausible JPEG.
			finish(jpeg.length > 512 && jpeg[0] === 0xff && jpeg[1] === 0xd8 ? jpeg : null);
		});
	});
}

export interface ThumbnailResult {
	jpeg: Buffer;
	/** True when a cache entry, rather than this request's own extraction, answered. */
	cached: boolean;
	time: number;
}

const inFlight = new Map<string, Promise<Buffer | null>>();

function cachedResult(key: string, jpeg: Buffer): ThumbnailResult {
	return { jpeg, cached: true, time: Number(key.slice(0, key.indexOf(":"))) };
}

/**
 * A preview frame for a user supplied media URL. This is deliberately bounded: one seek,
 * one decoded frame, one small JPEG, one at a time, cached by URL and time bucket. Two
 * viewers hovering the same second wait on one extraction instead of starting two.
 */
export async function getThumbnailFrame(
	url: string,
	time: number,
): Promise<ThumbnailResult | null> {
	if (ffmpegUnavailable) {
		return null;
	}
	if (!Number.isFinite(time) || time < 0 || time > MAX_TIME_SECONDS) {
		return null;
	}
	await assertPublicMediaUrl(url);
	const key = cacheKey(url, time);
	const hit = cache.get(key);
	if (hit) {
		// Refresh insertion order so the map evicts the least recently used entry.
		cache.delete(key);
		remember(key, hit.jpeg);
		return cachedResult(key, hit.jpeg);
	}
	// Waiting for the slot can take as long as another extraction; re-check afterwards so a
	// request that arrived meanwhile joins the work instead of repeating it.
	await acquireSlot();
	const shared = inFlight.get(key);
	if (shared) {
		releaseSlot();
		const jpeg = await shared;
		return jpeg ? cachedResult(key, jpeg) : null;
	}
	const task = (async () => {
		try {
			return await extractFrame(url, time);
		} finally {
			releaseSlot();
		}
	})();
	inFlight.set(key, task);
	try {
		const jpeg = await task;
		if (!jpeg) {
			return null;
		}
		remember(key, jpeg);
		return { jpeg, cached: false, time: Number(key.slice(0, key.indexOf(":"))) };
	} finally {
		inFlight.delete(key);
	}
}

/** Test seam: the cache is process state, exactly like the ffprobe child set. */
export function clearThumbnailCache() {
	cache.clear();
	inFlight.clear();
	ffmpegUnavailable = false;
}
