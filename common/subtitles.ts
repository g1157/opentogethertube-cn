export type SubtitleFormat = "vtt" | "ass";

/** Maps subtitle MIME content types to the internal format used to pick a renderer. */
export const SUBTITLE_CONTENT_TYPES: Record<string, SubtitleFormat> = {
	"text/vtt": "vtt",
	"text/x-ssa": "ass",
};

const SUBTITLE_EXTENSIONS: Record<string, SubtitleFormat> = {
	vtt: "vtt",
	ass: "ass",
	ssa: "ass",
};

export const MAX_SUBTITLE_URL_LENGTH = 2048;

const HTTP_PROTOCOL = /^https?:$/;
const NUMERIC_HOST = /^[\d.]+$/;
const LOCAL_HOST = /(^|\.)(localhost|local|internal|test|invalid)$/;

/**
 * A subtitle URL that every viewer's browser may load: a public http(s) link. This mirrors
 * the ott-edge media guard — IP literals, localhost-style names and credentials are
 * rejected so a queue item cannot point viewers at their own network.
 */
export function isPublicSubtitleUrl(value: string): boolean {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		return false;
	}
	const host = url.hostname.toLowerCase();
	return (
		HTTP_PROTOCOL.test(url.protocol) &&
		!url.username &&
		!url.password &&
		value.length <= MAX_SUBTITLE_URL_LENGTH &&
		host.includes(".") &&
		!NUMERIC_HOST.test(host) &&
		!host.includes(":") &&
		!host.startsWith("[") &&
		!LOCAL_HOST.test(host)
	);
}

/** Determines the subtitle format from a URL's file extension, or null if unsupported/unparseable. */
export function getSubtitleFormatFromUrl(url: string): SubtitleFormat | null {
	let pathname: string;
	try {
		pathname = new URL(url).pathname;
	} catch {
		return null;
	}
	const ext = pathname.split(".").pop()?.toLowerCase();
	if (!ext) {
		return null;
	}
	return SUBTITLE_EXTENSIONS[ext] ?? null;
}
