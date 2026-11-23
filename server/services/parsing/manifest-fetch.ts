import axios, { type AxiosInstance } from "axios";
import { BadApiArgumentException } from "../../exceptions.js";

export const MAX_MANIFEST_BYTES = 2 * 1024 * 1024;
export const MANIFEST_REQUEST_TIMEOUT_MS = 5000;

export interface ManifestFetchOptions {
	http?: AxiosInstance;
	accept?: string;
	/**
	 * The page origin a browser would send. CDNs commonly answer `*`, but one that
	 * allowlists a single site answers with that site's origin; the caller can then use
	 * `corsFromHeaders(headers, origin)` instead of assuming any non-empty grant works.
	 */
	origin?: string;
}

/** A total deadline complements Axios' socket inactivity timeout. */
export async function fetchManifestText(url: string, options: ManifestFetchOptions = {}) {
	const http = options.http ?? axios;
	const accept = options.accept ?? "application/dash+xml,text/plain;q=0.9,*/*;q=0.8";
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), MANIFEST_REQUEST_TIMEOUT_MS);
	try {
		const response = await http.get<string>(url, {
			headers: {
				Accept: accept,
				...(options.origin ? { Origin: options.origin } : {}),
			},
			responseType: "text",
			transformResponse: [(data: unknown) => data],
			maxRedirects: 0,
			maxContentLength: MAX_MANIFEST_BYTES,
			timeout: MANIFEST_REQUEST_TIMEOUT_MS,
			signal: controller.signal,
		});
		if (
			typeof response.data !== "string" ||
			Buffer.byteLength(response.data, "utf8") > MAX_MANIFEST_BYTES
		) {
			throw new BadApiArgumentException("manifest", "Manifest exceeds the text size limit");
		}
		return response;
	} finally {
		clearTimeout(timer);
	}
}
