/**
 * Unit tests for the Bilibili adapter: URL recognition, id extraction and metadata parsing.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import BilibiliAdapter from "../../../services/bilibili.js";
import { InvalidVideoIdException, MissingMetadataException } from "../../../exceptions.js";
import axios from "axios";

vi.mock("axios");

const VIEW_RESPONSE = {
	code: 0,
	data: {
		bvid: "BV1GJ411x7h7",
		aid: 75890161,
		title: "【官方 MV】Never Gonna Give You Up",
		pic: "https://i0.hdslb.com/bfs/archive/example.jpg",
		duration: 213,
		owner: { name: "某UP主" },
		pages: [{ cid: 111, page: 1, part: "正片", duration: 213 }],
	},
};

describe("BilibiliAdapter", () => {
	let adapter: BilibiliAdapter;
	let mockAxiosGet: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		// The adapter talks through its own axios instance (custom UA/referer).
		mockAxiosGet = vi.fn();
		(axios.create as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
			get: mockAxiosGet,
		});
		adapter = new BilibiliAdapter();
	});

	describe("canHandleURL", () => {
		it("accepts canonical video pages", () => {
			expect(adapter.canHandleURL("https://www.bilibili.com/video/BV1GJ411x7h7")).toBe(true);
			expect(adapter.canHandleURL("https://www.bilibili.com/video/av75890161?p=2")).toBe(true);
		});

		it("accepts b23.tv short links", () => {
			expect(adapter.canHandleURL("https://b23.tv/abc123")).toBe(true);
		});

		it("rejects other sites and non-video paths", () => {
			expect(adapter.canHandleURL("https://www.youtube.com/watch?v=abc")).toBe(false);
			expect(adapter.canHandleURL("https://www.bilibili.com/read/cv12345")).toBe(false);
			expect(adapter.canHandleURL("not a url")).toBe(false);
		});
	});

	describe("getVideoId", () => {
		it("extracts the BV id", () => {
			expect(adapter.getVideoId("https://www.bilibili.com/video/BV1GJ411x7h7")).toBe(
				"BV1GJ411x7h7",
			);
		});

		it("extracts the av number without the prefix", () => {
			expect(adapter.getVideoId("https://www.bilibili.com/video/av75890161")).toBe("75890161");
		});

		it("encodes the part number into the id", () => {
			expect(adapter.getVideoId("https://www.bilibili.com/video/BV1GJ411x7h7?p=3")).toBe(
				"BV1GJ411x7h7@p3",
			);
		});

		it("throws for paths it cannot parse", () => {
			expect(() => adapter.getVideoId("https://www.bilibili.com/read/cv12345")).toThrow(
				InvalidVideoIdException,
			);
		});
	});

	describe("fetchVideoInfo", () => {
		it("fetches and maps metadata for the first part", async () => {
			mockAxiosGet.mockResolvedValue({ data: VIEW_RESPONSE });
			const video = await adapter.fetchVideoInfo("BV1GJ411x7h7");

			expect(mockAxiosGet).toHaveBeenCalledWith(
				"https://api.bilibili.com/x/web-interface/view",
				expect.objectContaining({ params: { bvid: "BV1GJ411x7h7" } }),
			);
			expect(video.service).toBe("bilibili");
			expect(video.id).toBe("BV1GJ411x7h7");
			expect(video.title).toBe("【官方 MV】Never Gonna Give You Up");
			expect(video.length).toBe(213);
			expect(video.thumbnail).toContain("hdslb.com");
			expect(video.description).toContain("某UP主");
		});

		it("maps a later part's title and duration", async () => {
			mockAxiosGet.mockResolvedValue({
				data: {
					code: 0,
					data: {
						...VIEW_RESPONSE.data,
						duration: 400,
						pages: [
							{ cid: 111, page: 1, part: "第一集", duration: 213 },
							{ cid: 222, page: 2, part: "第二集", duration: 187 },
						],
					},
				},
			});
			const video = await adapter.fetchVideoInfo("BV1GJ411x7h7@p2");
			expect(video.id).toBe("BV1GJ411x7h7@p2");
			expect(video.title).toContain("P2 第二集");
			expect(video.length).toBe(187);
		});

		it("throws MissingMetadataException when the API reports an error", async () => {
			mockAxiosGet.mockResolvedValue({ data: { code: -404, message: "啥都木有" } });
			await expect(adapter.fetchVideoInfo("BV1missing")).rejects.toThrow(
				MissingMetadataException,
			);
		});
	});
});
