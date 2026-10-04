import { danmuApiProvider } from "./danmu-api";
import { girigiriProvider } from "./girigiri";
import type { DanmakuItem } from "./parse";

/**
 * A source of external comment tracks. Providers are deliberately small and in-repo:
 * each one knows how to recognise its own video URLs and how to load a track for them.
 * A broken provider must resolve to null (or fail its load) rather than throw — the
 * danmaku layer simply stays empty when its source is missing.
 */
export interface DanmakuProvider {
	/** Stable id for logs and future per-provider configuration. */
	id: string;
	/** Returns the track URL for this video, or null when it does not recognise it. */
	resolve(videoUrl: string): string | null;
	/** Loads and parses a track URL; resolves to null on any failure, never throws. */
	load(url: string): Promise<DanmakuItem[] | null>;
}

/**
 * Registered providers, tried in order. Adding a source is one module plus one entry
 * here; a dead source is removed by deleting its entry, with nothing else in the
 * feature needing to know which sources exist.
 */
const providers: DanmakuProvider[] = [girigiriProvider, danmuApiProvider];

export interface DanmakuSource {
	provider: DanmakuProvider;
	url: string;
}

export function findDanmakuProvider(videoUrl: string): DanmakuSource | null {
	for (const provider of providers) {
		let url: string | null = null;
		try {
			url = provider.resolve(videoUrl);
		} catch {
			// One misbehaving provider must not take the whole feature down.
			continue;
		}
		if (url) {
			return { provider, url };
		}
	}
	return null;
}
