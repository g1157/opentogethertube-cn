import { Semaphore } from "@divine/synchronization";
import { readBoundedText } from "ott-common/response-body.js";
import {
	assertDanmakuTrack,
	DANMAKU_CACHE_MAX_BYTES,
	DANMAKU_MAX_CONCURRENT_DOWNLOADS,
	DANMAKU_MAX_XML_BYTES,
} from "ott-common/danmaku.js";
import express from "express";
import { z } from "zod";
import { getLogger } from "../logger.js";
import { consumeRateLimitPoints } from "../rate-limit.js";

const log = getLogger("api/danmaku");

/**
 * The girigiri search and danmaku proxy. The site has no public API: the search is the
 * maccms suggest endpoint, and a track URL is derived from the video URL embedded in the
 * play page. Everything here is done server-side so a viewer whose network cannot reach
 * girigiri still gets comments through this origin, and a track is fetched upstream once
 * and then served from cache.
 */
/**
 * The site moved its data behind a PHP JSON API and renders the pages client-side. The old
 * maccms suggest endpoint and the `/playGV…/` pages now answer with the SPA shell, so every
 * lookup goes through this API; the media host still serves relative posters.
 */
const GIRIGIRI_API_BASE = "https://m3u8.girigirilove.com/api.php";
const GIRIGIRI_POSTER_ORIGIN = "https://ani.girigirilove.com";
const GIRIGIRI_TRACK_HOST = "danmu.girigirilove.com";
const GIRIGIRI_HOST_SUFFIX = "girigirilove.com";
/** The suggest endpoint was capped at ~10; one page of the new list keeps that shape. */
const SEARCH_LIMIT = 30;
const UPSTREAM_TIMEOUT_MS = 10_000;
const TRACK_TIMEOUT_MS = 15_000;
const METADATA_MAX_BYTES = 1024 * 1024;
const METADATA_CACHE_MAX_BYTES = 4 * 1024 * 1024;
const upstreamSlots = new Semaphore(DANMAKU_MAX_CONCURRENT_DOWNLOADS);
const SEARCH_TTL_MS = 10 * 60_000;
const EPISODES_TTL_MS = 60 * 60_000;
const TRACK_TTL_MS = 24 * 60 * 60_000;
/** Failures and empty results are remembered briefly so they cannot be replayed upstream. */
const NEGATIVE_TTL_MS = 60_000;
/** Each girigiri call costs upstream requests; charge a previewAdd-sized rate limit. */
const GIRIGIRI_POINTS = 5;
/** Both entry count and accounted UTF-16 payload bytes are bounded. */
const SEARCH_CACHE_MAX = 64;
const EPISODES_CACHE_MAX = 32;
const TRACK_CACHE_MAX = 64;

interface CacheEntry<T> {
	value: T;
	expiresAt: number;
	bytes: number;
}

function createCache<T>(ttlMs: number, maxEntries: number, maxBytes = METADATA_CACHE_MAX_BYTES) {
	const entries = new Map<string, CacheEntry<T>>();
	let bytes = 0;
	function remove(key: string): void {
		const entry = entries.get(key);
		if (entry) {
			bytes -= entry.bytes;
			entries.delete(key);
		}
	}
	return {
		get(key: string): T | undefined {
			const entry = entries.get(key);
			if (!entry) {
				return undefined;
			}
			if (entry.expiresAt <= Date.now()) {
				remove(key);
				return undefined;
			}
			entries.delete(key);
			entries.set(key, entry);
			return entry.value;
		},
		set(key: string, value: T, ttlMsOverride: number = ttlMs) {
			remove(key);
			// String/JSON payload accounting is not a measurement of V8 heap overhead.
			const payloadBytes =
				value === null
					? 0
					: 2 * (typeof value === "string" ? value.length : JSON.stringify(value).length);
			if (payloadBytes > maxBytes) {
				return;
			}
			entries.set(key, { value, expiresAt: Date.now() + ttlMsOverride, bytes: payloadBytes });
			bytes += payloadBytes;
			while (entries.size > maxEntries || bytes > maxBytes) {
				const oldest = entries.keys().next().value;
				if (oldest === undefined) {
					break;
				}
				remove(oldest);
			}
		},
	};
}

const searchCache = createCache<GirigiriSearchResult[] | null>(SEARCH_TTL_MS, SEARCH_CACHE_MAX);
const episodesCache = createCache<GirigiriLine[] | null>(EPISODES_TTL_MS, EPISODES_CACHE_MAX);
const trackCache = createCache<string | null>(
	TRACK_TTL_MS,
	TRACK_CACHE_MAX,
	DANMAKU_CACHE_MAX_BYTES,
);

export interface GirigiriSearchResult {
	id: number;
	name: string;
	poster: string;
}

export interface GirigiriEpisode {
	number: number;
	/** The upstream video URL this episode plays; a stored binding resolves through it. */
	url: string;
	/** The `/playGV…/` page shape saved by existing bindings and sent back to this server. */
	page: string;
}

export interface GirigiriLine {
	line: number;
	episodes: GirigiriEpisode[];
}

/** Path rules for the girigiri layout, mirroring the client's `util/danmaku/girigiri.ts`. */
const M3U8_SUFFIX = /\.m3u8$/i;
const M3U8_FILENAME = /\/[^/]*\.m3u8$/i;
const FILE_EXTENSION = /\.[^/.]+$/;
const CHT_FOLDER = /CHT\//g;

/**
 * The danmaku file mirrors the video's own path: a direct file lives on the danmu host
 * with an `.xml` extension (CHT resource folders read their CHS sibling), and an HLS pack
 * keeps its track next to the episode folder on the same host.
 */
export function girigiriTrackPath(videoUrl: string): string | null {
	let url: URL;
	try {
		url = new URL(videoUrl);
	} catch {
		return null;
	}
	if (url.protocol !== "https:" && url.protocol !== "http:") {
		return null;
	}
	const host = url.hostname.toLowerCase();
	if (host !== GIRIGIRI_HOST_SUFFIX && !host.endsWith(`.${GIRIGIRI_HOST_SUFFIX}`)) {
		return null;
	}
	if (M3U8_SUFFIX.test(url.pathname)) {
		return `${url.protocol}//${url.host}${url.pathname.replace(M3U8_FILENAME, ".xml")}`;
	}
	if (!FILE_EXTENSION.test(url.pathname)) {
		return null;
	}
	const path = url.pathname.replace(FILE_EXTENSION, ".xml").replace(CHT_FOLDER, "CHS/");
	return `https://${GIRIGIRI_TRACK_HOST}${path}`;
}

/**
 * Why a fetch produced nothing. `busy` means this server had no free upstream slot and
 * never reached girigiri at all — caching that as an upstream failure would keep telling
 * viewers "the track is unavailable" for a minute after a moment of local contention.
 */
type FetchFailure = "busy" | "upstream";

interface FetchOutcome {
	body: string | null;
	failure?: FetchFailure;
}

async function fetchText(
	url: string,
	timeoutMs = UPSTREAM_TIMEOUT_MS,
	maxBytes = METADATA_MAX_BYTES,
): Promise<FetchOutcome> {
	// Reject excess work immediately: no unbounded upstream wait queue or body buffers.
	if (!upstreamSlots.take()) {
		return { body: null, failure: "busy" };
	}
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	timer.unref();
	try {
		const response = await fetch(url, {
			signal: controller.signal,
			headers: { "User-Agent": "opentogethertube-cn/danmaku-proxy", Accept: "*/*" },
		});
		if (!response.ok) {
			// eslint-disable-next-line promise/prefer-await-to-then -- Do not wait on a failed response body.
			void response.body?.cancel().catch(() => {
				// Cancellation is best effort and must not mask the response failure.
			});
			return { body: null, failure: "upstream" };
		}
		return { body: await readBoundedText(response, maxBytes, controller.signal) };
	} catch (err) {
		log.debug("girigiri fetch failed: " + url, err);
		return { body: null, failure: "upstream" };
	} finally {
		clearTimeout(timer);
		upstreamSlots.signal();
	}
}

const searchSchema = z.object({
	code: z.literal(1),
	info: z
		.object({
			rows: z
				.array(
					z.object({
						vod_id: z.coerce.number().int().positive(),
						vod_name: z.string().min(1),
						vod_pic: z.string().catch(""),
					}),
				)
				.catch([]),
		})
		.catch({ rows: [] }),
});

function parseSearch(body: string): GirigiriSearchResult[] {
	try {
		const parsed = searchSchema.safeParse(JSON.parse(body));
		if (!parsed.success) {
			return [];
		}
		return parsed.data.info.rows.map(item => ({
			id: item.vod_id,
			name: item.vod_name,
			poster: !item.vod_pic
				? ""
				: item.vod_pic.startsWith("/")
					? `${GIRIGIRI_POSTER_ORIGIN}${item.vod_pic}`
					: item.vod_pic,
		}));
	} catch {
		return [];
	}
}

const detailSchema = z.object({
	code: z.literal(1),
	info: z.object({
		vod_play_from: z.string().catch(""),
		vod_play_url: z.string().catch(""),
	}),
});

const ABSOLUTE_URL = /^https?:\/\//;

/**
 * `vod_play_from` names each source line (`$$$`-separated) and `vod_play_url` carries the
 * same number of groups, each `#`-separated into `name$url` episodes. Line and episode
 * numbers are 1-based, matching the `/playGV…/` page shape stored in existing bindings.
 */
function parseEpisodeLines(body: string, id: string): GirigiriLine[] {
	let data: z.infer<typeof detailSchema>;
	try {
		const parsed = detailSchema.safeParse(JSON.parse(body));
		if (!parsed.success) {
			return [];
		}
		data = parsed.data;
	} catch {
		return [];
	}
	const lines: GirigiriLine[] = [];
	for (const [sourceIndex, group] of data.info.vod_play_url.split("$$$").entries()) {
		const line = sourceIndex + 1;
		const episodes: GirigiriEpisode[] = [];
		for (const [episodeIndex, entry] of group.split("#").entries()) {
			const url = entry.slice(entry.indexOf("$") + 1).trim();
			if (!ABSOLUTE_URL.test(url)) {
				continue;
			}
			const number = episodeIndex + 1;
			episodes.push({ number, url, page: `/playGV${id}-${line}-${number}/` });
		}
		if (episodes.length > 0) {
			lines.push({ line, episodes });
		}
	}
	return lines;
}

/** Resolve the episode a stored `/playGV…/` binding points at, without a second lookup. */
function findEpisode(
	lines: GirigiriLine[],
	line: number,
	episode: number,
): { line: GirigiriLine; episode: GirigiriEpisode } | null {
	const foundLine = lines.find(entry => entry.line === line);
	const foundEpisode = foundLine?.episodes.find(entry => entry.number === episode);
	return foundLine && foundEpisode ? { line: foundLine, episode: foundEpisode } : null;
}

const TRACK_PAGE = /^\/playGV(\d{1,10})-(\d{1,3})-(\d{1,4})\/$/;
const SHOW_ID = /^\d{1,10}$/;

/** One API call serves both the episode list and a stored binding's play URL. */
function detailUrl(id: string): string {
	const query = new URLSearchParams({ vod_id: id, format: "json" });
	return `${GIRIGIRI_API_BASE}/Vod/get_detail?${query.toString()}`;
}

const router = express.Router();

router.get("/girigiri/search", async (req, res) => {
	if (!(await consumeRateLimitPoints(res, req.ip, GIRIGIRI_POINTS))) {
		return;
	}
	const wd = typeof req.query.wd === "string" ? req.query.wd.trim() : "";
	if (wd.length === 0 || wd.length > 64) {
		res.status(400).json({ results: [] });
		return;
	}
	const cached = searchCache.get(wd);
	if (cached !== undefined) {
		if (cached === null) {
			res.status(502).json({ results: [] });
			return;
		}
		res.json({ results: cached });
		return;
	}
	const query = new URLSearchParams({
		vod_name: wd,
		offset: "0",
		limit: String(SEARCH_LIMIT),
		format: "json",
	});
	const { body, failure } = await fetchText(
		`${GIRIGIRI_API_BASE}/Vod/get_list?${query.toString()}`,
	);
	if (body === null) {
		// A short negative entry stops a failing upstream from being replayed on every hit.
		// Local slot contention is not an upstream failure: caching it would keep every
		// viewer reading "unavailable" for a minute because of one busy moment here.
		if (failure !== "busy") {
			searchCache.set(wd, null, NEGATIVE_TTL_MS);
		}
		res.status(502).json({ results: [] });
		return;
	}
	const results = parseSearch(body);
	// An empty result is as likely to be a hiccup as a real miss; remember it briefly.
	searchCache.set(wd, results, results.length === 0 ? NEGATIVE_TTL_MS : SEARCH_TTL_MS);
	res.json({ results });
});

router.get("/girigiri/episodes", async (req, res) => {
	if (!(await consumeRateLimitPoints(res, req.ip, GIRIGIRI_POINTS))) {
		return;
	}
	const id = typeof req.query.id === "string" ? req.query.id.trim() : "";
	if (!SHOW_ID.test(id)) {
		res.status(400).json({ lines: [] });
		return;
	}
	const cached = episodesCache.get(id);
	if (cached !== undefined) {
		if (cached === null) {
			res.status(404).json({ lines: [] });
			return;
		}
		res.json({ lines: cached });
		return;
	}
	const { body, failure } = await fetchText(detailUrl(id));
	if (body === null) {
		if (failure !== "busy") {
			episodesCache.set(id, null, NEGATIVE_TTL_MS);
		}
		res.status(502).json({ lines: [] });
		return;
	}
	const lines = parseEpisodeLines(body, id);
	if (lines.length === 0) {
		episodesCache.set(id, null, NEGATIVE_TTL_MS);
		res.status(404).json({ lines: [] });
		return;
	}
	episodesCache.set(id, lines);
	res.json({ lines });
});

router.get("/girigiri/track", async (req, res) => {
	if (!(await consumeRateLimitPoints(res, req.ip, GIRIGIRI_POINTS))) {
		return;
	}
	const page = typeof req.query.page === "string" ? req.query.page : "";
	const match = TRACK_PAGE.exec(page);
	if (!match) {
		res.status(400).json({ error: "invalid page" });
		return;
	}
	const cached = trackCache.get(page);
	if (cached !== undefined) {
		if (cached === null) {
			res.status(502).json({ error: "the track is unavailable" });
			return;
		}
		sendXml(res, cached);
		return;
	}
	const [, showId, lineNumber, episodeNumber] = match;
	const detail = await fetchText(detailUrl(showId));
	const lines = detail.body === null ? [] : parseEpisodeLines(detail.body, showId);
	const resolved = findEpisode(lines, Number(lineNumber), Number(episodeNumber));
	const videoUrl = resolved?.episode.url ?? null;
	const trackUrl = videoUrl === null ? null : girigiriTrackPath(videoUrl);
	if (trackUrl === null) {
		// Only local slot contention says nothing about the track; a response that arrived but
		// named no resolvable episode (or an unreachable upstream) is worth remembering.
		if (detail.failure !== "busy") {
			trackCache.set(page, null, NEGATIVE_TTL_MS);
		}
		res.status(502).json({ error: "could not resolve the track" });
		return;
	}
	const track = await fetchText(trackUrl, TRACK_TIMEOUT_MS, DANMAKU_MAX_XML_BYTES);
	let xml = track.body;
	if (xml !== null) {
		try {
			assertDanmakuTrack(xml);
		} catch {
			xml = null;
		}
	}
	// Fewer than one comment, a track that cannot be parsed or an unreachable download: all of them
	// are worth remembering, but not a request that never left this server.
	if (xml === null || !xml.includes("<d ")) {
		if (track.failure !== "busy") {
			trackCache.set(page, null, NEGATIVE_TTL_MS);
		}
		res.status(502).json({ error: "the track is unavailable" });
		return;
	}
	trackCache.set(page, xml);
	sendXml(res, xml);
});

function sendXml(res: express.Response, xml: string) {
	// The upstream cache is a day; keep the same lifetime here so a track is fetched once
	// per episode per server, not once per viewer.
	res.set("Cache-Control", "private, max-age=86400");
	res.type("application/xml").send(xml);
}

export default router;
