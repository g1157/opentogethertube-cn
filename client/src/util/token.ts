import type { FullOTTStoreState } from "../store";
import type { Store } from "vuex";

function hasStoredToken(): boolean {
	return Boolean(window.localStorage.getItem("token")?.trim());
}

export async function waitForToken(store: Store<FullOTTStoreState>) {
	// A Vuex getter cannot track localStorage changes. Read the same source as WebSocket auth.
	if (hasStoredToken()) {
		return;
	}
	console.info("Waiting for auth token...");
	return new Promise<void>(resolve => {
		const unsub = store.subscribe(mutation => {
			if (mutation.type === "users/SET_AUTH_TOKEN" && hasStoredToken()) {
				console.info("Got auth token");
				resolve();
				unsub();
			}
		});
	});
}
