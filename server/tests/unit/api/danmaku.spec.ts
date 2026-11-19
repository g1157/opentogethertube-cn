import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import danmaku, { girigiriTrackPath } from "../../../api/danmaku.js";
import { buildRateLimiter } from "../../../rate-limit.js";

const app = express();
app.use("/api/danmaku", danmaku);

const fetchMock = vi.fn<[input: string | URL | Request, init?: RequestInit], Promise<Response>>();

beforeAll(() => {
	buildRateLimiter();
});

beforeEach(() => {
	fetchMock.mockReset();
	vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
	vi.unstubAllGlobals();
});

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

function xml(body: string): Response {
	return new Response(body, { status: 200, headers: { "Content-Type": "application/xml" } });
}

/** The play page embeds its video URL as base64 over a percent-encoded string. */
function detail(vodPlayUrl: string, vodPlayFrom = "chs"): Response {
	return json({ code: 1, info: { vod_play_from: vodPlayFrom, vod_play_url: vodPlayUrl } });
}

describe("girigiri track paths", () => {
	it("keeps an HLS track next to its episode on the same host", () => {
		expect(
			girigiriTrackPath(
				"https://akua.girigirilove.com/zijian/oldanime/2026/01/cht/JournalWithWitchCHT/01/playlist.m3u8",
			),
		).toBe(
			"https://akua.girigirilove.com/zijian/oldanime/2026/01/cht/JournalWithWitchCHT/01.xml",
		);
	});

	it("mirrors a direct file to the danmu host and reads the CHS sibling for CHT", () => {
		expect(
			girigiriTrackPath(
				"https://ana.girigirilove.com/zijian/anime/2024/12/1218/SHIROBAKO/01.mp4",
			),
		).toBe("https://danmu.girigirilove.com/zijian/anime/2024/12/1218/SHIROBAKO/01.xml");
		expect(
			girigiriTrackPath(
				"https://ana.girigirilove.com/zijian/anime/2024/12/1218/NukitashitheAnimationCHT/01.mp4",
			),
		).toBe(
			"https://danmu.girigirilove.com/zijian/anime/2024/12/1218/NukitashitheAnimationCHS/01.xml",
		);
	});

	it("refuses hosts and paths outside the girigiri layout", () => {
		expect(girigiriTrackPath("https://example.com/anime/01.mp4")).toBeNull();
		expect(girigiriTrackPath("not a url")).toBeNull();
		expect(girigiriTrackPath("https://ana.girigirilove.com/zijian/anime/")).toBeNull();
	});
});

describe("girigiri search", () => {
	it("maps the API rows and serves repeat queries from cache", async () => {
		fetchMock.mockResolvedValue(
			json({
				code: 1,
				info: {
					rows: [
						{ vod_id: 26846, vod_name: "异国日记", vod_pic: "/upload/vod/x.webp" },
						{ vod_id: 7, vod_name: "no poster", vod_pic: "" },
					],
				},
			}),
		);
		const first = await request(app)
			.get("/api/danmaku/girigiri/search")
			.query({ wd: "异国日记-cache" })
			.expect(200);
		expect(first.body.results).toEqual([
			{
				id: 26846,
				name: "异国日记",
				poster: "https://ani.girigirilove.com/upload/vod/x.webp",
			},
			{ id: 7, name: "no poster", poster: "" },
		]);
		await request(app)
			.get("/api/danmaku/girigiri/search")
			.query({ wd: "异国日记-cache" })
			.expect(200);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("asks the PHP API by name instead of the retired suggest endpoint", async () => {
		fetchMock.mockResolvedValue(json({ code: 1, info: { rows: [] } }));
		await request(app)
			.get("/api/danmaku/girigiri/search")
			.query({ wd: "endpoint-review" })
			.expect(200);
		const url = new URL(String(fetchMock.mock.calls[0][0]));
		expect(url.origin).toBe("https://m3u8.girigirilove.com");
		expect(url.pathname).toBe("/api.php/Vod/get_list");
		expect(url.searchParams.get("vod_name")).toBe("endpoint-review");
		expect(url.searchParams.get("format")).toBe("json");
	});

	it("rejects an empty keyword and still answers", async () => {
		const res = await request(app).get("/api/danmaku/girigiri/search").query({ wd: "  " });
		expect(res.status).toBe(400);
		expect(res.body.results).toEqual([]);
	});

	it("degrades to an empty list when the upstream fails", async () => {
		fetchMock.mockResolvedValue(json({}, 500));
		const res = await request(app)
			.get("/api/danmaku/girigiri/search")
			.query({ wd: "upstream-down" })
			.expect(502);
		expect(res.body.results).toEqual([]);
	});

	it("remembers a failed upstream briefly instead of replaying it", async () => {
		fetchMock.mockResolvedValue(json({}, 500));
		await request(app)
			.get("/api/danmaku/girigiri/search")
			.query({ wd: "negative-search" })
			.expect(502);
		await request(app)
			.get("/api/danmaku/girigiri/search")
			.query({ wd: "negative-search" })
			.expect(502);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});
});

describe("girigiri episodes", () => {
	it("groups every source line and episode the detail answer carries, sorted", async () => {
		const id = "26846";
		fetchMock.mockResolvedValue(
			detail(
				"01$https://ana.girigirilove.com/a/01.mp4#02$https://ana.girigirilove.com/a/02.mp4" +
					"$$$1080P$https://ana.girigirilove.com/b/01.mp4",
				"chs$$$DB",
			),
		);
		const res = await request(app)
			.get("/api/danmaku/girigiri/episodes")
			.query({ id })
			.expect(200);
		expect(res.body.lines).toEqual([
			{
				line: 1,
				episodes: [
					{
						number: 1,
						url: "https://ana.girigirilove.com/a/01.mp4",
						page: `/playGV${id}-1-1/`,
					},
					{
						number: 2,
						url: "https://ana.girigirilove.com/a/02.mp4",
						page: `/playGV${id}-1-2/`,
					},
				],
			},
			{
				line: 2,
				episodes: [
					{
						number: 1,
						url: "https://ana.girigirilove.com/b/01.mp4",
						page: `/playGV${id}-2-1/`,
					},
				],
			},
		]);
	});

	it("keeps line numbers aligned with the sources that actually have episodes", async () => {
		const id = "31337";
		fetchMock.mockResolvedValue(detail("$$$01$https://ana.girigirilove.com/c/01.mp4"));
		const res = await request(app)
			.get("/api/danmaku/girigiri/episodes")
			.query({ id })
			.expect(200);
		// The empty first group still consumes line 1 upstream, so the page binding matches
		// what the site itself would generate for this episode.
		expect(res.body.lines).toEqual([
			{
				line: 2,
				episodes: [
					{
						number: 1,
						url: "https://ana.girigirilove.com/c/01.mp4",
						page: `/playGV${id}-2-1/`,
					},
				],
			},
		]);
	});

	it("rejects a malformed show id", async () => {
		await request(app)
			.get("/api/danmaku/girigiri/episodes")
			.query({ id: "26846; DROP" })
			.expect(400);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("answers 404 when the API lists no episodes", async () => {
		fetchMock.mockResolvedValue(detail(""));
		await request(app)
			.get("/api/danmaku/girigiri/episodes")
			.query({ id: "111111" })
			.expect(404);
	});

	it("remembers an empty episode list briefly instead of replaying it", async () => {
		fetchMock.mockResolvedValue(detail(""));
		await request(app)
			.get("/api/danmaku/girigiri/episodes")
			.query({ id: "222222" })
			.expect(404);
		await request(app)
			.get("/api/danmaku/girigiri/episodes")
			.query({ id: "222222" })
			.expect(404);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});
});

/** Every line up to `line` carries one episode, so a page for any of them resolves. */
function detailWithLines(line: number, videoUrl: (line: number) => string): Response {
	const groups = Array.from({ length: line }, (_, index) => `01$${videoUrl(index + 1)}`);
	return detail(groups.join("$$$"), new Array(line).fill("chs").join("$$$"));
}

describe("girigiri track", () => {
	it("resolves a stored page to its track and serves it from cache", async () => {
		const page = "/playGV26846-9-1/";
		fetchMock
			.mockResolvedValueOnce(
				detailWithLines(
					9,
					() =>
						"https://akua.girigirilove.com/zijian/oldanime/2026/01/cht/JournalWithWitchCHT/01/playlist.m3u8",
				),
			)
			.mockResolvedValueOnce(xml('<i><d p="1,1,25,16777215,0,0,0,0">hi</d></i>'));
		const first = await request(app)
			.get("/api/danmaku/girigiri/track")
			.query({ page })
			.expect(200);
		expect(first.headers["content-type"]).toContain("xml");
		expect(first.text).toContain("<d ");
		expect(fetchMock).toHaveBeenCalledTimes(2);

		await request(app).get("/api/danmaku/girigiri/track").query({ page }).expect(200);
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it("asks the API for the show the page names", async () => {
		fetchMock
			.mockResolvedValueOnce(
				detailWithLines(1, () => "https://ana.girigirilove.com/zijian/anime/01.mp4"),
			)
			.mockResolvedValueOnce(xml('<i><d p="1,1">hi</d></i>'));
		await request(app)
			.get("/api/danmaku/girigiri/track")
			.query({ page: "/playGV771234-1-1/" })
			.expect(200);
		const url = new URL(String(fetchMock.mock.calls[0][0]));
		expect(url.pathname).toBe("/api.php/Vod/get_detail");
		expect(url.searchParams.get("vod_id")).toBe("771234");
	});

	it("only accepts a play-page path", async () => {
		await request(app)
			.get("/api/danmaku/girigiri/track")
			.query({ page: "https://evil.example.com/steal" })
			.expect(400);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("degrades when the resolved track has no comments", async () => {
		const page = "/playGV26846-1-1/";
		fetchMock
			.mockResolvedValueOnce(
				detailWithLines(
					1,
					() => "https://ana.girigirilove.com/zijian/anime/2024/12/1218/SHIROBAKO/01.mp4",
				),
			)
			.mockResolvedValueOnce(new Response("<i></i>", { status: 200 }));
		await request(app).get("/api/danmaku/girigiri/track").query({ page }).expect(502);
	});

	it("degrades when the page names a line or episode the show does not have", async () => {
		fetchMock.mockResolvedValueOnce(
			detailWithLines(1, () => "https://ana.girigirilove.com/zijian/anime/01.mp4"),
		);
		await request(app)
			.get("/api/danmaku/girigiri/track")
			.query({ page: "/playGV26846-2-1/" })
			.expect(502);
	});

	it("degrades when the episode points outside the girigiri layout", async () => {
		fetchMock.mockResolvedValueOnce(
			detailWithLines(1, () => "https://cdn.example.com/anime/01.mp4"),
		);
		await request(app)
			.get("/api/danmaku/girigiri/track")
			.query({ page: "/playGV26846-1-1/" })
			.expect(502);
	});

	it("remembers an unresolvable track briefly instead of replaying it", async () => {
		// A distinct id: the track cache outlives a single test and would serve another
		// case's entry for the same page.
		const page = "/playGV880055-1-1/";
		fetchMock.mockResolvedValueOnce(json({ code: 0, msg: "缺失参数", info: "" }));
		await request(app).get("/api/danmaku/girigiri/track").query({ page }).expect(502);
		await request(app).get("/api/danmaku/girigiri/track").query({ page }).expect(502);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});
});

describe("girigiri response byte limits", () => {
	it("rejects oversized search metadata before decoding JSON", async () => {
		fetchMock.mockResolvedValueOnce(
			new Response(JSON.stringify({ code: 1, info: { rows: [] } }), {
				headers: { "Content-Length": String(1024 * 1024 + 1) },
			}),
		);
		const response = await request(app)
			.get("/api/danmaku/girigiri/search")
			.query({ wd: "oversized-metadata-review" })
			.expect(502);
		expect(response.body.results).toEqual([]);
	});

	it("rejects an oversized XML track instead of retaining it in the cache", async () => {
		fetchMock
			.mockResolvedValueOnce(
				detailWithLines(1, () => "https://ani.girigirilove.com/bounded/01.mp4"),
			)
			.mockResolvedValueOnce(
				new Response('<i><d p="1,1">hello</d></i>', {
					headers: { "Content-Length": String(8 * 1024 * 1024 + 1) },
				}),
			);
		const response = await request(app)
			.get("/api/danmaku/girigiri/track")
			.query({ page: "/playGV990001-1-1/" })
			.expect(502);
		expect(response.body.error).toBe("the track is unavailable");
	});
});

describe("girigiri resource admission and cache budgets", () => {
	it("bounds concurrent upstream downloads and releases capacity on completion", async () => {
		const finish: (() => void)[] = [];
		let allStarted!: () => void;
		const started = new Promise<void>(resolve => {
			allStarted = resolve;
		});
		fetchMock.mockImplementation(async input => {
			if (String(input).includes("capacity-blocked")) {
				await new Promise<void>(resolve => {
					finish.push(resolve);
					if (finish.length === 4) {
						allStarted();
					}
				});
			}
			return json({ code: 1, info: { rows: [{ vod_id: 123, vod_name: "available" }] } });
		});
		const pending = Array.from(
			{ length: 4 },
			async (_, index) =>
				await request(app)
					.get("/api/danmaku/girigiri/search")
					.query({ wd: "capacity-blocked-" + index })
					.expect(200),
		);
		try {
			await started;
			await request(app)
				.get("/api/danmaku/girigiri/search")
				.query({ wd: "capacity-rejected" })
				.expect(502);
			expect(fetchMock).toHaveBeenCalledTimes(4);
		} finally {
			for (const resolve of finish) {
				resolve();
			}
			await Promise.all(pending);
		}
		await request(app)
			.get("/api/danmaku/girigiri/search")
			.query({ wd: "capacity-recovered" })
			.expect(200);
		expect(fetchMock).toHaveBeenCalledTimes(5);
	});

	it("evicts XML by total accounted bytes before the entry limit", async () => {
		const body = "<i><!--" + "x".repeat(6 * 1024 * 1024) + '--><d p="1,1">hello</d></i>';
		const episode = "https://ani.girigirilove.com/cache-budget/01.mp4";
		fetchMock.mockImplementation(async input =>
			String(input).includes("/Vod/get_detail")
				? detail(["01", "02", "03"].map(n => `${n}$${episode}`).join("#"))
				: xml(body),
		);
		for (let index = 0; index < 3; index++) {
			await request(app)
				.get("/api/danmaku/girigiri/track")
				.query({ page: "/playGV990101-1-" + (index + 1) + "/" })
				.expect(200);
		}
		await request(app)
			.get("/api/danmaku/girigiri/track")
			.query({ page: "/playGV990101-1-1/" })
			.expect(200);
		expect(fetchMock).toHaveBeenCalledTimes(8);
	}, 15000);
});
