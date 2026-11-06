import type { QueueItem } from "ott-common/models/video";
import { referrerPolicyValue } from "./media-access";

/** How close to the end of the current item the next one starts warming. */
export const PREFETCH_LEAD_SECONDS = 30;
/** Enough of a progressive file to cover DNS, TLS and the first range request. */
export const PREFETCH_BYTES = 262_144;

export interface MediaCandidate {
	key: string;
	service: string;
	/** Playable URL, or null when the item plays through an embedded player. */
	url: string | null;
	/** Probed requirement of the source's host, so the warm-up request matches playback. */
	referrerPolicy?: string;
}

/** Resolve the next queue item the way the player would, without starting it. */
export function resolveMediaCandidate(item: QueueItem | null | undefined): MediaCandidate | null {
	if (!item?.id || !item.service) {
		return null;
	}
	const key = `${item.service}:${item.id}`;
	const referrerPolicy = item.mediaAccess?.referrerPolicy;
	switch (item.service) {
		case "hls":
		case "reddit":
		case "tubi":
		case "pluto":
			return { key, service: item.service, url: item.hls_url ?? item.id, referrerPolicy };
		case "dash":
			return { key, service: item.service, url: item.dash_url ?? item.id, referrerPolicy };
		case "direct":
		case "googledrive":
			return { key, service: item.service, url: item.src_url ?? item.id, referrerPolicy };
		case "odysee":
			if (item.mime?.includes("mpegurl")) {
				return { key, service: item.service, url: item.hls_url ?? item.id, referrerPolicy };
			}
			if (item.mime?.includes("mp4")) {
				return { key, service: item.service, url: item.src_url ?? item.id, referrerPolicy };
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
	/** Skip the warm-up while the current player is already short on buffer. */
	canWarm?: () => boolean;
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
	let inFlight: AbortController | null = null;

	async function warm(candidate: MediaCandidate) {
		if (!candidate.url) {
			return;
		}
		const controller = new AbortController();
		inFlight = controller;
		const signal = controller.signal;
		const policy = referrerPolicyValue(candidate.referrerPolicy);
		try {
			if (candidate.service === "direct" || candidate.service === "googledrive") {
				const headers = { Range: `bytes=0-${PREFETCH_BYTES - 1}` };
				// An ordinary source keeps exactly the request it made before the probe existed.
				await fetchImpl(
					candidate.url,
					policy ? { headers, referrerPolicy: policy, signal } : { headers, signal },
				);
				return;
			}
			await fetchImpl(
				candidate.url,
				policy ? { referrerPolicy: policy, signal } : { signal },
			);
		} catch {
			// A prefetch that fails is simply a prefetch that did not help.
		} finally {
			if (inFlight === controller) {
				inFlight = null;
			}
		}
	}

	return {
		tick() {
			const remaining = options.getRemainingSeconds();
			if (
				remaining === null ||
				remaining < 0 ||
				remaining > PREFETCH_LEAD_SECONDS ||
				(options.canWarm && !options.canWarm())
			) {
				return;
			}
			const candidate = resolveMediaCandidate(options.getNext());
			if (!candidate || candidate.key === attemptedKey) {
				return;
			}
			attemptedKey = candidate.key;
			void warm(candidate);
		},
		/** The room moved on; abort the old warm-up and allow the next item to warm. */
		reset() {
			inFlight?.abort();
			inFlight = null;
			attemptedKey = null;
		},
	};
}
