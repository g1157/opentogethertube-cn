import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadDanmaku } from "@/util/danmaku/fetch";
import * as parser from "@/util/danmaku/parse";
import { DANMAKU_MAX_XML_BYTES } from "ott-common/danmaku";

const XML = `<i><d p="1,1,25,16777215,0,0,0,0">hi</d></i>`;

describe("danmaku track cache", () => {
	beforeEach(() => {
		vi.unstubAllGlobals();
	});

	afterEach(() => {
		vi.restoreAllMocks();
		vi.useRealTimers();
		vi.unstubAllGlobals();
	});

	it("caches a loaded track", async () => {
		const fetchMock = vi.fn(async () => new Response(XML, { status: 200 }));
		vi.stubGlobal("fetch", fetchMock);
		const first = await loadDanmaku("https://danmu.example/track-ok.xml");
		const second = await loadDanmaku("https://danmu.example/track-ok.xml");
		expect(first).toHaveLength(1);
		expect(second).toEqual(first);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("retries a failed track instead of caching the miss", async () => {
		let calls = 0;
		const fetchMock = vi.fn(async () => {
			calls++;
			return calls === 1
				? new Response("missing", { status: 404 })
				: new Response(XML, { status: 200 });
		});
		vi.stubGlobal("fetch", fetchMock);
		const url = "https://danmu.example/track-retry.xml";

		expect(await loadDanmaku(url)).toBeNull();
		const retried = await loadDanmaku(url);
		expect(retried).toHaveLength(1);
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it("bounds the session cache", async () => {
		const fetchMock = vi.fn(async () => new Response(XML, { status: 200 }));
		vi.stubGlobal("fetch", fetchMock);
		for (let i = 0; i < 80; i++) {
			await loadDanmaku(`https://danmu.example/bound-${i}.xml`);
		}
		await loadDanmaku("https://danmu.example/bound-0.xml");
		expect(fetchMock).toHaveBeenCalledTimes(81);
	});
});

describe("danmaku resource boundaries", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		vi.useRealTimers();
		vi.unstubAllGlobals();
	});

	it("rejects a declared oversized track", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(
				async () =>
					new Response(XML, {
						headers: { "Content-Length": String(DANMAKU_MAX_XML_BYTES + 1) },
					}),
			),
		);
		expect(await loadDanmaku("https://danmu.example/declared-oversized.xml")).toBeNull();
	});

	it("rejects oversized decoded bytes even without Content-Length", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response(" ".repeat(DANMAKU_MAX_XML_BYTES) + XML)),
		);
		expect(await loadDanmaku("https://danmu.example/stream-oversized.xml")).toBeNull();
	});

	it("evicts tracks by accounted text and item bytes, not just entry count", async () => {
		const item: parser.DanmakuItem = {
			time: 1,
			mode: "scroll",
			color: "#ffffff",
			text: "a normal line",
		};
		vi.spyOn(parser, "parseDanmakuXml").mockReturnValue(
			Array.from({ length: 100_000 }, () => item),
		);
		const fetchMock = vi.fn(async () => new Response(XML));
		vi.stubGlobal("fetch", fetchMock);
		for (let index = 0; index < 3; index++) {
			await loadDanmaku("https://danmu.example/byte-cache-" + index + ".xml");
		}
		await loadDanmaku("https://danmu.example/byte-cache-0.xml");
		expect(fetchMock).toHaveBeenCalledTimes(4);
	});

	it("does not let an evicted failed request remove a newer cache entry", async () => {
		let finishOld!: (response: Response) => void;
		const url = "https://danmu.example/evicted-pending.xml";
		let first = true;
		const fetchMock = vi.fn(async (input: string) => {
			if (input === url && first) {
				first = false;
				return new Promise<Response>(resolve => {
					finishOld = resolve;
				});
			}
			return new Response(XML);
		});
		vi.stubGlobal("fetch", fetchMock);
		const old = loadDanmaku(url);
		try {
			for (let index = 0; index < 80; index++) {
				await loadDanmaku("https://danmu.example/evict-pending-" + index + ".xml");
			}
			expect(await loadDanmaku(url)).toHaveLength(1);
		} finally {
			finishOld(new Response("missing", { status: 404 }));
			await old;
		}
		expect(await loadDanmaku(url)).toHaveLength(1);
		expect(fetchMock).toHaveBeenCalledTimes(82);
	});

	it("bounds active downloads and retries a busy miss once capacity is available", async () => {
		const finish: ((response: Response) => void)[] = [];
		const fetchMock = vi.fn(async (input: string) => {
			if (input.includes("busy-blocked")) {
				return new Promise<Response>(resolve => {
					finish.push(resolve);
				});
			}
			return new Response(XML);
		});
		vi.stubGlobal("fetch", fetchMock);
		const requests = Array.from({ length: 4 }, (_, index) =>
			loadDanmaku("https://danmu.example/busy-blocked-" + index + ".xml"),
		);
		try {
			expect(await loadDanmaku("https://danmu.example/busy-retry.xml")).toBeNull();
			expect(fetchMock).toHaveBeenCalledTimes(4);
		} finally {
			for (const resolve of finish) {
				resolve(new Response(XML));
			}
			await Promise.all(requests);
		}
		expect(await loadDanmaku("https://danmu.example/busy-retry.xml")).toHaveLength(1);
		expect(fetchMock).toHaveBeenCalledTimes(5);
	});

	it("clears its deadline timer after a successful response", async () => {
		vi.useFakeTimers();
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response(XML)),
		);
		expect(await loadDanmaku("https://danmu.example/deadline-cleanup.xml")).toHaveLength(1);
		expect(vi.getTimerCount()).toBe(0);
	});
});
