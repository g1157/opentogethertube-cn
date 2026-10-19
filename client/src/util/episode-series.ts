/**
 * Same-series probing: episode links usually differ only by one number in the path
 * (`…/ep01.mp4`, `…/1/playlist.m3u8`). The detection bumps the last episode-like
 * number, and falls back to the one before it when that number is part of the folder
 * layout instead (`…/2026/07/…/1/`). Numbers that look like a year or a video
 * resolution are never incremented.
 */

export interface NumberToken {
	value: number;
	/** Digits as written, so "01" increments to "02" instead of "2". */
	digits: string;
	start: number;
	end: number;
}

const QUERY_OR_FRAGMENT = /[?#]/;
const DIGITS = /(\d+)/g;

/**
 * Numbers in the path and file name, in order, with offsets into the original string.
 * The host (and its port) and any query string or fragment are ignored: an episode
 * number never lives there.
 */
export function findNumberTokens(url: string): NumberToken[] {
	// Start after the authority: "https://host:8443/a/1" probes only "/a/1".
	const authorityEnd = url.indexOf("://") >= 0 ? url.indexOf("://") + 3 : 0;
	const pathStart = url.indexOf("/", authorityEnd);
	const from = pathStart >= 0 ? pathStart : url.length;
	const stopAt = url.slice(from).search(QUERY_OR_FRAGMENT);
	let to = stopAt >= 0 ? from + stopAt : url.length;
	// The file extension is never an episode number ("playlist.m3u8", "ep01.mp4").
	const lastDot = url.lastIndexOf(".", to);
	const lastSlash = url.lastIndexOf("/", to);
	if (lastDot > lastSlash && lastDot >= from) {
		to = lastDot;
	}

	const tokens: NumberToken[] = [];
	for (const match of url.slice(from, to).matchAll(DIGITS)) {
		const digits = match[1];
		const start = from + (match.index ?? 0);
		tokens.push({
			value: Number.parseInt(digits, 10),
			digits,
			start,
			end: start + digits.length,
		});
	}
	return tokens;
}

const RESOLUTION_LIKE = new Set([360, 480, 540, 576, 720, 1080, 1440, 2160, 4320]);

/** A year, a resolution, or the leading part of a long id is not an episode number. */
export function isEpisodeLike(token: NumberToken): boolean {
	if (token.digits.length >= 4 && token.value >= 1900 && token.value <= 2099) {
		return false;
	}
	if (RESOLUTION_LIKE.has(token.value)) {
		return false;
	}
	return token.value > 0;
}

/**
 * A stable key for "the same series": the URL with every number replaced by a
 * placeholder, so results can be cached and two links can be compared.
 */
export function seriesKey(url: string): string {
	const tokens = findNumberTokens(url);
	if (tokens.length === 0) {
		return url;
	}
	let key = "";
	let cursor = 0;
	for (const token of tokens) {
		key += url.slice(cursor, token.start) + "#";
		cursor = token.end;
	}
	return key + url.slice(cursor);
}

function replaceToken(url: string, token: NumberToken, value: number): string {
	const digits = String(value).padStart(token.digits.length, "0");
	return url.slice(0, token.start) + digits + url.slice(token.end);
}

/**
 * The episode numbers worth probing, best guess first: the last episode-like number,
 * then the one before it.
 */
export function episodeTokenChoices(url: string): NumberToken[] {
	const tokens = findNumberTokens(url).filter(isEpisodeLike);
	if (tokens.length === 0) {
		return [];
	}
	const last = tokens[tokens.length - 1];
	const previous = tokens.length > 1 ? tokens[tokens.length - 2] : undefined;
	return previous ? [last, previous] : [last];
}

/** The URL with the given token's number moved by `offset`. */
export function shiftToken(url: string, token: NumberToken, offset: number): string {
	return replaceToken(url, token, Math.max(0, token.value + offset));
}

export interface SeriesProbeOptions {
	/** How many steps to try in each direction. */
	steps?: number;
	/** Hard cap on lookup requests, whichever direction they come from. */
	budget?: number;
	/** Consecutive misses that end a direction. */
	misses?: number;
	/** Stop early, for example when the input has changed since the probe started. */
	isAborted?: () => boolean;
	/** Called after every hit, so the UI can show progress while probing. */
	onProgress?: (found: number) => void;
}

const SERIES_PROBE_STEPS = 50;
const SERIES_PROBE_BUDGET = 80;
const SERIES_PROBE_MISSES = 2;

/**
 * Episodes of the same series around `url`, both before and after it. A folder keeps its
 * whole season under one path, so looking only forward loses everything already aired;
 * the first token choice that yields anything wins, and two consecutive misses in a
 * direction mean that direction has ended. Listings are capped by `budget` so a long
 * series cannot turn one click into unbounded requests.
 */
export async function probeSameSeries<T>(
	url: string,
	lookup: (candidate: string) => Promise<T[] | null>,
	options: SeriesProbeOptions = {},
): Promise<T[]> {
	const steps = options.steps ?? SERIES_PROBE_STEPS;
	const budget = options.budget ?? SERIES_PROBE_BUDGET;
	const maxMisses = options.misses ?? SERIES_PROBE_MISSES;
	let remaining = budget;
	const seen = new Set<string>([url]);
	for (const token of episodeTokenChoices(url)) {
		if (options.isAborted?.()) {
			return [];
		}
		const found: { number: number; item: T }[] = [];
		const walk = async (direction: 1 | -1) => {
			let misses = 0;
			for (let step = 1; step <= steps && misses < maxMisses && remaining > 0; step++) {
				if (options.isAborted?.()) {
					return;
				}
				const number = token.value + direction * step;
				if (number <= 0) {
					break;
				}
				const candidate = shiftToken(url, token, direction * step);
				if (candidate === url || seen.has(candidate)) {
					continue;
				}
				remaining--;
				const preview = await lookup(candidate);
				if (preview && preview.length > 0) {
					seen.add(candidate);
					found.push({ number, item: preview[0] });
					misses = 0;
					options.onProgress?.(found.length);
				} else {
					misses++;
				}
			}
		};
		// Forward first: the next episode is the likelier thing to watch.
		await walk(1);
		await walk(-1);
		if (options.isAborted?.()) {
			return [];
		}
		if (found.length > 0) {
			found.sort((a, b) => a.number - b.number);
			return found.map(entry => entry.item);
		}
	}
	return [];
}
