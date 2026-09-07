const REVISION_PATTERN = /^[a-f\d]{7,40}$/i;
const UPDATE_QUERY = "_ott_update";

interface ClientUpdateOptions {
	revision: string;
	versionUrl: string;
	getUrl?: () => string;
	navigate?: (url: string) => void;
	updateUrl?: (url: string) => void;
}

function sameRevision(a: string, b: string) {
	return a.startsWith(b) || b.startsWith(a);
}

function mayRefresh() {
	return (
		!document.hidden &&
		!document.activeElement?.closest(
			'input, textarea, [contenteditable]:not([contenteditable="false"])',
		)
	);
}

/** Refresh a stale build without relying on a cached document, once per target revision. */
export function installClientUpdateCheck(options: ClientUpdateOptions) {
	const getUrl = options.getUrl ?? (() => window.location.href);
	const navigate = options.navigate ?? (url => window.location.replace(url));
	const updateUrl =
		options.updateUrl ?? (url => window.history.replaceState(window.history.state, "", url));
	let disposed = false;
	let checking = false;
	let reloading = false;
	let controller: AbortController | null = null;
	const revision = options.revision.toLowerCase();
	const initialUrl = new URL(getUrl());
	const initialTarget = initialUrl.searchParams.get(UPDATE_QUERY);
	if (initialTarget && REVISION_PATTERN.test(revision) && sameRevision(initialTarget, revision)) {
		initialUrl.searchParams.delete(UPDATE_QUERY);
		updateUrl(initialUrl.href);
	}

	async function check() {
		if (disposed || checking || reloading || !REVISION_PATTERN.test(revision)) {
			return;
		}
		// Avoid interrupting an unsent message or a login form while it is being edited.
		if (!mayRefresh()) {
			return;
		}
		checking = true;
		controller = new AbortController();
		const timeout = setTimeout(() => controller?.abort(), 5000);
		try {
			const response = await fetch(options.versionUrl, {
				cache: "no-store",
				credentials: "same-origin",
				signal: controller.signal,
			});
			if (!response.ok) {
				return;
			}
			const data: unknown = await response.json();
			const target =
				data && typeof data === "object" && "revision" in data ? data.revision : null;
			if (disposed || typeof target !== "string" || !REVISION_PATTERN.test(target)) {
				return;
			}
			const next = target.toLowerCase();
			if (sameRevision(revision, next)) {
				return;
			}
			if (!mayRefresh()) {
				return;
			}
			const url = new URL(getUrl());
			if (initialTarget === next || url.searchParams.get(UPDATE_QUERY) === next) {
				return;
			}
			url.searchParams.set(UPDATE_QUERY, next);
			reloading = true;
			navigate(url.href);
		} catch {
			// A network outage or an older server must not break an already loaded room.
		} finally {
			clearTimeout(timeout);
			controller = null;
			checking = false;
		}
	}

	const onWake = () => void check();
	const timer = setInterval(onWake, 30000);
	window.addEventListener("pageshow", onWake);
	window.addEventListener("online", onWake);
	document.addEventListener("visibilitychange", onWake);
	void check();
	return {
		check,
		dispose() {
			disposed = true;
			controller?.abort();
			clearInterval(timer);
			window.removeEventListener("pageshow", onWake);
			window.removeEventListener("online", onWake);
			document.removeEventListener("visibilitychange", onWake);
		},
	};
}
