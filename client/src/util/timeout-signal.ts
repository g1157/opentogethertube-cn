/**
 * `AbortSignal.timeout` is missing in some browsers and in jsdom; fall back to a plain
 * controller so a request timeout works everywhere. The timer is unref'd where Node
 * supports it, so a completed request never keeps a process alive.
 */
export function timeoutSignal(milliseconds: number): AbortSignal {
	if (typeof AbortSignal.timeout === "function") {
		return AbortSignal.timeout(milliseconds);
	}
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), milliseconds);
	(timer as unknown as { unref?: () => void }).unref?.();
	return controller.signal;
}
