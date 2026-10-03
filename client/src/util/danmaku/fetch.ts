import { parseDanmakuXml, type DanmakuItem } from "./parse";

// One request per track per session: a failure is cached too, so a missing file is not
// hammered again on every remount. The girigiri host adds its own day-long HTTP cache.
const tracks = new Map<string, Promise<DanmakuItem[] | null>>();

export function loadDanmaku(url: string): Promise<DanmakuItem[] | null> {
	const cached = tracks.get(url);
	if (cached) {
		return cached;
	}
	const request = fetchDanmaku(url);
	tracks.set(url, request);
	return request;
}

async function fetchDanmaku(url: string): Promise<DanmakuItem[] | null> {
	try {
		const response = await fetch(url);
		if (!response.ok) {
			return null;
		}
		return parseDanmakuXml(await response.text());
	} catch {
		// A missing track must never surface as an error; the layer just stays empty.
		return null;
	}
}
