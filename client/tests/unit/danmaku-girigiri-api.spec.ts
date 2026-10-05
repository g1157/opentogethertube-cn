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
		await expect(searchGirigiri(" 异国日记 ")).resolves.toEqual(results);
		expect(API.get).toHaveBeenCalledWith("/danmaku/girigiri/search", {
			params: { wd: "异国日记" },
		});
	});

	it("reads as no results when the bridge is unreachable", async () => {
		API.get.mockRejectedValueOnce(new Error("offline"));
		await expect(searchGirigiri("异国日记")).resolves.toEqual([]);
	});

	it("does not call the server for an empty keyword", async () => {
		await expect(searchGirigiri("   ")).resolves.toEqual([]);
		expect(API.get).not.toHaveBeenCalled();
	});

	it("fetches the episode lines of a show", async () => {
		const lines = [{ line: 1, episodes: [{ number: 1, page: "/playGV1-1-1/" }] }];
		API.get.mockResolvedValueOnce({ data: { lines } });
		await expect(fetchGirigiriEpisodes(1)).resolves.toEqual(lines);
		expect(API.get).toHaveBeenCalledWith("/danmaku/girigiri/episodes", {
			params: { id: "1" },
		});
	});

	it("answers with no lines when the bridge fails", async () => {
		API.get.mockRejectedValueOnce(new Error("offline"));
		await expect(fetchGirigiriEpisodes(1)).resolves.toEqual([]);
	});

	it("builds an encoded same-origin track URL", () => {
		expect(girigiriTrackUrl("/playGV26846-1-1/")).toBe(
			"/api/danmaku/girigiri/track?page=%2FplayGV26846-1-1%2F",
		);
	});
});
