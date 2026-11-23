/**
 * hls.js starts every session from a fixed guess (500 kbps) unless the application seeds it.
 * Remembering what the last session measured turns a cold start on a known network into an
 * immediate, sensible quality pick instead of a low one that has to ramp up. The value is
 * the viewer's link, not the source's, so one number is enough — but it must expire, and a
 * hint measured on 4G must not pick a high rendition after the viewer moved to 3G.
 */
const STORAGE_KEY = "ott/hls-bandwidth-estimate";
/** Below this the estimate is noise; above it hls.js caps its own default anyway. */
const MIN_ESTIMATE = 250_000;
const MAX_ESTIMATE = 5_000_000;
/** A network hint older than this says more about the past than the current session. */
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

interface StoredEstimate {
	value: number;
	at: number;
	network?: string;
}

const NETWORK_RANK: Record<string, number> = {
	"slow-2g": 0,
	"2g": 1,
	"3g": 2,
	"4g": 3,
};

function currentNetwork(): string | undefined {
	if (typeof navigator === "undefined") {
		return undefined;
	}
	const connection = (navigator as Navigator & { connection?: { effectiveType?: string } })
		.connection;
	return connection?.effectiveType;
}

function saveDataEnabled(): boolean {
	if (typeof navigator === "undefined") {
		return false;
	}
	return (
		(navigator as Navigator & { connection?: { saveData?: boolean } }).connection?.saveData ===
		true
	);
}

function parse(raw: string | null): StoredEstimate | null {
	if (raw === null) {
		return null;
	}
	try {
		const parsed: unknown = JSON.parse(raw);
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			return null;
		}
		const value = (parsed as { value?: unknown }).value;
		const at = (parsed as { at?: unknown }).at;
		const network = (parsed as { network?: unknown }).network;
		if (
			typeof value !== "number" ||
			!Number.isFinite(value) ||
			value < MIN_ESTIMATE ||
			value > MAX_ESTIMATE ||
			typeof at !== "number" ||
			!Number.isFinite(at)
		) {
			return null;
		}
		return {
			value,
			at,
			...(typeof network === "string" ? { network } : {}),
		};
	} catch {
		// An older build stored a bare number; without a timestamp it is not trusted.
		return null;
	}
}

export function recallHlsBandwidthEstimate(): number | null {
	if (saveDataEnabled()) {
		return null;
	}
	try {
		const stored = parse(window.localStorage.getItem(STORAGE_KEY));
		if (!stored || Date.now() - stored.at > MAX_AGE_MS) {
			return null;
		}
		const now = currentNetwork();
		// A slower network invalidates a faster hint; a faster network may keep the
		// conservative one, which only means a short ramp-up rather than an aggressive pick.
		if (
			now &&
			stored.network &&
			(NETWORK_RANK[now] ?? 99) < (NETWORK_RANK[stored.network] ?? 99)
		) {
			return null;
		}
		return stored.value;
	} catch {
		// Private browsing or storage limits must not prevent loading a source.
		return null;
	}
}

export function rememberHlsBandwidthEstimate(estimate: number) {
	if (!Number.isFinite(estimate) || estimate < MIN_ESTIMATE || estimate > MAX_ESTIMATE) {
		return;
	}
	try {
		const value: StoredEstimate = {
			value: Math.round(estimate),
			at: Date.now(),
			...(currentNetwork() ? { network: currentNetwork() } : {}),
		};
		window.localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
	} catch {
		// Storing the hint is best effort; playback must not depend on it.
	}
}
