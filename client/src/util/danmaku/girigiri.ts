import { loadDanmaku } from "./fetch";
import type { DanmakuProvider } from "./provider";

/** Where girigiri mirrors comment tracks for direct files. */
const DANMAKU_HOST = "danmu.girigirilove.com";
const SOURCE_DOMAIN = "girigirilove.com";

const M3U8_SUFFIX = /\.m3u8$/i;
/** The playlist filename itself, e.g. `playlist.m3u8` under `…/01/`. */
const M3U8_FILENAME = /\/[^/]*\.m3u8$/i;
const FILE_EXTENSION = /\.[^/.]+$/;
const CHT_FOLDER = /CHT\//g;

/**
 * Girigiri keeps two layouts, both derived from the video URL alone (verified 2026-10-03):
 * - Direct files (`.../SHIROBAKO/01.mp4`): mirrored on the danmu host with an `.xml`
 *   extension. `CHT` resource folders are served from their `CHS` sibling, which is
 *   where the track library actually lives.
 * - HLS packs (`.../01/playlist.m3u8`): the track sits next to the episode folder on
 *   the same host (`.../01.xml`), with no language rewrite.
 */
export const girigiriProvider: DanmakuProvider = {
	id: "girigiri",
	resolve(videoUrl) {
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
		if (host !== SOURCE_DOMAIN && !host.endsWith(`.${SOURCE_DOMAIN}`)) {
			return null;
		}
		if (M3U8_SUFFIX.test(url.pathname)) {
			const path = url.pathname.replace(M3U8_FILENAME, ".xml");
			return `${url.protocol}//${url.host}${path}`;
		}
		if (!FILE_EXTENSION.test(url.pathname)) {
			return null;
		}
		const path = url.pathname.replace(FILE_EXTENSION, ".xml").replace(CHT_FOLDER, "CHS/");
		return `https://${DANMAKU_HOST}${path}`;
	},
	load(url) {
		return loadDanmaku(url);
	},
};
