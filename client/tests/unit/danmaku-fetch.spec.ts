import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadDanmaku } from "@/util/danmaku/fetch";

const XML = `<i><d p="1,1,25,16777215,0,0,0,0">hi</d></i>`;

describe("danmaku track cache", () => {
	beforeEach(() => {
		vi.unstubAllGlobals();
	});

	afterEach(() => {
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
