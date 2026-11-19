import { describe, expect, it, vi } from "vitest";
import { readBoundedText } from "../../response-body.js";

function responseFromChunks(parts: Uint8Array[], cancel = vi.fn()): Response {
	return new Response(
		new ReadableStream({
			start(controller) {
				for (const part of parts) {
					controller.enqueue(part);
				}
				controller.close();
			},
			cancel,
		}),
	);
}

describe("bounded response text", () => {
	it("preserves UTF-8 characters split across chunks at the exact byte budget", async () => {
		const bytes = new TextEncoder().encode("a\u20ac");
		const response = responseFromChunks([bytes.slice(0, 2), bytes.slice(2)]);
		expect(await readBoundedText(response, 4)).toBe("a\u20ac");
	});

	it("supports an empty response and a zero byte budget", async () => {
		expect(await readBoundedText(new Response(null), 0)).toBe("");
	});

	it.each([
		-1,
		0.5,
		Number.NaN,
		Number.POSITIVE_INFINITY,
	])("rejects an invalid limit: %s", async limit => {
		await expect(readBoundedText(new Response("x"), limit)).rejects.toThrow(RangeError);
	});

	it("cancels a declared oversized body before buffering it", async () => {
		const cancel = vi.fn();
		const response = new Response(new ReadableStream({ cancel }), {
			headers: { "Content-Length": "999999999999999999999999" },
		});
		await expect(readBoundedText(response, 4)).rejects.toThrow("byte limit");
		expect(cancel).toHaveBeenCalledTimes(1);
	});

	it.each([
		undefined,
		"1",
		"not-a-size",
	])("counts actual bytes with Content-Length %s", async length => {
		const cancel = vi.fn();
		const response = new Response(
			new ReadableStream({
				start(controller) {
					controller.enqueue(new Uint8Array(3));
					controller.enqueue(new Uint8Array(2));
				},
				cancel,
			}),
			{ headers: length === undefined ? {} : { "Content-Length": length } },
		);
		await expect(readBoundedText(response, 4)).rejects.toThrow("byte limit");
		expect(cancel).toHaveBeenCalledTimes(1);
	});

	it("aborts a stalled read without waiting for the producer's cancellation", async () => {
		const controller = new AbortController();
		const cancel = vi.fn(
			() =>
				new Promise<void>(() => {
					// Deliberately stalled cancellation must not delay the abort result.
				}),
		);
		const response = new Response(new ReadableStream({ cancel }));
		const pending = readBoundedText(response, 10, controller.signal);
		controller.abort(new Error("deadline reached"));
		await expect(pending).rejects.toThrow("deadline reached");
		expect(cancel).toHaveBeenCalledTimes(1);
		expect(response.body?.locked).toBe(false);
	});

	it("cancels a response whose signal was already aborted", async () => {
		const controller = new AbortController();
		controller.abort(new Error("already aborted"));
		const cancel = vi.fn();
		await expect(
			readBoundedText(new Response(new ReadableStream({ cancel })), 10, controller.signal),
		).rejects.toThrow("already aborted");
		expect(cancel).toHaveBeenCalledTimes(1);
	});

	it("allows a deadline to fire even if a producer continuously emits tiny chunks", async () => {
		const controller = new AbortController();
		const response = new Response(
			new ReadableStream({
				pull(stream) {
					stream.enqueue(new Uint8Array([1]));
				},
			}),
		);
		const timer = setTimeout(() => controller.abort(new Error("deadline reached")), 0);
		try {
			await expect(readBoundedText(response, 4096, controller.signal)).rejects.toThrow(
				"deadline reached",
			);
		} finally {
			clearTimeout(timer);
		}
	});

	it("releases the reader after a stream error", async () => {
		const response = new Response(
			new ReadableStream({
				start(controller) {
					controller.error(new Error("broken upstream"));
				},
			}),
		);
		await expect(readBoundedText(response, 10)).rejects.toThrow("broken upstream");
		expect(response.body?.locked).toBe(false);
	});
});
