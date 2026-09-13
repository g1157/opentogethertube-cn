import { ref, type Ref } from "vue";

const GIT_REVISION_PATTERN = /^[a-f\d]{7,40}$/i;
const REVISION_PATTERN = /^(?:[a-f\d]{7,40}|cloudflare-preview-\d+\.\d+\.\d+)$/i;
const UPDATE_QUERY = "_ott_update";
/** Poll interval for the version check; also used by tests. */
export const CHECK_INTERVAL_MS = 120_000;

interface ClientUpdateOptions {
	revision: string;
	versionUrl: string;
	getUrl?: () => string;
	navigate?: (url: string) => void;
	updateUrl?: (url: string) => void;
}

export interface ClientUpdateWatcher {
	check(): Promise<void>;
	dispose(): void;
}

/** The UI shows a refresh notice while this is true. */
export const clientUpdateReady: Ref<boolean> = ref(false);
let pendingUpdateUrl: string | null = null;
let pendingRevision: string | null = null;
let dismissedRevision: string | null = null;
let navigateForUpdate: ((url: string) => void) | null = null;
let activeWatcher: ClientUpdateWatcher | null = null;

function resetClientUpdateState() {
	clientUpdateReady.value = false;
	pendingUpdateUrl = null;
	pendingRevision = null;
	dismissedRevision = null;
	navigateForUpdate = null;
}

/** Refresh to the newly deployed build. Only runs after the user asks for it. */
export function applyClientUpdate(): void {
	if (pendingUpdateUrl === null) {
		return;
	}
	navigateForUpdate?.(pendingUpdateUrl);
}

/** Keep the current page; do not offer the same build again until a newer one appears. */
export function dismissClientUpdate(): void {
	clientUpdateReady.value = false;
	dismissedRevision = pendingRevision;
}

function sameRevision(a: string, b: string) {
	return (
		a === b ||
		(GIT_REVISION_PATTERN.test(a) &&
			GIT_REVISION_PATTERN.test(b) &&
			(a.startsWith(b) || b.startsWith(a)))
	);
}

function mayRefresh() {
	return (
		!document.hidden &&
		!document.activeElement?.closest(
			'input, textarea, [contenteditable]:not([contenteditable="false"])',
		)
	);
}

/** Watch for a stale build and offer a refresh instead of reloading under the user. */
export function installClientUpdateCheck(options: ClientUpdateOptions): ClientUpdateWatcher {
	const getUrl = options.getUrl ?? (() => window.location.href);
	const navigate = options.navigate ?? (url => window.location.replace(url));
	const updateUrl =
		options.updateUrl ?? (url => window.history.replaceState(window.history.state, "", url));
	let disposed = false;
	let checking = false;
	let controller: AbortController | null = null;
	const revision = options.revision.toLowerCase();
	const initialUrl = new URL(getUrl());
	const initialTarget = initialUrl.searchParams.get(UPDATE_QUERY);
	if (initialTarget && REVISION_PATTERN.test(revision) && sameRevision(initialTarget, revision)) {
		initialUrl.searchParams.delete(UPDATE_QUERY);
		updateUrl(initialUrl.href);
	}
	resetClientUpdateState();
	navigateForUpdate = navigate;

	async function check() {
		if (disposed || checking || clientUpdateReady.value || !REVISION_PATTERN.test(revision)) {
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
			if (sameRevision(revision, next) || next === dismissedRevision) {
				return;
			}
			if (clientUpdateReady.value || next === pendingRevision || !mayRefresh()) {
				return;
			}
			const url = new URL(getUrl());
			if (initialTarget === next || url.searchParams.get(UPDATE_QUERY) === next) {
				return;
			}
			url.searchParams.set(UPDATE_QUERY, next);
			pendingRevision = next;
			pendingUpdateUrl = url.href;
			clientUpdateReady.value = true;
		} catch {
			// A network outage or an older server must not break an already loaded room.
		} finally {
			clearTimeout(timeout);
			controller = null;
			checking = false;
		}
	}

	const onWake = () => void check();
	// 2 minutes keeps Cloudflare Worker requests low while still noticing new deployments quickly.
	const timer = setInterval(onWake, CHECK_INTERVAL_MS);
	window.addEventListener("pageshow", onWake);
	window.addEventListener("online", onWake);
	document.addEventListener("visibilitychange", onWake);
	void check();
	const watcher: ClientUpdateWatcher = {
		check,
		dispose() {
			disposed = true;
			controller?.abort();
			clearInterval(timer);
			window.removeEventListener("pageshow", onWake);
			window.removeEventListener("online", onWake);
			document.removeEventListener("visibilitychange", onWake);
			if (activeWatcher === watcher) {
				activeWatcher = null;
				resetClientUpdateState();
			}
		},
	};
	activeWatcher = watcher;
	return watcher;
}
