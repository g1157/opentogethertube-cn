import express from "express";
import { z } from "zod";
import { getLogger } from "../logger.js";

const log = getLogger("api/danmaku");

/**
 * The girigiri search and danmaku proxy. The site has no public API: the search is the
 * maccms suggest endpoint, and a track URL is derived from the video URL embedded in the
 * play page. Everything here is done server-side so a viewer whose network cannot reach
 * girigiri still gets comments through this origin, and a track is fetched upstream once
 * and then served from cache.
 */
const GIRIGIRI_ORIGIN = "https://ani.girigirilove.com";
const GIRIGIRI_TRACK_HOST = "danmu.girigirilove.com";
const GIRIGIRI_HOST_SUFFIX = "girigirilove.com";
const UPSTREAM_TIMEOUT_MS = 10_000;
const TRACK_TIMEOUT_MS = 15_000;
const SEARCH_TTL_MS = 10 * 60_000;
const EPISODES_TTL_MS = 60 * 60_000;
const TRACK_TTL_MS = 24 * 60 * 60_000;
/** Bounded caches; a track is a few hundred kilobytes. */
const SEARCH_CACHE_MAX = 64;
const EPISODES_CACHE_MAX = 32;
const TRACK_CACHE_MAX = 64;

interface CacheEntry<T> {
	value: T;
	expiresAt: number;
}

function createCache<T>(ttlMs: number, maxEntries: number) {
	const entries = new Map<string, CacheEntry<T>>();
	return {
		get(key: string): T | undefined {
			const entry = entries.get(key);
			if (!entry) {
				return undefined;
			}
			if (entry.expiresAt <= Date.now()) {
				entries.delete(key);
				return undefined;
			}
			// Refresh recency: the oldest key is the one evicted next.
			entries.delete(key);
			entries.set(key, entry);
			return entry.value;
		},
		set(key: string, value: T) {
			entries.set(key, { value, expiresAt: Date.now() + ttlMs });
			while (entries.size > maxEntries) {
				const oldest = entries.keys().next().value;
				if (oldest === undefined) {
					break;
				}
				entries.delete(oldest);
			}
		},
	};
}

const searchCache = createCache<GirigiriSearchResult[]>(SEARCH_TTL_MS, SEARCH_CACHE_MAX);
const episodesCache = createCache<GirigiriLine[]>(EPISODES_TTL_MS, EPISODES_CACHE_MAX);
const trackCache = createCache<string>(TRACK_TTL_MS, TRACK_CACHE_MAX);

export interface GirigiriSearchResult {
	id: number;
	name: string;
	poster: string;
}

export interface GirigiriEpisode {
	number: number;
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

async function fetchText(url: string, timeoutMs = UPSTREAM_TIMEOUT_MS): Promise<string | null> {
	try {
		const response = await fetch(url, {
			signal: AbortSignal.timeout(timeoutMs),
			headers: { "User-Agent": "opentogethertube-cn/danmaku-proxy", Accept: "*/*" },
		});
		if (!response.ok) {
			return null;
		}
		return await response.text();
	} catch (err) {
		// A source that is down or slow must degrade to an empty track, never to an error
		// the client has to handle.
		log.debug(`girigiri fetch failed: ${url}`, err);
		return null;
	}
}

const suggestSchema = z.object({
	list: z
		.array(
			z.object({
				id: z.coerce.number().int().positive(),
				name: z.string().min(1),
				pic: z.string().catch(""),
			}),
		)
		.catch([]),
});

function parseSuggest(body: string): GirigiriSearchResult[] {
	try {
		const parsed = suggestSchema.safeParse(JSON.parse(body));
		if (!parsed.success) {
			return [];
		}
		return parsed.data.list.map(item => ({
			id: item.id,
			name: item.name,
			poster: item.pic.startsWith("/") ? `${GIRIGIRI_ORIGIN}${item.pic}` : item.pic,
		}));
	} catch {
		return [];
	}
}

/** The play page keeps its own episode links; the page lists every line at once. */
function parseEpisodeLines(html: string, id: string): GirigiriLine[] {
	const pattern = new RegExp(`/playGV${id}-(\\d{1,3})-(\\d{1,4})/`, "g");
	const byLine = new Map<number, Set<number>>();
	for (const match of html.matchAll(pattern)) {
		const line = Number.parseInt(match[1], 10);
		const episode = Number.parseInt(match[2], 10);
		let episodes = byLine.get(line);
		if (!episodes) {
			episodes = new Set();
			byLine.set(line, episodes);
		}
		episodes.add(episode);
	}
	return [...byLine.entries()]
		.sort((a, b) => a[0] - b[0])
		.map(([line, episodes]) => ({
			line,
			episodes: [...episodes]
				.sort((a, b) => a - b)
				.map(number => ({ number, page: `/playGV${id}-${line}-${number}/` })),
		}));
}

const PLAYER_DATA = /player_aaaa=(\{.*?\})\s*<\/script>/s;
const PLAYER_DATA_LOOSE = /player_aaaa=(\{.*?\});/s;
const ABSOLUTE_URL = /^https?:\/\//;

/** `player_aaaa.url` is base64 over a percent-encoded video URL. */
function parsePlayerUrl(html: string): string | null {
	const match = html.match(PLAYER_DATA) ?? html.match(PLAYER_DATA_LOOSE);
	if (!match) {
		return null;
	}
	try {
		const data = JSON.parse(match[1]) as { url?: unknown };
		if (typeof data.url !== "string" || data.url === "") {
			return null;
		}
		const decoded = decodeURIComponent(Buffer.from(data.url, "base64").toString("utf8"));
		return ABSOLUTE_URL.test(decoded) ? decoded : null;
	} catch {
		return null;
	}
}

const TRACK_PAGE = /^\/playGV\d{1,10}-\d{1,3}-\d{1,4}\/$/;
const SHOW_ID = /^\d{1,10}$/;

const router = express.Router();

router.get("/girigiri/search", async (req, res) => {
	const wd = typeof req.query.wd === "string" ? req.query.wd.trim() : "";
	if (wd.length === 0 || wd.length > 64) {
		res.status(400).json({ results: [] });
		return;
	}
	const cached = searchCache.get(wd);
	if (cached) {
		res.json({ results: cached });
		return;
	}
	const body = await fetchText(
		`${GIRIGIRI_ORIGIN}/index.php/ajax/suggest?mid=1&wd=${encodeURIComponent(wd)}`,
	);
	if (body === null) {
		res.status(502).json({ results: [] });
		return;
	}
	const results = parseSuggest(body);
	searchCache.set(wd, results);
	res.json({ results });
});

router.get("/girigiri/episodes", async (req, res) => {
	const id = typeof req.query.id === "string" ? req.query.id.trim() : "";
	if (!SHOW_ID.test(id)) {
		res.status(400).json({ lines: [] });
		return;
	}
	const cached = episodesCache.get(id);
	if (cached) {
		res.json({ lines: cached });
		return;
	}
	const html = await fetchText(`${GIRIGIRI_ORIGIN}/playGV${id}-1-1/`);
	if (html === null) {
		res.status(502).json({ lines: [] });
		return;
	}
	const lines = parseEpisodeLines(html, id);
	if (lines.length === 0) {
		res.status(404).json({ lines: [] });
		return;
	}
	episodesCache.set(id, lines);
	res.json({ lines });
});

router.get("/girigiri/track", async (req, res) => {
	const page = typeof req.query.page === "string" ? req.query.page : "";
	if (!TRACK_PAGE.test(page)) {
		res.status(400).json({ error: "invalid page" });
		return;
	}
	const cached = trackCache.get(page);
	if (cached) {
		sendXml(res, cached);
		return;
	}
	const html = await fetchText(`${GIRIGIRI_ORIGIN}${page}`);
	const videoUrl = html === null ? null : parsePlayerUrl(html);
	const trackUrl = videoUrl === null ? null : girigiriTrackPath(videoUrl);
	if (trackUrl === null) {
		res.status(502).json({ error: "could not resolve the track" });
		return;
	}
	const xml = await fetchText(trackUrl, TRACK_TIMEOUT_MS);
	if (xml === null || !xml.includes("<d ")) {
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
