let searchEnabled: boolean | null = null;

/** Fetches backend capabilities once per page load; defaults to enabled on any failure. */
export async function getSearchEnabled(): Promise<boolean> {
	if (searchEnabled !== null) {
		return searchEnabled;
	}
	try {
		const res = await fetch("/api/status", { cache: "no-store", credentials: "same-origin" });
		if (res.ok) {
			const data = (await res.json()) as { searchEnabled?: unknown };
			searchEnabled = typeof data.searchEnabled === "boolean" ? data.searchEnabled : true;
		}
	} catch {
		// Keep the default so the input still accepts URLs.
	}
	return searchEnabled ?? true;
}
