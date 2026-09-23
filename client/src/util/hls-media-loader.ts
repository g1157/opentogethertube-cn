import { FetchLoader, type HlsConfig } from "hls.js";
import { referrerPolicyValue } from "./media-access";

/**
 * hls.js configuration for a source whose probe said the player must not send a Referer.
 * Everything else keeps hls.js's default loader: the XHR path stays exactly as it was, and
 * only sources that actually need a different request gain the fetch-based one. Function
 * config values never reach the transmuxer worker, so this is safe with enableWorker.
 */
export function hlsLoaderOptions(policy: string | undefined): Partial<HlsConfig> {
	const referrerPolicy = referrerPolicyValue(policy);
	if (!referrerPolicy) {
		return {};
	}
	return {
		loader: FetchLoader,
		fetchSetup: (context, initParams) =>
			new Request(context.url, { ...initParams, referrerPolicy }),
	};
}
