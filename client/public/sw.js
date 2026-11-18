// Minimal service worker: it exists so the browser can offer to install the site as an
// app (Chrome requires a fetch handler), and it caches only the content-hashed bundle.
//
// Everything else - navigations, the API, the WebSocket, and the media itself - always
// goes to the network, so a deploy can never come back as a stale page. Caches belong to
// this app's scope; activating must not delete another app's same-origin storage.
const CACHE_PREFIX = `ott-assets:${self.registration.scope}:`;
const CACHE = `${CACHE_PREFIX}v2`;
const ASSETS_PATH = new URL("assets/", self.registration.scope).pathname;
const ROOT_SCOPE = new URL(self.registration.scope).pathname === "/";
const MAX_CACHE_ENTRIES = 128;

async function storeAsset(cache, request, response) {
	try {
		await cache.put(request, response);
		const keys = await cache.keys();
		await Promise.all(
			keys
				.slice(0, Math.max(0, keys.length - MAX_CACHE_ENTRIES))
				.map(key => cache.delete(key)),
		);
	} catch {
		// A quota or storage failure must not turn a successful network load into a failure.
	}
}

self.addEventListener("install", () => {
	void self.skipWaiting();
});

self.addEventListener("activate", event => {
	event.waitUntil(
		(async () => {
			const names = await caches.keys();
			await Promise.all(
				names
					.filter(
						name =>
							(name.startsWith(CACHE_PREFIX) && name !== CACHE) ||
							(ROOT_SCOPE && name === "ott-assets-v1"),
					)
					.map(name => caches.delete(name)),
			);
			await self.clients.claim();
		})(),
	);
});

self.addEventListener("fetch", event => {
	const request = event.request;
	if (request.method !== "GET") {
		return;
	}
	const url = new URL(request.url);
	// The bundle's file names carry their content hash, so a hit is always the current
	// build's own asset; anything else is left to the network.
	if (url.origin !== self.location.origin || !url.pathname.startsWith(ASSETS_PATH)) {
		return;
	}
	event.respondWith(
		(async () => {
			const cache = await caches.open(CACHE);
			const hit = await cache.match(request);
			if (hit) {
				return hit;
			}
			const response = await fetch(request);
			if (response.ok) {
				event.waitUntil(storeAsset(cache, request, response.clone()));
			}
			return response;
		})(),
	);
});
