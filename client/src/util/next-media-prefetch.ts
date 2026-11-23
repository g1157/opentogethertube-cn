import type { QueueItem } from "ott-common/models/video";
import { referrerPolicyValue } from "./media-access";

/** How close to the end of the current item the next one starts warming. */
export const PREFETCH_LEAD_SECONDS = 30;
/** Enough of a progressive file to cover DNS, TLS and the first range request. */
export const PREFETCH_BYTES = 262_144;
/** A host that ignores Range must not keep a warm-up socket alive forever. */
const PREFETCH_TIMEOUT_MS = 8_000;

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
		const timer = setTimeout(() => controller.abort(), PREFETCH_TIMEOUT_MS);
		timer.unref?.();
		let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
		const cancelOnAbort = () => {
			void reader?.cancel().catch(() => undefined);
		};
		signal.addEventListener("abort", cancelOnAbort, { once: true });
		try {
			const response = await fetchImpl(
				candidate.url,
				policy
					? candidate.service === "direct" || candidate.service === "googledrive"
						? {
								headers: { Range: `bytes=0-${PREFETCH_BYTES - 1}` },
								referrerPolicy: policy,
								signal,
							}
						: { referrerPolicy: policy, signal }
					: candidate.service === "direct" || candidate.service === "googledrive"
						? { headers: { Range: `bytes=0-${PREFETCH_BYTES - 1}` }, signal }
						: { signal },
			);
			if (!response.ok || !response.body) {
				await response.body?.cancel().catch(() => undefined);
				return;
			}
			if (candidate.service !== "direct" && candidate.service !== "googledrive") {
				// A manifest is fetched again by the real player; headers already warmed DNS/TLS.
				await response.body.cancel().catch(() => undefined);
				return;
			}
			reader = response.body.getReader();
			let read = 0;
			while (read < PREFETCH_BYTES && !signal.aborted) {
				const chunk = await reader.read();
				if (chunk.done) {
					break;
				}
				read += chunk.value.byteLength;
			}
			// Do not spend the room's bandwidth on a host that ignores Range.
			await reader.cancel().catch(() => undefined);
		} catch {
			// A prefetch that fails is simply a prefetch that did not help.
		} finally {
			signal.removeEventListener("abort", cancelOnAbort);
			clearTimeout(timer);
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
