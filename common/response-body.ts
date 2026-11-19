const CONTENT_LENGTH_INTEGER = /^\d+$/;

/** Stop a stream without waiting for an uncooperative producer or another tee branch. */
function cancelBody(body: { cancel(): Promise<void> } | null): void {
	// eslint-disable-next-line promise/prefer-await-to-then -- Cancellation must not block rejection.
	void body?.cancel().catch(() => {
		// Cancellation is best effort and must not mask the response failure.
	});
}

function checkAborted(signal?: AbortSignal): void {
	if (signal?.aborted) {
		throw signal.reason ?? new Error("Response body read aborted");
	}
}

/** Count decoded response bytes, including responses without a trustworthy Content-Length. */
export async function readBoundedText(
	response: Response,
	maxBytes: number,
	signal?: AbortSignal,
): Promise<string> {
	if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
		throw new RangeError("Response byte limit must be a non-negative safe integer");
	}
	if (signal?.aborted) {
		cancelBody(response.body);
		checkAborted(signal);
	}
	const declaredLength = response.headers.get("content-length")?.trim();
	if (
		declaredLength &&
		CONTENT_LENGTH_INTEGER.test(declaredLength) &&
		Number(declaredLength) > maxBytes
	) {
		cancelBody(response.body);
		throw new Error("Response body exceeds byte limit");
	}
	if (!response.body) {
		return "";
	}

	const reader = response.body.getReader();
	const onAbort = () => cancelBody(reader);
	signal?.addEventListener("abort", onAbort, { once: true });
	let complete = false;
	let bytes = 0;
	let chunks = 0;
	let buffer = new Uint8Array(Math.min(maxBytes, 64 * 1024));
	try {
		for (;;) {
			checkAborted(signal);
			const { value, done } = await reader.read();
			checkAborted(signal);
			if (done) {
				complete = true;
				return new TextDecoder().decode(buffer.subarray(0, bytes));
			}
			const nextBytes = bytes + value.byteLength;
			if (nextBytes > maxBytes) {
				throw new Error("Response body exceeds byte limit");
			}
			if (nextBytes > buffer.byteLength) {
				const grown = new Uint8Array(
					Math.min(maxBytes, Math.max(nextBytes, buffer.byteLength * 2)),
				);
				grown.set(buffer.subarray(0, bytes));
				buffer = grown;
			}
			buffer.set(value, bytes);
			bytes = nextBytes;
			// Tiny synchronous chunks must not starve the deadline timer or the UI.
			if (++chunks % 256 === 0) {
				await new Promise<void>(resolve => setTimeout(resolve, 0));
			}
		}
	} finally {
		signal?.removeEventListener("abort", onAbort);
		if (!complete) {
			cancelBody(reader);
		}
		reader.releaseLock();
	}
}
