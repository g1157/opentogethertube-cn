import axios from "axios";
import { assertPublicMediaUrl } from "../ffprobe.js";

function normalizeOrigin(value: string): string | null {
	try {
		const url = new URL(value.trim());
		// Origins are scheme://host[:port]; a path or a trailing slash in a badly written
		// header must not make an otherwise valid allowlist entry look usable.
		return url.origin === "null" ? null : url.origin;
	} catch {
		return null;
	}
}

/**
 * Whether a response we actually received allows the requesting page to read the media.
 *
 * A browser only receives an `Access-Control-Allow-Origin` value of `*` or the exact
 * `Origin` it sent (including the scheme and port). A host that allowlists a different
 * site therefore answers with a non-empty header that says nothing about this app, and a
 * verdict based only on "the header exists" would turn enhancement on for a picture the
 * browser cannot read. When the requesting origin is known, compare against it; the
 * no-origin form remains for callers that only need "is any CORS policy present".
 */
export function corsFromHeaders(
	headers: Record<string, unknown> | undefined,
	requestOrigin?: string,
): boolean | undefined {
	if (!headers) {
		return undefined;
	}
	const value = headers["access-control-allow-origin"];
	if (typeof value !== "string" || value.trim().length === 0) {
		return false;
	}
	const allowOrigin = value.trim();
	if (allowOrigin === "*") {
		return true;
	}
	if (!requestOrigin) {
		return true;
	}
	const allowed = normalizeOrigin(allowOrigin);
	const expected = normalizeOrigin(requestOrigin);
	return allowed !== null && expected !== null && allowed === expected;
}

const PROBE_TIMEOUT_MS = 5000;
const PROBE_MAX_BYTES = 64 * 1024;

/**
 * Ask the source itself whether a browser may read it cross-origin. A ranged GET mirrors
 * what the video element does (some hosts answer HEAD without the CORS header), and the
 * answer is only ever used to skip a doomed attempt, never to enable one.
 */
export async function probeCors(
	link: string,
	requestOrigin?: string,
): Promise<boolean | undefined> {
	try {
		await assertPublicMediaUrl(link);
		const response = await axios.get(link, {
			timeout: PROBE_TIMEOUT_MS,
			responseType: "arraybuffer",
			maxContentLength: PROBE_MAX_BYTES,
			headers: {
				Range: "bytes=0-0",
				...(requestOrigin ? { Origin: requestOrigin } : {}),
			},
			validateStatus: status => status >= 200 && status < 400,
			// A redirect can turn a public URL into an intranet one; never follow it here.
			maxRedirects: 0,
		});
		return corsFromHeaders(response.headers as Record<string, unknown>, requestOrigin);
	} catch {
		return undefined;
	}
}
