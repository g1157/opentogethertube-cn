import { beforeEach, describe, expect, it, vi } from "vitest";
import type { QueueItem } from "ott-common/models/video";
import { createNextMediaPrefetch, resolveMediaCandidate } from "@/util/next-media-prefetch";

function item(overrides: Partial<QueueItem>): QueueItem {
	return { service: "hls", id: "https://cdn.example.com/master.m3u8", ...overrides } as QueueItem;
}

describe("next media candidate", () => {
	it.each([
		["hls", { service: "hls", id: "https://cdn/a.m3u8" }, "https://cdn/a.m3u8"],
		[
			"hls with a separate url",
			// eslint-disable-next-line camelcase -- the shared model keeps the server's field name
			{ service: "hls", id: "https://cdn/a.m3u8", hls_url: "https://cdn/real.m3u8" },
			"https://cdn/real.m3u8",
		],
		["dash", { service: "dash", id: "https://cdn/a.mpd" }, "https://cdn/a.mpd"],
		["direct", { service: "direct", id: "https://cdn/movie.mp4" }, "https://cdn/movie.mp4"],
		[
			"odysee over hls",
			{ service: "odysee", id: "https://cdn/a", mime: "application/x-mpegurl" },
			"https://cdn/a",
		],
	] as const)("resolves %s", (_name, source, url) => {
		expect(resolveMediaCandidate(source as QueueItem)?.url).toBe(url);
	});

	it("carries the probed referrer policy along with the candidate", () => {
		const candidate = resolveMediaCandidate(
			item({ mediaAccess: { referrerPolicy: "no-referrer" } }),
		);
		expect(candidate?.referrerPolicy).toBe("no-referrer");
	});

	it.each([
		["youtube", { service: "youtube", id: "dQw4w9WgXcQ" }],
		["vimeo", { service: "vimeo", id: "12345" }],
		["peertube", { service: "peertube", id: "https://video.example/w/abc" }],
		["an mp4 odysee link without a mime", { service: "odysee", id: "https://cdn/a" }],
	])("has nothing to warm for %s", (_name, source) => {
		expect(resolveMediaCandidate(source as QueueItem)).toBeNull();
	});
});

describe("next media prefetch", () => {
	let fetchImpl: ReturnType<typeof vi.fn>;
	let remaining: number | null;
	let next: QueueItem | null;
	let prefetch: ReturnType<typeof createNextMediaPrefetch>;

	beforeEach(() => {
		fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
		remaining = 20;
		next = item({});
		prefetch = createNextMediaPrefetch({
			getRemainingSeconds: () => remaining,
			getNext: () => next,
			fetchImpl: fetchImpl as unknown as typeof fetch,
		});
	});

	it("warms the manifest once the end is close", () => {
		prefetch.tick();
		prefetch.tick();
		expect(fetchImpl).toHaveBeenCalledOnce();
		expect(fetchImpl).toHaveBeenCalledWith("https://cdn.example.com/master.m3u8");
	});

	it("stays idle until the lead window", () => {
		remaining = 120;
		prefetch.tick();
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it("does nothing without a known remaining time or a next item", () => {
		remaining = null;
		prefetch.tick();
		remaining = 10;
		next = null;
		prefetch.tick();
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it("requests only the first bytes of a progressive file", () => {
		next = item({ service: "direct", id: "https://cdn/movie.mp4" });
		prefetch.tick();
		expect(fetchImpl).toHaveBeenCalledWith("https://cdn/movie.mp4", {
			headers: { Range: "bytes=0-262143" },
		});
	});

	it("does not warm the same item twice, but does warm the next one", () => {
		prefetch.tick();
		next = item({ id: "https://cdn/other.m3u8" });
		prefetch.tick();
		expect(fetchImpl).toHaveBeenCalledTimes(2);
	});

	it("warms without a Referer when the source refuses this origin", () => {
		next = item({ mediaAccess: { referrerPolicy: "no-referrer" } });
		prefetch.tick();
		expect(fetchImpl).toHaveBeenCalledWith("https://cdn.example.com/master.m3u8", {
			referrerPolicy: "no-referrer",
		});
	});

	it("ignores a failed prefetch", async () => {
		fetchImpl.mockRejectedValueOnce(new Error("CORS"));
		prefetch.tick();
		await Promise.resolve();
		expect(fetchImpl).toHaveBeenCalledOnce();
	});
});
