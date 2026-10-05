import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import danmaku, { girigiriTrackPath } from "../../../api/danmaku.js";

const app = express();
app.use("/api/danmaku", danmaku);

const fetchMock = vi.fn<[input: string | URL | Request, init?: RequestInit], Promise<Response>>();

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
function playPage(videoUrl: string): Response {
	const encoded = Buffer.from(encodeURIComponent(videoUrl), "utf8").toString("base64");
	const data = JSON.stringify({ flag: "play", url: encoded });
	return new Response(`<html><script>var player_aaaa=${data}</script></html>`, {
		status: 200,
		headers: { "Content-Type": "text/html" },
	});
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
	it("maps the suggest list and serves repeat queries from cache", async () => {
		fetchMock.mockResolvedValue(
			json({ code: 1, list: [{ id: 26846, name: "异国日记", pic: "/upload/vod/x.webp" }] }),
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
		]);
		await request(app)
			.get("/api/danmaku/girigiri/search")
			.query({ wd: "异国日记-cache" })
			.expect(200);
		expect(fetchMock).toHaveBeenCalledTimes(1);
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
});

describe("girigiri episodes", () => {
	it("groups every line and episode the play page lists, sorted", async () => {
		const id = "26846";
		fetchMock.mockResolvedValue(
			new Response(
				`<a href="/playGV${id}-2-2/">2-2</a><a href="/playGV${id}-1-1/">1-1</a>` +
					`<a href="/playGV${id}-1-2/">1-2</a><a href="/playGV99999-1-1/">other</a>`,
				{ status: 200 },
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
					{ number: 1, page: `/playGV${id}-1-1/` },
					{ number: 2, page: `/playGV${id}-1-2/` },
				],
			},
			{ line: 2, episodes: [{ number: 2, page: `/playGV${id}-2-2/` }] },
		]);
	});

	it("rejects a malformed show id", async () => {
		await request(app)
			.get("/api/danmaku/girigiri/episodes")
			.query({ id: "26846; DROP" })
			.expect(400);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("answers 404 when the page lists no episodes", async () => {
		fetchMock.mockResolvedValue(new Response("<html>nothing</html>", { status: 200 }));
		await request(app)
			.get("/api/danmaku/girigiri/episodes")
			.query({ id: "111111" })
			.expect(404);
	});
});

describe("girigiri track", () => {
	it("resolves a play page to its track and serves it from cache", async () => {
		const page = "/playGV26846-9-1/";
		fetchMock
			.mockResolvedValueOnce(
				playPage(
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

	it("only accepts a play-page path", async () => {
		await request(app)
			.get("/api/danmaku/girigiri/track")
			.query({ page: "https://evil.example.com/steal" })
			.expect(400);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("degrades when the resolved track has no comments", async () => {
		const page = "/playGV26846-8-1/";
		fetchMock
			.mockResolvedValueOnce(
				playPage("https://ana.girigirilove.com/zijian/anime/2024/12/1218/SHIROBAKO/01.mp4"),
			)
			.mockResolvedValueOnce(new Response("<i></i>", { status: 200 }));
		await request(app).get("/api/danmaku/girigiri/track").query({ page }).expect(502);
	});

	it("degrades when the play page hides its data or points elsewhere", async () => {
		const page = "/playGV26846-7-1/";
		fetchMock.mockResolvedValueOnce(
			new Response("<html>no player data</html>", { status: 200 }),
		);
		await request(app).get("/api/danmaku/girigiri/track").query({ page }).expect(502);

		fetchMock.mockReset();
		fetchMock.mockResolvedValueOnce(playPage("https://cdn.example.com/anime/01.mp4"));
		await request(app)
			.get("/api/danmaku/girigiri/track")
			.query({ page: "/playGV26846-6-1/" })
			.expect(502);
	});
});
