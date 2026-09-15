import type { QueueItem } from "ott-common/models/video";

/** How close to the end of the current item the next one starts warming. */
export const PREFETCH_LEAD_SECONDS = 30;
/** Enough of a progressive file to cover DNS, TLS and the first range request. */
export const PREFETCH_BYTES = 262_144;

export interface MediaCandidate {
	key: string;
	service: string;
	/** Playable URL, or null when the item plays through an embedded player. */
	url: string | null;
}

/** Resolve the next queue item the way the player would, without starting it. */
export function resolveMediaCandidate(item: QueueItem | null | undefined): MediaCandidate | null {
	if (!item?.id || !item.service) {
		return null;
	}
	const key = `${item.service}:${item.id}`;
	switch (item.service) {
		case "hls":
		case "reddit":
		case "tubi":
		case "pluto":
			return { key, service: item.service, url: item.hls_url ?? item.id };
		case "dash":
			return { key, service: item.service, url: item.dash_url ?? item.id };
		case "direct":
		case "googledrive":
			return { key, service: item.service, url: item.src_url ?? item.id };
		case "odysee":
			if (item.mime?.includes("mpegurl")) {
				return { key, service: item.service, url: item.hls_url ?? item.id };
			}
			if (item.mime?.includes("mp4")) {
				return { key, service: item.service, url: item.src_url ?? item.id };
			}
			return null;
		default:
			// YouTube, Vimeo and PeerTube play inside an iframe; there is nothing to warm.
			return null;
	}
}

interface NextMediaPrefetchOptions {
	/** Seconds left on the current item, or null when the length is unknown. */
	getRemainingSeconds: () => number | null;
	getNext: () => QueueItem | null | undefined;
	fetchImpl?: typeof fetch;
}

/**
 * Warms the connection and the OS/browser cache for whatever plays next, so the room's
 * switch does not pay for DNS, TLS and the first range request in front of everyone.
 * Nothing here starts playback or loads a whole file.
 */
export function createNextMediaPrefetch(options: NextMediaPrefetchOptions) {
	const fetchImpl: typeof fetch = options.fetchImpl ?? fetch;
	let attemptedKey: string | null = null;

	async function warm(candidate: MediaCandidate) {
		if (!candidate.url) {
			return;
		}
		try {
			if (candidate.service === "direct" || candidate.service === "googledrive") {
				await fetchImpl(candidate.url, {
					headers: { Range: `bytes=0-${PREFETCH_BYTES - 1}` },
				});
				return;
			}
			await fetchImpl(candidate.url);
		} catch {
			// A prefetch that fails is simply a prefetch that did not help.
		}
	}

	return {
		tick() {
			const remaining = options.getRemainingSeconds();
			if (remaining === null || remaining < 0 || remaining > PREFETCH_LEAD_SECONDS) {
				return;
			}
			const candidate = resolveMediaCandidate(options.getNext());
			if (!candidate || candidate.key === attemptedKey) {
				return;
			}
			attemptedKey = candidate.key;
			void warm(candidate);
		},
		/** The room moved on; a later queue entry may warm again. */
		reset() {
			attemptedKey = null;
		},
	};
}
