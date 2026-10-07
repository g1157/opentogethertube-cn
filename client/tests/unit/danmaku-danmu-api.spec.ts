import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	autoMatch,
	clearBindings,
	danmuApiProvider,
	fetchEpisodes,
	forgetBinding,
	getBinding,
	looksLikeRemoteCandidate,
	rememberBinding,
	roomSourceBinding,
	searchAnime,
	setDanmakuApiBase,
	synthesizeMatchQuery,
} from "@/util/danmaku/danmu-api";

const BASE = "https://ott.example/danmu-api/secret";

/**
 * Node exposes its own `localStorage` global (undefined without a flag) and it shadows
 * jsdom's, so the spec installs a small store to exercise the persistence path.
 */
function createStorageStub() {
	const map = new Map<string, string>();
	return {
		getItem: (key: string) => map.get(key) ?? null,
		setItem: (key: string, value: string) => {
			map.set(key, String(value));
		},
		removeItem: (key: string) => {
			map.delete(key);
		},
	};
}

describe("danmu-api match query synthesis", () => {
	it("turns girigiri direct files into SxxExx queries", () => {
		expect(
			synthesizeMatchQuery(
				"https://ana.girigirilove.com/zijian/anime/2024/12/1218/SHIROBAKO/06.mp4",
			),
		).toBe("SHIROBAKO S01E06");
	});

	it("reads the episode from the folder a playlist sits in", () => {
		expect(
			synthesizeMatchQuery(
				"https://akua.girigirilove.com/zijian/oldanime/2026/04/cht/ReZeroS4CHT/01/playlist.m3u8",
			),
		).toBe("ReZeroS4CHT S01E01");
	});

	it("keeps a movie title alone when the pack has no episode", () => {
		expect(
			synthesizeMatchQuery(
				"https://akua.girigirilove.com/zijian/anime/2025/01/05/PerfectBlue/playlist.m3u8",
			),
		).toBe("PerfectBlue");
	});

	it("reads release-file names, including the season marker", () => {
		expect(synthesizeMatchQuery("https://host/media/Show.S02E05.1080p.mkv")).toBe(
			"Show S02E05",
		);
	});

	it("falls back to the file name when every folder is generic", () => {
		expect(synthesizeMatchQuery("https://host/media/[Sakura] SHIROBAKO 06 [1080p].mp4")).toBe(
			"SHIROBAKO S01E06",
		);
	});

	it("understands the 第N话 form", () => {
		expect(synthesizeMatchQuery("https://host/白箱/白箱 第6话.mp4")).toBe("白箱 S01E06");
	});

	it("returns null for inputs that are not media URLs", () => {
		expect(synthesizeMatchQuery("not a url")).toBeNull();
		expect(synthesizeMatchQuery("https://host/")).toBeNull();
	});

	it("knows which URLs are worth asking about", () => {
		expect(looksLikeRemoteCandidate("https://host/a/b.mp4")).toBe(true);
		expect(looksLikeRemoteCandidate("file:///a/b.mp4")).toBe(false);
		expect(looksLikeRemoteCandidate("not a url")).toBe(false);
	});
});

describe("danmu-api bindings", () => {
	let storage: ReturnType<typeof createStorageStub>;

	beforeEach(() => {
		storage = createStorageStub();
		vi.stubGlobal("localStorage", storage);
		clearBindings();
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("stores, reads and drops a binding and survives a storage round trip", () => {
		expect(getBinding("https://host/a.mp4")).toBeNull();
		rememberBinding("https://host/a.mp4", {
			provider: "danmu-api",
			episodeId: 10007,
			label: "白箱 · 第6话",
			offset: 0,
		});
		expect(getBinding("https://host/a.mp4")).toEqual({
			provider: "danmu-api",
			episodeId: 10007,
			label: "白箱 · 第6话",
			offset: 0,
		});
		expect(storage.getItem("danmaku-bindings")).toContain("10007");
		forgetBinding("https://host/a.mp4");
		expect(getBinding("https://host/a.mp4")).toBeNull();
	});

	it("reads bindings stored before the girigiri provider as danmu-api entries", async () => {
		vi.resetModules();
		storage.setItem(
			"danmaku-bindings",
			JSON.stringify({
				"https://host/old.mp4": { episodeId: 7, label: "旧条目" },
				"https://host/new.mp4": {
					provider: "girigiri",
					page: "/playGV1-1-1/",
					label: "异国日记 · 第1话",
					offset: 1.5,
				},
				"https://host/broken.mp4": 42,
			}),
		);
		const fresh = await import("@/util/danmaku/danmu-api");
		expect(fresh.getBinding("https://host/old.mp4")).toEqual({
			provider: "danmu-api",
			episodeId: 7,
			label: "旧条目",
			offset: 0,
		});
		expect(fresh.getBinding("https://host/new.mp4")).toEqual({
			provider: "girigiri",
			page: "/playGV1-1-1/",
			label: "异国日记 · 第1话",
			offset: 1.5,
		});
		expect(fresh.getBinding("https://host/broken.mp4")).toBeNull();
	});

	it("keeps a girigiri binding located by its track URL", async () => {
		vi.resetModules();
		storage.setItem(
			"danmaku-bindings",
			JSON.stringify({
				"https://host/url.mp4": {
					provider: "girigiri",
					url: "https://danmu.example/other/01.xml",
					label: "girigiri · /other/01.xml",
					offset: -1.5,
				},
				"https://host/empty.mp4": {
					provider: "girigiri",
					label: "没有定位",
				},
			}),
		);
		const fresh = await import("@/util/danmaku/danmu-api");
		expect(fresh.getBinding("https://host/url.mp4")).toEqual({
			provider: "girigiri",
			url: "https://danmu.example/other/01.xml",
			label: "girigiri · /other/01.xml",
			offset: -1.5,
		});
		// A girigiri entry with neither a page nor a URL cannot locate a track.
		expect(fresh.getBinding("https://host/empty.mp4")).toBeNull();
	});

	it("resolves the track URL only when a base and a binding are present", () => {
		const url = "https://host/media/ep.mp4";
		setDanmakuApiBase("");
		expect(danmuApiProvider.resolve(url)).toBeNull();
		rememberBinding(url, { provider: "danmu-api", episodeId: 42, label: "x", offset: 0 });
		expect(danmuApiProvider.resolve(url)).toBeNull();
		setDanmakuApiBase(BASE);
		expect(danmuApiProvider.resolve(url)).toBe(`${BASE}/api/v2/comment/42?format=xml`);
		expect(danmuApiProvider.resolve("https://host/other.mp4")).toBeNull();
	});
});

describe("danmu-api automatic matching", () => {
	beforeEach(() => {
		clearBindings();
		setDanmakuApiBase(BASE);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		setDanmakuApiBase("");
	});

	it("remembers the top match and sends the synthesized query", async () => {
		const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
			expect(JSON.parse(String(init?.body))).toEqual({ fileName: "SHIROBAKO S01E06" });
			return new Response(
				JSON.stringify({
					isMatched: true,
					matches: [
						{
							episodeId: 10007,
							animeTitle: "白箱(2014)【TV动画】",
							episodeTitle: "【animeko】 第6话",
						},
					],
				}),
				{ status: 200 },
			);
		});
		vi.stubGlobal("fetch", fetchMock);

		const binding = await autoMatch(
			"https://ana.girigirilove.com/zijian/anime/2024/12/1218/SHIROBAKO/06.mp4",
		);
		expect(binding).toEqual({
			provider: "danmu-api",
			episodeId: 10007,
			label: "白箱(2014)【TV动画】 · 【animeko】 第6话",
			offset: 0,
			// The marker that keeps this automatic entry from outranking a room's pick.
			auto: true,
		});
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("caches a miss so a hopeless video is not asked twice", async () => {
		const fetchMock = vi.fn(
			async () =>
				new Response(JSON.stringify({ isMatched: false, matches: [] }), { status: 200 }),
		);
		vi.stubGlobal("fetch", fetchMock);
		const url = "https://host/media/Unknown.Show.S01E03.mkv";

		expect(await autoMatch(url)).toBeNull();
		expect(await autoMatch(url)).toBeNull();
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("stays silent when the service is unreachable", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => Promise.reject(new Error("offline"))),
		);
		expect(await autoMatch("https://host/media/Anything.S01E01.mp4")).toBeNull();
	});

	it("drops cached misses when the base changes", async () => {
		// While the base URL is being typed, early attempts fail and are cached; switching
		// servers must give the finished address a fresh chance.
		const fetchMock = vi.fn(
			async () =>
				new Response(JSON.stringify({ isMatched: false, matches: [] }), { status: 200 }),
		);
		vi.stubGlobal("fetch", fetchMock);
		const url = "https://host/media/Some.Show.S01E03.mkv";

		expect(await autoMatch(url)).toBeNull();
		expect(fetchMock).toHaveBeenCalledTimes(1);
		setDanmakuApiBase("https://other.example/danmu-api/token");
		expect(await autoMatch(url)).toBeNull();
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});
});

describe("danmu-api manual search", () => {
	beforeEach(() => {
		setDanmakuApiBase(BASE);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		setDanmakuApiBase("");
	});

	it("reads the anime list out of the search response", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string) => {
				expect(String(url)).toContain("/api/v2/search/anime?keyword=%E7%99%BD%E7%AE%B1");
				return new Response(
					JSON.stringify({
						success: true,
						animes: [{ animeId: 110467, animeTitle: "白箱(2014)", source: "animeko" }],
					}),
					{ status: 200 },
				);
			}),
		);
		expect(await searchAnime(" 白箱 ")).toEqual([
			{ animeId: 110467, title: "白箱(2014)", source: "animeko" },
		]);
	});

	it("reads the episode list out of the bangumi response", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(
				async () =>
					new Response(
						JSON.stringify({
							bangumi: {
								episodes: [
									{ episodeId: 10007, episodeTitle: "第6话" },
									{ episodeId: 10008, episodeTitle: "第7话" },
								],
							},
						}),
						{ status: 200 },
					),
			),
		);
		expect(await fetchEpisodes(110467)).toEqual([
			{ episodeId: 10007, title: "第6话" },
			{ episodeId: 10008, title: "第7话" },
		]);
	});

	it("returns empty lists without a base or on failure", async () => {
		setDanmakuApiBase("");
		expect(await searchAnime("白箱")).toEqual([]);
		expect(await fetchEpisodes(1)).toEqual([]);
		setDanmakuApiBase(BASE);
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => Promise.reject(new Error("offline"))),
		);
		expect(await searchAnime("白箱")).toEqual([]);
		expect(await fetchEpisodes(1)).toEqual([]);
	});
});

describe("room source as a binding", () => {
	const url = "https://host/a.mp4";
	const source = {
		videoUrl: url,
		provider: "girigiri" as const,
		page: "/playGV1-1-1/",
		label: "异国日记 · 线路1·第1话",
		offset: 1.5,
	};

	it("converts the room's source for the video that is playing", () => {
		expect(roomSourceBinding(url, source)).toEqual({
			provider: "girigiri",
			page: "/playGV1-1-1/",
			label: "异国日记 · 线路1·第1话",
			offset: 1.5,
		});
	});

	it("ignores a source that belongs to another video or no room at all", () => {
		expect(roomSourceBinding("https://host/b.mp4", source)).toBeNull();
		expect(roomSourceBinding(url, null)).toBeNull();
	});
});
