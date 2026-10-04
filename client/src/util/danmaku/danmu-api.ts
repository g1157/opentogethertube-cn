import { shallowRef } from "vue";
import { loadDanmaku } from "./fetch";
import type { DanmakuItem } from "./parse";
import type { DanmakuProvider } from "./provider";

/**
 * Client for a self-hosted danmu_api deployment (the dandanplay-compatible aggregator:
 * /api/v2/search/anime, /api/v2/match, /api/v2/comment/{id}?format=xml, whose XML output
 * is Bilibili's format and therefore already understood by parseDanmakuXml).
 *
 * The API cannot be derived from the video URL alone — an episode has to be matched first —
 * so the provider resolves through a small local binding table (video URL -> episode). The
 * layer's best-effort matcher fills it automatically, and the danmaku settings offer a
 * manual search when the matcher is not confident.
 */

export interface DanmakuBinding {
	episodeId: number | string;
	/** Shown to the user: the matched anime and episode. */
	label: string;
}

export interface DanmakuSearchResult {
	animeId: number | string;
	title: string;
	source: string;
}

export interface DanmakuEpisode {
	episodeId: number | string;
	title: string;
}

const STORAGE_KEY = "danmaku-bindings";

/** Folders that never name a show when walking a path for a match query. */
const GENERIC_FOLDERS = new Set([
	"anime",
	"animes",
	"tv",
	"movie",
	"movies",
	"media",
	"video",
	"videos",
	"download",
	"downloads",
	"bd",
	"web",
	"web-dl",
	"hd",
	"fhd",
	"uhd",
	"1080p",
	"720p",
	"2160p",
	"4k",
	"zijian",
	"oldanime",
	"playlist",
	"index",
	"master",
]);
const GENERIC_EXTENSIONS = /\.(mp4|mkv|webm|avi|mov|m4v|flv|ts|m3u8|mpd)$/i;
const SEASON_FOLDER = /^(?:season|s)\s*(\d{1,2})$/i;
const PLAYLIST_NAME = /^(?:playlist|index|master|media|stream)\.(?:m3u8|mpd|mp4)$/i;
const YEAR_SEGMENT = /^(?:19|20)\d{2}$/;
const DATE_SEGMENT = /^\d{1,4}$/;
const TRAILING_SLASHES = /\/+$/;
const SEASON_EPISODE = /s(\d{1,2})\s*e(\d{1,3})/i;
const EPISODE_ONLY = /e(?:p)?\s*(\d{1,3})/i;
const EPISODE_CN = /第\s*(\d{1,3})\s*[话話集]/;
const STANDALONE_NUMBER = /(?:^|[\s._-])(\d{1,3})(?=[\s._-]|$)/g;
const BRACKETED = /\[[^\]]*\]/g;
const RELEASE_JUNK =
	/\b(?:1080p|720p|2160p|4k|hdr|web-?dl|bluray|bdrip|hevc|avc|x26[45]|aac|flac|dts)\b/gi;
const TRAILING_EPISODE_NUMBER = /[\s._-]*\d{1,3}\s*$/;
const TITLE_SEPARATORS = /[._]+/g;
const WHITESPACE = /\s+/g;

function loadBindings(): Record<string, DanmakuBinding> {
	try {
		const parsed: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}");
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
			return parsed as Record<string, DanmakuBinding>;
		}
	} catch {
		// Unreadable storage simply starts empty; the table rebuilds by matching.
	}
	return {};
}

/**
 * The binding table, reactive so the settings panel and the layer follow a rebind.
 */
const bindings = shallowRef<Record<string, DanmakuBinding>>(loadBindings());
export { bindings as bindingsState };

let apiBase = "";

/** Set by the player from the settings; every call below reads the current value. */
export function setDanmakuApiBase(value: string) {
	const next = value.trim().replace(TRAILING_SLASHES, "");
	if (next === apiBase) {
		return;
	}
	apiBase = next;
	// Match answers belong to one server: a base that changes (including the keystrokes
	// while it is being typed) must not leave earlier failures cached for the new one.
	autoMatches.clear();
}

export function getDanmakuApiBase(): string {
	return apiBase;
}

function persist() {
	try {
		localStorage.setItem(STORAGE_KEY, JSON.stringify(bindings.value));
	} catch {
		// Private browsing or storage limits: bindings still work for this session.
	}
}

export function getBinding(videoUrl: string): DanmakuBinding | null {
	return bindings.value[videoUrl] ?? null;
}

export function rememberBinding(videoUrl: string, binding: DanmakuBinding) {
	const current = bindings.value[videoUrl];
	if (current?.episodeId === binding.episodeId && current?.label === binding.label) {
		return;
	}
	bindings.value = { ...bindings.value, [videoUrl]: binding };
	persist();
}

export function forgetBinding(videoUrl: string) {
	if (!(videoUrl in bindings.value)) {
		return;
	}
	const next = { ...bindings.value };
	delete next[videoUrl];
	bindings.value = next;
	persist();
}

/** Drops every stored binding; the settings panel offers this as a clean-slate escape. */
export function clearBindings() {
	bindings.value = {};
	try {
		localStorage.removeItem(STORAGE_KEY);
	} catch {
		// Nothing to clean when storage is unavailable.
	}
}

/** The comment track URL for a binding, in the XML dialect parseDanmakuXml already reads. */
export function trackUrl(binding: DanmakuBinding): string | null {
	if (!apiBase) {
		return null;
	}
	return `${apiBase}/api/v2/comment/${encodeURIComponent(String(binding.episodeId))}?format=xml`;
}

/** Whether this URL is even a candidate for the aggregator (plain http(s) media links). */
export function looksLikeRemoteCandidate(videoUrl: string): boolean {
	try {
		const url = new URL(videoUrl);
		return (
			(url.protocol === "https:" || url.protocol === "http:") && url.pathname.includes(".")
		);
	} catch {
		return false;
	}
}

/**
 * Builds the query the aggregator's matcher understands from a media URL:
 * `.../SHIROBAKO/06.mp4` -> `SHIROBAKO S01E06`, `.../Show.S02E05.1080p.mkv` -> `Show S02E05`,
 * `.../PerfectBlue/playlist.m3u8` -> `PerfectBlue` (a movie has no episode).
 */
export function synthesizeMatchQuery(videoUrl: string): string | null {
	let url: URL;
	try {
		url = new URL(videoUrl);
	} catch {
		return null;
	}
	const segments = url.pathname
		.split("/")
		.filter(Boolean)
		.map(segment => {
			try {
				return decodeURIComponent(segment);
			} catch {
				return segment;
			}
		});
	if (segments.length === 0) {
		return null;
	}

	// A playlist URL names its own folder, and the real file name (if any) sits in front.
	let fileIndex = segments.length - 1;
	if (PLAYLIST_NAME.test(segments[fileIndex])) {
		fileIndex--;
	}
	if (fileIndex < 0) {
		return null;
	}
	const file = segments[fileIndex];

	let season: number | null = null;
	let episode: number | null = null;
	const seasonEpisode = file.match(SEASON_EPISODE);
	if (seasonEpisode) {
		season = Number.parseInt(seasonEpisode[1], 10);
		episode = Number.parseInt(seasonEpisode[2], 10);
	} else {
		const episodeOnly = file.match(EPISODE_ONLY) ?? file.match(EPISODE_CN);
		if (episodeOnly) {
			episode = Number.parseInt(episodeOnly[1], 10);
		} else {
			// A bare number names the episode: the file itself (`06.mp4`,
			// `[Group] SHIROBAKO 06 [1080p].mkv`) or the folder a playlist was unwrapped
			// from (`.../01/playlist.m3u8`). The last standalone number wins, so titles
			// that carry one themselves (`86 - 05.mkv`) still point at the episode.
			const numbers = [...file.matchAll(STANDALONE_NUMBER)];
			if (numbers.length > 0) {
				episode = Number.parseInt(numbers[numbers.length - 1][1], 10);
			}
		}
	}

	// The show's name is the first meaningful folder above the file, skipping years,
	// dates, season markers and generic media folders. Season markers are kept.
	let title: string | null = null;
	for (let index = fileIndex - 1; index >= 0; index--) {
		const segment = segments[index];
		const seasonMatch = segment.match(SEASON_FOLDER);
		if (seasonMatch) {
			if (season === null) {
				season = Number.parseInt(seasonMatch[1], 10);
			}
			continue;
		}
		if (
			DATE_SEGMENT.test(segment) ||
			YEAR_SEGMENT.test(segment) ||
			GENERIC_FOLDERS.has(segment.toLowerCase())
		) {
			continue;
		}
		title = segment;
		break;
	}
	if (!title) {
		title = file
			.replace(GENERIC_EXTENSIONS, "")
			.replace(BRACKETED, " ")
			.replace(SEASON_EPISODE, " ")
			.replace(RELEASE_JUNK, " ");
		if (episode !== null) {
			// The episode number is part of the query below, not of the title.
			title = title.replace(TRAILING_EPISODE_NUMBER, " ");
		}
	}
	title = title.replace(TITLE_SEPARATORS, " ").replace(WHITESPACE, " ").trim();
	if (!title) {
		return null;
	}

	if (episode === null) {
		return title;
	}
	return `${title} S${String(season ?? 1).padStart(2, "0")}E${String(episode).padStart(2, "0")}`;
}

/**
 * One match request per video per session; a miss is cached too, so a video the matcher
 * cannot place is not re-asked on every remount.
 */
const autoMatches = new Map<string, Promise<DanmakuBinding | null>>();

export function autoMatch(videoUrl: string): Promise<DanmakuBinding | null> {
	const cached = autoMatches.get(videoUrl);
	if (cached) {
		return cached;
	}
	const request = runAutoMatch(videoUrl);
	autoMatches.set(videoUrl, request);
	return request;
}

async function runAutoMatch(videoUrl: string): Promise<DanmakuBinding | null> {
	const query = synthesizeMatchQuery(videoUrl);
	if (!query || !apiBase) {
		return null;
	}
	try {
		const response = await fetch(`${apiBase}/api/v2/match`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ fileName: query }),
		});
		if (!response.ok) {
			return null;
		}
		const body = await response.json();
		if (!body?.isMatched || !Array.isArray(body.matches) || body.matches.length === 0) {
			return null;
		}
		const match = body.matches[0];
		if (match?.episodeId === undefined) {
			return null;
		}
		const label = [match.animeTitle, match.episodeTitle].filter(Boolean).join(" · ");
		return { episodeId: match.episodeId, label };
	} catch {
		// A matching service that is down must not surface as an error.
		return null;
	}
}

export async function searchAnime(keyword: string): Promise<DanmakuSearchResult[]> {
	const query = keyword.trim();
	if (!apiBase || !query) {
		return [];
	}
	try {
		const response = await fetch(
			`${apiBase}/api/v2/search/anime?keyword=${encodeURIComponent(query)}`,
		);
		if (!response.ok) {
			return [];
		}
		const body = await response.json();
		const list = Array.isArray(body?.animes) ? body.animes : [];
		return list
			.filter((item: { animeId?: unknown }) => item?.animeId !== undefined)
			.map((item: { animeId: number | string; animeTitle?: string; source?: string }) => ({
				animeId: item.animeId,
				title: item.animeTitle ?? "",
				source: item.source ?? "",
			}));
	} catch {
		return [];
	}
}

export async function fetchEpisodes(animeId: number | string): Promise<DanmakuEpisode[]> {
	if (!apiBase) {
		return [];
	}
	try {
		const response = await fetch(
			`${apiBase}/api/v2/bangumi/${encodeURIComponent(String(animeId))}`,
		);
		if (!response.ok) {
			return [];
		}
		const body = await response.json();
		const list = Array.isArray(body?.bangumi?.episodes) ? body.bangumi.episodes : [];
		return list
			.filter((item: { episodeId?: unknown }) => item?.episodeId !== undefined)
			.map((item: { episodeId: number | string; episodeTitle?: string }) => ({
				episodeId: item.episodeId,
				title: item.episodeTitle ?? "",
			}));
	} catch {
		return [];
	}
}

export const danmuApiProvider: DanmakuProvider = {
	id: "danmu-api",
	resolve(videoUrl) {
		const binding = getBinding(videoUrl);
		return binding ? trackUrl(binding) : null;
	},
	load(url) {
		return loadDanmaku(url);
	},
};
