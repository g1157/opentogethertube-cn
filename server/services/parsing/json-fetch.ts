import axios, { type AxiosInstance, type AxiosResponse } from "axios";
import { assertPublicMediaUrl } from "../../ffprobe.js";

export const MAX_METADATA_BYTES = 2 * 1024 * 1024;
export const METADATA_REQUEST_TIMEOUT_MS = 5000;

/** Bound each metadata request and refuse implicit redirect hops to unvalidated hosts. */
export async function fetchPublicJson<T>(
	url: string,
	http: AxiosInstance = axios,
): Promise<AxiosResponse<T>> {
	await assertPublicMediaUrl(url);
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), METADATA_REQUEST_TIMEOUT_MS);
	try {
		return await http.get<T>(url, {
			headers: { Accept: "application/json" },
			responseType: "json",
			maxRedirects: 0,
			maxContentLength: MAX_METADATA_BYTES,
			timeout: METADATA_REQUEST_TIMEOUT_MS,
			signal: controller.signal,
		});
	} finally {
		clearTimeout(timer);
	}
}
