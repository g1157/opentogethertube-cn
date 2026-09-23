/**
 * The referrer policy a probed source requires, translated into the value the DOM and fetch
 * accept. Anything unrecognized (including a newer policy this client does not know) means
 * the default, so an old client simply keeps its current behavior.
 */
export function referrerPolicyValue(policy: string | undefined): ReferrerPolicy | undefined {
	return policy === "no-referrer" ? "no-referrer" : undefined;
}
