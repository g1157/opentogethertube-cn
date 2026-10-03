// Minimal service worker: it exists so the browser can offer to install the site as an
// app (Chrome requires a fetch handler), and it caches only the content-hashed bundle.
//
// Everything else - navigations, the API, the WebSocket, and the media itself - always
// goes to the network, so a deploy can never come back as a stale page. Bump CACHE when
// the caching rule itself changes; old caches are dropped on activation.
const CACHE = "ott-assets-v1";

self.addEventListener("install", () => {
	void self.skipWaiting();
});

self.addEventListener("activate", event => {
	event.waitUntil(
		(async () => {
			const names = await caches.keys();
			await Promise.all(
				names.filter(name => name !== CACHE).map(name => caches.delete(name)),
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
	if (url.origin !== self.location.origin || !url.pathname.startsWith("/assets/")) {
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
				void cache.put(request, response.clone());
			}
			return response;
		})(),
	);
});
