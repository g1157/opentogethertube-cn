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

export async function searchGirigiri(keyword: string): Promise<GirigiriSearchResult[]> {
	const query = keyword.trim();
	if (!query) {
		return [];
	}
	try {
		const response = await API.get<{ results?: GirigiriSearchResult[] }>(
			"/danmaku/girigiri/search",
			{ params: { wd: query } },
		);
		const results = response.data?.results;
		return Array.isArray(results) ? results : [];
	} catch {
		// A search that cannot complete reads as "no results"; the panel says so.
		return [];
	}
}

export async function fetchGirigiriEpisodes(id: number): Promise<GirigiriLine[]> {
	try {
		const response = await API.get<{ lines?: GirigiriLine[] }>("/danmaku/girigiri/episodes", {
			params: { id: String(id) },
		});
		const lines = response.data?.lines;
		return Array.isArray(lines) ? lines : [];
	} catch {
		return [];
	}
}

/** The same-origin track URL for a girigiri play page; the server resolves and proxies it. */
export function girigiriTrackUrl(page: string): string {
	return `${API_BASE_URL}/danmaku/girigiri/track?page=${encodeURIComponent(page)}`;
}

export function loadGirigiriTrack(page: string): Promise<DanmakuItem[] | null> {
	return loadDanmaku(girigiriTrackUrl(page));
}
