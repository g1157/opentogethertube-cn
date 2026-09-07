import { URL } from "node:url";
import axios from "axios";
import { ServiceAdapter } from "../serviceadapter.js";
import { getLogger } from "../logger.js";
import type { Video } from "ott-common/models/video.js";

const log = getLogger("girigirilove");

const UA =
	"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

// Matches girigirilove *play pages* (NOT resolved .m3u8 stream urls — those are
// handled by the built-in hls adapter). e.g. https://ani.girigirilove.com/playGV27065-2-1/
const GIRIGIRILOVE_PAGE_REGEX = /^https?:\/\/[^/]*girigirilove\.[a-z]+\/play/i;
const DIRECT_MEDIA_REGEX = /\.(m3u8?|mp4|mkv|flv|m4s|mov|avi|wmv|webm)(\?|$)/i;

// Generic direct-video url regex, ported from LuckyPuppy514/external-player.
const VIDEO_URL_REGEX_SOURCE =
	"https?://((?![^\"'\\s]*http)[^\"'\\s]+(\\.|%2e)(mp4|mkv|flv|m3u8|m4s|m3u|mov|avi|wmv|webm)(\\?[^\"'\\s]+|))" +
	"|((?![^\"'\\s]*http)[^\"'\\s]+\\?[^\"'\\s]+(\\.|%2e|video_)(mp4|mkv|flv|mov|avi|wmv|webm|m3u8|m3u)[^\"'\\s]*)";

/**
 * Resolves a girigirilove (MacCMS) *page* URL to a direct stream URL, then hands
 * it off to the built-in hls/direct adapters via the nested-url pattern (same as
 * how reddit.ts returns `{ url }` for external links).
 *
 * Extraction strategy ported from getlink.py / LuckyPuppy514/external-player:
 *   1. decode the embedded `player_aaaa` config (encrypt 0 / 1 / 2)
 *   2. fall back to scanning the page (HTML, inline scripts, iframe src, `?url=`
 *      query params) with the generic video-url regex, trying base64 + urldecode.
 */
export default class GirigiriloveAdapter extends ServiceAdapter {
	api = axios.create({ headers: { "User-Agent": UA }, timeout: 20000 });

	get serviceId(): "girigirilove" {
		return "girigirilove";
	}

	get isCacheSafe(): boolean {
		return false;
	}

	canHandleURL(link: string): boolean {
		// Never claim a direct media url — let the hls/direct adapters handle the
		// stream we resolve to (prevents an infinite resolve loop).
		if (DIRECT_MEDIA_REGEX.test(link)) {
			return false;
		}
		return GIRIGIRILOVE_PAGE_REGEX.test(link);
	}

	isCollectionURL(_link: string): boolean {
		// Route through resolveURL so we can resolve page -> stream and defer.
		return true;
	}

	getVideoId(url: string): string {
		const m = url.match(/play([A-Za-z0-9_-]+)/);
		return m ? m[1] : url;
	}

	async resolveURL(link: string): Promise<{ url: string }[]> {
		const origin = new URL(link).origin;
		const resp = await this.api.get<string>(link, {
			headers: { Referer: `${origin}/` },
			responseType: "text",
			transformResponse: x => x,
		});
		const stream = this.extractStreamUrl(resp.data, link);
		if (!stream) {
			throw new Error(`girigirilove: could not extract a video stream from ${link}`);
		}
		log.info(`girigirilove resolved ${link} -> ${stream}`);
		return [{ url: stream }];
	}

	private extractStreamUrl(html: string, pageUrl: string): string | null {
		// 1. player_aaaa = {...} (anchored on the closing `}<` so nested objects
		//    like vod_data don't terminate the match early)
		const pa = html.match(/player_aaaa\s*=\s*(\{[\s\S]*?\})\s*<\//);
		if (pa) {
			try {
				const data = JSON.parse(pa[1]);
				if (typeof data.url === "string") {
					for (const cand of this.decodeVariants(data.url)) {
						const hit = this.firstVideoHit(cand);
						if (hit) {
							return hit;
						}
					}
				}
			} catch (e) {
				log.warn(`girigirilove: failed to parse player_aaaa: ${e}`);
			}
		}

		// 2. generic scan of the whole page (HTML + inline scripts)
		const htmlHit = this.firstVideoHit(html);
		if (htmlHit) {
			return htmlHit;
		}

		// 3. iframe srcs + `?url=`-style query params (incl. base64 / urlencoded)
		const candidates: string[] = [...this.queryParamCandidates(pageUrl)];
		const iframeRe = /<iframe[^>]+src=["']([^"']+)["']/gi;
		let im: RegExpExecArray | null;
		while ((im = iframeRe.exec(html)) !== null) {
			const src = new URL(im[1], pageUrl).href;
			const ih = this.firstVideoHit(src);
			if (ih) {
				return ih;
			}
			candidates.push(...this.queryParamCandidates(src));
		}
		for (const c of candidates) {
			const h = this.firstVideoHit(c);
			if (h) {
				return h;
			}
		}
		return null;
	}

	private firstVideoHit(text: string): string | null {
		const m = text.match(new RegExp(VIDEO_URL_REGEX_SOURCE, "i"));
		return m ? m[0] : null;
	}

	private queryParamCandidates(url: string): string[] {
		const out: string[] = [];
		try {
			for (const [, v] of new URL(url).searchParams) {
				out.push(...this.decodeVariants(v));
			}
		} catch {
			// not a url
		}
		return out;
	}

	/** url-decode / base64 / base64-then-url-decode variants (encrypt 0/1/2) */
	private decodeVariants(s: string): string[] {
		const out = new Set<string>([s]);
		try {
			const d = decodeURIComponent(s);
			out.add(d);
			out.add(decodeURIComponent(d));
		} catch {
			// ignore bad escapes
		}
		for (const v of [s, s.replace(/-/g, "+").replace(/_/g, "/")]) {
			try {
				const dec = Buffer.from(v, "base64").toString("utf-8");
				if (/^[\x09\x0a\x0d\x20-\x7e]+$/.test(dec)) {
					out.add(dec);
					try {
						out.add(decodeURIComponent(dec));
					} catch {
						// ignore
					}
				}
			} catch {
				// ignore
			}
		}
		return [...out];
	}
}
