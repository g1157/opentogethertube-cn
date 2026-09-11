import type { QueueItem } from "ott-common/models/video";

const QUERY_FRAGMENT_SEPARATOR = /[?#]/;
const HTTP_URL = /^https?:\/\//i;
const CHINESE_EPISODE = /第\s*([零〇一二两三四五六七八九十百\d]{1,6})\s*[集话期]/;
const SEASON_EPISODE = /(?:^|[^a-z\d])s(\d{1,2})[\s._-]*e(\d{1,4})(?!\d)/i;
const EPISODE = /(?:^|[^a-z\d])(?:ep(?:isode)?|e)[\s._-]*(\d{1,4})(?!\d)/i;
const NUMBERED_MEDIA_FILE = /^(\d{1,3})\.(?:mp4|m4v|mkv|webm|m3u8|mpd)$/i;

/** Use the filename, never query parameters or signed credentials, as a missing-title fallback. */
function filename(value: string): string {
	let path = value.split(QUERY_FRAGMENT_SEPARATOR, 1)[0];
	try {
		path = new URL(value).pathname;
	} catch {
		/* Provider IDs need not be URLs. */
	}
	const name = path.split("/").pop() ?? "";
	try {
		return decodeURIComponent(name);
	} catch {
		return name;
	}
}

export function nowPlayingDetails(video: QueueItem | null) {
	if (!video?.id) {
		return { title: "", episode: null, season: null };
	}
	const file = filename(video.id);
	const title = HTTP_URL.test(video.title?.trim() ?? "")
		? filename(video.title!.trim())
		: video.title?.trim() || file;
	const candidates = [title, file];
	for (const text of candidates) {
		const chinese = text.match(CHINESE_EPISODE);
		if (chinese) {
			return { title, episode: chinese[1], season: null };
		}
		const season = text.match(SEASON_EPISODE);
		if (season) {
			return { title, episode: String(Number(season[2])), season: String(Number(season[1])) };
		}
		const episode = text.match(EPISODE);
		if (episode) {
			return { title, episode: String(Number(episode[1])), season: null };
		}
	}
	// A bare numbered media filename is unambiguous; years, resolutions and arbitrary trailing IDs are not.
	const numbered = file.match(NUMBERED_MEDIA_FILE);
	return { title, episode: numbered ? String(Number(numbered[1])) : null, season: null };
}
