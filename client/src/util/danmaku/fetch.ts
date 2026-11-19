import { readBoundedText } from "ott-common/response-body";
import {
	DANMAKU_CACHE_MAX_BYTES,
	DANMAKU_MAX_CONCURRENT_DOWNLOADS,
	DANMAKU_MAX_XML_BYTES,
} from "ott-common/danmaku";
import { parseDanmakuXml, type DanmakuItem } from "./parse";

const FETCH_TIMEOUT_MS = 10_000;
const TRACK_CACHE_MAX = 64;

interface TrackEntry {
	request: Promise<DanmakuItem[] | null>;
	controller: AbortController;
	pending: boolean;
	bytes: number;
}

const tracks = new Map<string, TrackEntry>();
let cacheBytes = 0;
let activeDownloads = 0;

function evictTrack(url: string): void {
	const entry = tracks.get(url);
	if (!entry) {
		return;
	}
	tracks.delete(url);
	cacheBytes -= entry.bytes;
	if (entry.pending) {
		entry.controller.abort();
	}
}

function trimCache(): void {
	while (tracks.size > TRACK_CACHE_MAX || cacheBytes > DANMAKU_CACHE_MAX_BYTES) {
		const oldest = tracks.keys().next().value;
		if (oldest === undefined) {
			break;
		}
		evictTrack(oldest);
	}
}

export function loadDanmaku(url: string): Promise<DanmakuItem[] | null> {
	const cached = tracks.get(url);
	if (cached) {
		tracks.delete(url);
		tracks.set(url, cached);
		return cached.request;
	}
	const entry: TrackEntry = {
		request: Promise.resolve(null),
		controller: new AbortController(),
		pending: true,
		bytes: 0,
	};
	entry.request = fetchDanmaku(url, entry.controller).then(items => {
		entry.pending = false;
		if (tracks.get(url) !== entry) {
			return items;
		}
		if (items === null) {
			evictTrack(url);
			return null;
		}
		// UTF-16 text plus a fixed per-item allowance: accounting, not measured JS heap.
		entry.bytes = items.reduce(
			(bytes, item) => bytes + 96 + 2 * (item.text.length + item.color.length),
			0,
		);
		cacheBytes += entry.bytes;
		trimCache();
		return items;
	});
	tracks.set(url, entry);
	trimCache();
	return entry.request;
}

async function fetchDanmaku(
	url: string,
	controller: AbortController,
): Promise<DanmakuItem[] | null> {
	if (activeDownloads >= DANMAKU_MAX_CONCURRENT_DOWNLOADS) {
		return null;
	}
	activeDownloads++;
	const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
	try {
		const response = await fetch(url, { signal: controller.signal });
		if (!response.ok) {
			void response.body?.cancel().catch(() => {
				// Cancellation is best effort and must not mask the response failure.
			});
			return null;
		}
		return parseDanmakuXml(
			await readBoundedText(response, DANMAKU_MAX_XML_BYTES, controller.signal),
		);
	} catch {
		// Failure or admission pressure leaves the layer empty and may be retried later.
		return null;
	} finally {
		clearTimeout(timer);
		activeDownloads--;
	}
}
