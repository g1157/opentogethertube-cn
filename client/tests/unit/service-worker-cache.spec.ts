import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

const workerSource = readFileSync("public/sw.js", "utf8");

function worker(scope = "https://example.test/watch/") {
	const handlers = new Map<string, (event: Record<string, unknown>) => void>();
	const cache = {
		match: vi.fn().mockResolvedValue(undefined),
		put: vi.fn().mockResolvedValue(undefined),
		keys: vi.fn().mockResolvedValue([]),
		delete: vi.fn().mockResolvedValue(true),
	};
	const caches = {
		keys: vi.fn().mockResolvedValue([]),
		delete: vi.fn().mockResolvedValue(true),
		open: vi.fn().mockResolvedValue(cache),
	};
	const response = {
		ok: true,
		headers: { get: vi.fn().mockReturnValue("text/javascript; charset=utf-8") },
		clone: vi.fn().mockReturnValue({ cached: true }),
	};
	const fetch = vi.fn().mockResolvedValue(response);
	runInNewContext(workerSource, {
		self: {
			registration: { scope },
			location: new URL(scope),
			clients: { claim: vi.fn().mockResolvedValue(undefined) },
			skipWaiting: vi.fn().mockResolvedValue(undefined),
			addEventListener: (name: string, handler: (event: Record<string, unknown>) => void) =>
				handlers.set(name, handler),
		},
		URL,
		caches,
		fetch,
		console,
	});
	return { handlers, cache, caches, fetch, response };
}

describe("service worker cache isolation", () => {
	it("only removes previous caches belonging to its own application scope", async () => {
		const { handlers, caches } = worker();
		caches.keys.mockResolvedValue([
			"ott-assets-v1",
			"ott-assets:https://example.test/watch/:v1",
			"ott-assets:https://example.test/watch/:v2",
			"ott-assets:https://example.test/watch/:v3",
			"ott-assets:https://example.test/other/:v1",
			"another-application-cache",
		]);
		let completed: Promise<unknown> | undefined;
		handlers.get("activate")?.({ waitUntil: (task: Promise<unknown>) => (completed = task) });
		await completed;
		expect(caches.delete.mock.calls.map(([name]) => name)).toEqual([
			"ott-assets:https://example.test/watch/:v1",
			"ott-assets:https://example.test/watch/:v2",
		]);
	});

	it("migrates the old root cache without removing unrelated origin caches", async () => {
		const { handlers, caches } = worker("https://example.test/");
		caches.keys.mockResolvedValue(["ott-assets-v1", "another-application-cache"]);
		let completed: Promise<unknown> | undefined;
		handlers.get("activate")?.({ waitUntil: (task: Promise<unknown>) => (completed = task) });
		await completed;
		expect(caches.delete).toHaveBeenCalledTimes(1);
		expect(caches.delete).toHaveBeenCalledWith("ott-assets-v1");
	});

	it("caches assets below its scope and retains the write for the worker lifetime", async () => {
		const { handlers, cache, caches, fetch, response } = worker();
		const request = { method: "GET", url: "https://example.test/watch/assets/video-AbC.js" };
		let result: Promise<unknown> | undefined;
		const tasks: Promise<unknown>[] = [];
		handlers.get("fetch")?.({
			request,
			respondWith: (task: Promise<unknown>) => (result = task),
			waitUntil: (task: Promise<unknown>) => tasks.push(task),
		});
		expect(await result).toBe(response);
		await Promise.all(tasks);
		expect(fetch).toHaveBeenCalledTimes(1);
		expect(fetch).toHaveBeenCalledWith(request);
		expect(caches.open).toHaveBeenCalledWith("ott-assets:https://example.test/watch/:v3");
		expect(cache.put).toHaveBeenCalledTimes(1);
		expect(cache.put).toHaveBeenCalledWith(request, { cached: true });
		expect(tasks).toHaveLength(1);
		const respondWith = vi.fn();
		handlers.get("fetch")?.({
			request: { method: "GET", url: "https://example.test/assets/other-AbC.js" },
			respondWith,
		});
		expect(respondWith).not.toHaveBeenCalled();
	});

	it("evicts the oldest assets when the entry limit is reached", async () => {
		const { handlers, cache } = worker();
		const keys = Array.from({ length: 130 }, (_, index) => ({ url: `asset-${index}` }));
		cache.keys.mockResolvedValue(keys);
		let result: Promise<unknown> | undefined;
		const tasks: Promise<unknown>[] = [];
		handlers.get("fetch")?.({
			request: { method: "GET", url: "https://example.test/watch/assets/video-AbC.js" },
			respondWith: (task: Promise<unknown>) => (result = task),
			waitUntil: (task: Promise<unknown>) => tasks.push(task),
		});
		await result;
		await Promise.all(tasks);
		expect(cache.delete.mock.calls.map(([key]) => key)).toEqual(keys.slice(0, 2));
	});

	it("returns a successful network response even when the cache quota is exhausted", async () => {
		const { handlers, cache, response } = worker();
		cache.put.mockRejectedValue(new Error("Quota exceeded"));
		let result: Promise<unknown> | undefined;
		const tasks: Promise<unknown>[] = [];
		handlers.get("fetch")?.({
			request: { method: "GET", url: "https://example.test/watch/assets/video-AbC.js" },
			respondWith: (task: Promise<unknown>) => (result = task),
			waitUntil: (task: Promise<unknown>) => tasks.push(task),
		});
		expect(await result).toBe(response);
		await expect(Promise.all(tasks)).resolves.toBeDefined();
	});
});

describe("service worker fallback response boundaries", () => {
	it.each([
		"text/html; charset=utf-8",
		"application/xhtml+xml",
		undefined,
	])("does not cache an HTML fallback or an untyped response: %s", async contentType => {
		const { handlers, cache, fetch } = worker();
		const response = new Response(
			new TextEncoder().encode("<!doctype html><title>SPA fallback</title>"),
			{
				headers: contentType ? { "Content-Type": contentType } : {},
			},
		);
		fetch.mockResolvedValue(response);
		const tasks: Promise<unknown>[] = [];
		let result: Promise<unknown> | undefined;
		handlers.get("fetch")?.({
			request: { method: "GET", url: "https://example.test/watch/assets/missing-AbC.js" },
			respondWith: (task: Promise<unknown>) => (result = task),
			waitUntil: (task: Promise<unknown>) => tasks.push(task),
		});
		expect(await result).toBe(response);
		await Promise.all(tasks);
		expect(cache.put).not.toHaveBeenCalled();
	});
});
