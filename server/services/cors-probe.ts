import axios from "axios";

/** Whether a response we actually received allows cross-origin use of the media. */
export function corsFromHeaders(headers: Record<string, unknown> | undefined): boolean | undefined {
	if (!headers) {
		return undefined;
	}
	const value = headers["access-control-allow-origin"];
	return typeof value === "string" ? value.length > 0 : false;
}

const PROBE_TIMEOUT_MS = 5000;
const PROBE_MAX_BYTES = 64 * 1024;

/**
 * Ask the source itself whether a browser may read it cross-origin. A ranged GET mirrors
 * what the video element does (some hosts answer HEAD without the CORS header), and the
 * answer is only ever used to skip a doomed attempt, never to enable one.
 */
export async function probeCors(link: string): Promise<boolean | undefined> {
	try {
		const response = await axios.get(link, {
			timeout: PROBE_TIMEOUT_MS,
			responseType: "arraybuffer",
			maxContentLength: PROBE_MAX_BYTES,
			headers: { Range: "bytes=0-0" },
			validateStatus: status => status >= 200 && status < 400,
		});
		return corsFromHeaders(response.headers as Record<string, unknown>);
	} catch {
		return undefined;
	}
}
