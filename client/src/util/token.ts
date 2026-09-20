import type { FullOTTStoreState } from "../store";
import type { Store } from "vuex";

function hasStoredToken(): boolean {
	return Boolean(window.localStorage.getItem("token")?.trim());
}

const RETRY_INTERVAL_MS = 3000;
const DEFAULT_TIMEOUT_MS = 15000;

/**
 * Wait until the browser holds an auth token, actively re-requesting one while we wait.
 *
 * A single failed /api/auth/grant used to wedge the room page forever: the old promise
 * only resolved when a token was written, never rejected, and nothing ever retried the
 * grant — leaving the page on "connecting..." with no websocket and no error. Now the
 * wait is bounded, grants are retried while we wait, and the timeout rejects so the
 * caller can show an error and try again.
 */
export async function waitForToken(
	store: Store<FullOTTStoreState>,
	timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<void> {
	if (hasStoredToken()) {
		return;
	}
	const deadline = Date.now() + timeoutMs;
	let lastError: unknown;
	while (!hasStoredToken()) {
		if (Date.now() >= deadline) {
			throw new Error(
				`Timed out waiting for an auth token${lastError ? `: ${String(lastError)}` : ""}`,
			);
		}
		try {
			await store.dispatch("users/getNewToken");
		} catch (e) {
			// Rate limits, tunnel blips, cold servers: keep trying until the deadline.
			lastError = e;
		}
		if (hasStoredToken()) {
			return;
		}
		await new Promise(resolve => setTimeout(resolve, RETRY_INTERVAL_MS));
	}
}
