/**
 * Registers the installability service worker (see `client/public/sw.js`).
 *
 * Production only: in development a worker would sit between the dev server and the app
 * and fight HMR, and one left over from a preview build would keep serving it stale files.
 * The worker itself only caches the content-hashed bundle, so a deploy is never stale.
 */
export function installServiceWorker(): void {
	if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) {
		return;
	}
	window.addEventListener("load", () => {
		void navigator.serviceWorker.register("/sw.js").catch(err => {
			console.warn("Service worker registration failed:", err);
		});
	});
}
