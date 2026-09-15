/**
 * hls.js starts every session from a fixed guess (500 kbps) unless the application seeds it.
 * Remembering what the last session measured turns a cold start on a known network into an
 * immediate, sensible quality pick instead of a low one that has to ramp up. The value is
 * the viewer's link, not the source's, so one number is enough.
 */
const STORAGE_KEY = "ott/hls-bandwidth-estimate";
/** Below this the estimate is noise; above it hls.js caps its own default anyway. */
const MIN_ESTIMATE = 250_000;
const MAX_ESTIMATE = 5_000_000;

export function recallHlsBandwidthEstimate(): number | null {
	try {
		const raw = window.localStorage.getItem(STORAGE_KEY);
		if (raw === null) {
			return null;
		}
		const value = Number(raw);
		if (!Number.isFinite(value) || value < MIN_ESTIMATE || value > MAX_ESTIMATE) {
			return null;
		}
		return value;
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
		window.localStorage.setItem(STORAGE_KEY, String(Math.round(estimate)));
	} catch {
		// Storing the hint is best effort; playback must not depend on it.
	}
}
