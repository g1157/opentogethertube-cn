import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { API } = vi.hoisted(() => ({ API: { get: vi.fn() } }));
vi.mock("@/common-http", () => ({ API, API_BASE_URL: "/api" }));

import {
	fetchGirigiriEpisodes,
	girigiriTrackUrl,
	searchGirigiri,
} from "@/util/danmaku/girigiri-api";

describe("girigiri bridge client", () => {
	beforeEach(() => {
		vi.resetAllMocks();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("searches through the same-origin bridge with a trimmed keyword", async () => {
		const results = [
			{ id: 26846, name: "异国日记", poster: "https://ani.girigirilove.com/x.webp" },
		];
		API.get.mockResolvedValueOnce({ data: { results } });
		await expect(searchGirigiri(" 异国日记 ")).resolves.toEqual({
			results,
			status: "ok",
		});
		expect(API.get).toHaveBeenCalledWith("/danmaku/girigiri/search", {
			params: { wd: "异国日记" },
		});
	});

	it("distinguishes an unreachable bridge from an empty result", async () => {
		API.get.mockRejectedValueOnce(new Error("offline"));
		await expect(searchGirigiri("异国日记")).resolves.toEqual({
			results: [],
			status: "unavailable",
		});

		API.get.mockResolvedValueOnce({ data: { results: [] } });
		await expect(searchGirigiri("确无此番")).resolves.toEqual({
			results: [],
			status: "ok",
		});
	});

	it("does not call the server for an empty keyword", async () => {
		await expect(searchGirigiri("   ")).resolves.toEqual({ results: [], status: "ok" });
		expect(API.get).not.toHaveBeenCalled();
	});

	it("fetches the episode lines of a show", async () => {
		const lines = [{ line: 1, episodes: [{ number: 1, page: "/playGV1-1-1/" }] }];
		API.get.mockResolvedValueOnce({ data: { lines } });
		await expect(fetchGirigiriEpisodes(1)).resolves.toEqual({ lines, status: "ok" });
		expect(API.get).toHaveBeenCalledWith("/danmaku/girigiri/episodes", {
			params: { id: "1" },
		});
	});

	it("reports an unreachable bridge instead of claiming the show has no episodes", async () => {
		API.get.mockRejectedValueOnce(new Error("offline"));
		await expect(fetchGirigiriEpisodes(1)).resolves.toEqual({
			lines: [],
			status: "unavailable",
		});
	});

	it("builds an encoded same-origin track URL", () => {
		expect(girigiriTrackUrl("/playGV26846-1-1/")).toBe(
			"/api/danmaku/girigiri/track?page=%2FplayGV26846-1-1%2F",
		);
	});
});
