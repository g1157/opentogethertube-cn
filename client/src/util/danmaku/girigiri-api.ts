import { API, API_BASE_URL } from "@/common-http";
import { loadDanmaku } from "./fetch";
import type { DanmakuItem } from "./parse";

/**
 * The client half of the server-side girigiri bridge (`server/api/danmaku.ts`). girigiri
 * has no public API: the server runs the site's suggest search, turns a play page into a
 * danmaku file, and serves that file through this origin. Viewers whose network cannot
 * reach girigiri therefore still get its comments, and each track is fetched upstream at
 * most once per day per server.
 */

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

/**
 * A search either produced a list or the upstream could not be reached — the two are not
 * the same thing to a viewer. The server answers 502 for an unreachable or malformed
 * upstream and 200 with an empty list for a real miss, so `status` carries that through
 * instead of collapsing both into "no results".
 */
export interface GirigiriSearchOutcome {
	results: GirigiriSearchResult[];
	status: "ok" | "unavailable";
}

export async function searchGirigiri(keyword: string): Promise<GirigiriSearchOutcome> {
	const query = keyword.trim();
	if (!query) {
		return { results: [], status: "ok" };
	}
	try {
		const response = await API.get<{ results?: GirigiriSearchResult[] }>(
			"/danmaku/girigiri/search",
			{ params: { wd: query } },
		);
		const results = response.data?.results;
		return { results: Array.isArray(results) ? results : [], status: "ok" };
	} catch {
		// A request that cannot complete is reported as such; the panel says the source is
		// unavailable rather than implying the show does not exist.
		return { results: [], status: "unavailable" };
	}
}

export interface GirigiriLinesOutcome {
	lines: GirigiriLine[];
	status: "ok" | "unavailable";
}

export async function fetchGirigiriEpisodes(id: number): Promise<GirigiriLinesOutcome> {
	try {
		const response = await API.get<{ lines?: GirigiriLine[] }>("/danmaku/girigiri/episodes", {
			params: { id: String(id) },
		});
		const lines = response.data?.lines;
		return { lines: Array.isArray(lines) ? lines : [], status: "ok" };
	} catch {
		return { lines: [], status: "unavailable" };
	}
}

/** The same-origin track URL for a girigiri play page; the server resolves and proxies it. */
export function girigiriTrackUrl(page: string): string {
	return `${API_BASE_URL}/danmaku/girigiri/track?page=${encodeURIComponent(page)}`;
}

export function loadGirigiriTrack(page: string): Promise<DanmakuItem[] | null> {
	return loadDanmaku(girigiriTrackUrl(page));
}
