import { afterEach, describe, expect, it, vi } from "vitest";
import { applyCommandTimeout } from "../../redisclient.js";

const TIMEOUT = /Redis get command timed out/;

describe("Redis command deadline", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("aborts a generated command instead of leaving the caller waiting", async () => {
		vi.useFakeTimers();
		const get = vi.fn((options: { signal?: AbortSignal }, _key: string) => {
			return new Promise((_resolve, reject) => {
				options.signal?.addEventListener("abort", () => reject(new Error("aborted")));
			});
		});
		const client = {
			commandOptions: (options: unknown) => options,
			get,
		} as unknown as Parameters<typeof applyCommandTimeout>[0];

		applyCommandTimeout(client);
		const pending = client.get("key");
		const assertion = expect(pending).rejects.toThrow(TIMEOUT);
		await vi.advanceTimersByTimeAsync(5000);
		await assertion;

		expect(get).toHaveBeenCalledWith(
			expect.objectContaining({ signal: expect.any(AbortSignal) }),
			"key",
		);
	});
});
