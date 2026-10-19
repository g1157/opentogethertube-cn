import { timeoutSignal } from "@/util/timeout-signal";
import { parseDanmakuXml, type DanmakuItem } from "./parse";

/** A stuck upstream must not leave the layer waiting forever. */
const FETCH_TIMEOUT_MS = 10_000;
/** Tracks are arrays in memory; keep the session cache bounded. */
const TRACK_CACHE_MAX = 64;

// One request per track per session: a success is cached, a failure is dropped so the
// next load retries instead of leaving the video without comments until a page reload.
const tracks = new Map<string, Promise<DanmakuItem[] | null>>();

export function loadDanmaku(url: string): Promise<DanmakuItem[] | null> {
	const cached = tracks.get(url);
	if (cached) {
		return cached;
	}
	const request = fetchDanmaku(url).then(items => {
		if (items === null) {
			// A missing file or transient outage is worth retrying on the next load.
			tracks.delete(url);
		}
		return items;
	});
	tracks.set(url, request);
	while (tracks.size > TRACK_CACHE_MAX) {
		const oldest = tracks.keys().next().value;
		if (oldest === undefined) {
			break;
		}
		tracks.delete(oldest);
	}
	return request;
}

async function fetchDanmaku(url: string): Promise<DanmakuItem[] | null> {
	try {
		const response = await fetch(url, { signal: timeoutSignal(FETCH_TIMEOUT_MS) });
		if (!response.ok) {
			return null;
		}
		return parseDanmakuXml(await response.text());
	} catch {
		// A missing track must never surface as an error; the layer just stays empty.
		return null;
	}
}
