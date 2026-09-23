import axios from "axios";
import type { MediaAccess } from "ott-common/models/video.js";
import { assertPublicMediaUrl } from "../ffprobe.js";
import { corsFromHeaders } from "./cors-probe.js";

const PROBE_TIMEOUT_MS = 5000;

/**
 * Content types that cannot be the media the playlist or the file extension promised. A
 * host that disguises video as an image still plays once the bytes reach hls.js or the
 * video element, so this only ever becomes a diagnostic.
 */
const NON_MEDIA_CONTENT_TYPE = /^(?:image|text)\/|^application\/(?:json|xml|javascript|pdf)\b/i;

export interface MediaAccessProbe {
	mediaAccess?: MediaAccess;
	cors?: boolean;
}

interface ProbeResponse {
	status: number;
	headers: Record<string, unknown>;
}

/** The origin a browser on a page of this app sends as Referer. */
export function appOriginFromHostname(hostname: string): string {
	return `https://${hostname}`;
}

function containerMismatch(headers: Record<string, unknown>): boolean {
	const value = headers["content-type"];
	return typeof value === "string" && NON_MEDIA_CONTENT_TYPE.test(value.trim());
}

/** Diagnostics never change playback, so they are reported only when actually observed. */
function diagnostics(headers: Record<string, unknown>): MediaAccess | null {
	return containerMismatch(headers) ? { containerMismatch: true } : null;
}

/**
 * Read the status line and headers only, never the body: a host may ignore Range and start
 * streaming a multi-megabyte segment. A network failure returns null, which callers read as
 * "no verdict" rather than "blocked".
 */
async function probeHeaders(link: string, referer?: string): Promise<ProbeResponse | null> {
	try {
		await assertPublicMediaUrl(link);
		const response = await axios.get(link, {
			timeout: PROBE_TIMEOUT_MS,
			responseType: "stream",
			headers: { Range: "bytes=0-0", ...(referer ? { Referer: referer } : {}) },
			validateStatus: () => true,
			// A redirect can turn a public URL into an intranet one; never follow it here.
			maxRedirects: 0,
		});
		response.data?.destroy();
		return { status: response.status, headers: response.headers as Record<string, unknown> };
	} catch {
		return null;
	}
}

/**
 * Ask the source what it requires of the player's requests, using the two Referer policies a
 * browser can choose between. The browser's own policy is tried first, so a source that
 * already works is never told to change. Only a host that refuses this app's origin and
 * accepts no Referer at all yields a policy; a host that refuses both yields a diagnostic,
 * because its own site's Referer, a cookie or a signature is beyond what a browser on
 * another origin can send.
 */
export async function probeMediaAccess(link: string, appOrigin: string): Promise<MediaAccessProbe> {
	const asBrowser = await probeHeaders(link, `${appOrigin}/`);
	if (asBrowser && asBrowser.status < 400) {
		const mediaAccess = diagnostics(asBrowser.headers);
		return {
			cors: corsFromHeaders(asBrowser.headers),
			...(mediaAccess ? { mediaAccess } : {}),
		};
	}
	const withoutReferer = await probeHeaders(link);
	if (withoutReferer && withoutReferer.status < 400) {
		return {
			cors: corsFromHeaders(withoutReferer.headers),
			mediaAccess: {
				referrerPolicy: "no-referrer",
				...diagnostics(withoutReferer.headers),
			},
		};
	}
	if (asBrowser || withoutReferer) {
		return { mediaAccess: { requiresOriginReferer: true } };
	}
	return {};
}
