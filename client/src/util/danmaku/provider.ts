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
 *
 * **Two kinds of source, with different contracts — do not treat them alike:**
 *
 * - `danmuApiProvider` is the supported path. It speaks the dandanplay-compatible
 *   aggregator API (`/api/v2/search/anime`, `/api/v2/match`, `/api/v2/comment`), which is
 *   a documented, stable contract, and the upstream is chosen by the visitor
 *   (`settings.danmakuApiBase`, typically a danmu_api instance they run themselves). The
 *   request goes straight from the browser to that address: this server is not involved,
 *   holds no credentials and carries no upstream risk.
 *
 * - `girigiriProvider` is **best effort, with no contract at all**. girigiri publishes no
 *   API; the track URL is derived from the video URL by a path rule observed on the live
 *   site, and search/episode lookups go through `server/api/danmaku.ts`, which parses a
 *   private endpoint read out of the site's own JavaScript bundle. That endpoint has
 *   already changed once (the maccms `suggest` route and the `/playGV…/` pages were
 *   replaced by a PHP JSON API), and can change again without notice. Consequence: treat
 *   girigiri as a convenience that stops working when the site changes, never as a
 *   dependency to build features on, and never assume its shape is stable. When it does
 *   break, the fix is another reverse-engineering pass — prefer investing in the
 *   aggregator path instead, and keep the "unreachable" and "not found" outcomes
 *   distinguishable in the UI (`GirigiriSearchOutcome`) so a dead source never looks
 *   like a wrong search term.
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
