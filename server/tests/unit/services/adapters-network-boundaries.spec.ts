import axios from "axios";
import dns from "node:dns/promises";
import type { LookupAddress } from "node:dns";
import URL from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import PeertubeAdapter from "../../../services/peertube.js";
import InvidiousAdapter from "../../../services/invidious.js";
import RedditAdapter from "../../../services/reddit.js";
import HlsVideoAdapter from "../../../services/hls.js";
import { InvalidVideoIdException } from "../../../exceptions.js";

const mediaDns: { lookup(host: string, options: { all: true }): Promise<LookupAddress[]> } = dns;
const VIDEO = {
	uuid: "video",
	shortUUID: "video",
	name: "video",
	title: "video",
	description: "",
	duration: 10,
	thumbnailPath: "/thumbnail.jpg",
	streamingPlaylists: [{ id: 1, playlistUrl: "https://cdn.example/playlist.m3u8" }],
	files: [],
};
const MEDIA = "#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6,\nsegment.ts\n#EXT-X-ENDLIST\n";

describe("metadata adapter network boundaries", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllEnvs();
	});
	beforeEach(() => {
		vi.spyOn(mediaDns, "lookup").mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
	});

	describe("PeerTube", () => {
		it.each([
			"unlisted.example:video",
			"approved.example@unlisted.example:video",
		])("rejects a service/id admission outside the instance policy: %s", async id => {
			const adapter = new PeertubeAdapter();
			adapter.allowedHosts = ["approved.example"];
			const get = vi.spyOn(adapter.api, "get").mockResolvedValue({ data: VIDEO });
			await expect(adapter.fetchVideoInfo(id)).rejects.toBeInstanceOf(
				InvalidVideoIdException,
			);
			expect(get).not.toHaveBeenCalled();
		});

		it("rejects a private instance before connecting even when configured", async () => {
			vi.stubEnv("NODE_ENV", "production");
			const adapter = new PeertubeAdapter();
			adapter.allowedHosts = ["127.0.0.1"];
			const get = vi.spyOn(adapter.api, "get").mockResolvedValue({ data: VIDEO });
			await expect(adapter.fetchVideoInfo("127.0.0.1:video")).rejects.toThrow();
			expect(get).not.toHaveBeenCalled();
		});

		it("preserves a configured instance port instead of treating it as the video ID", async () => {
			const adapter = new PeertubeAdapter();
			adapter.allowedHosts = ["approved.example:8443"];
			const get = vi.spyOn(adapter.api, "get").mockResolvedValue({ data: VIDEO });
			await adapter.fetchVideoInfo("approved.example:8443:video");
			expect(get).toHaveBeenCalledWith(
				"https://approved.example:8443/api/v1/videos/video",
				expect.objectContaining({
					maxRedirects: 0,
					maxContentLength: 2 * 1024 * 1024,
					timeout: 5000,
				}),
			);
		});
	});

	describe("Invidious", () => {
		it.each([
			"unlisted.example:abc",
			"approved.example@unlisted.example:abc",
			"approved.example:../../secret",
		])("rejects an invalid instance video ID before lookup: %s", async id => {
			const adapter = new InvidiousAdapter();
			adapter.allowedHosts = ["approved.example"];
			vi.spyOn(adapter as any, "parseAsDirect").mockResolvedValue({
				service: "direct",
				id: "video.mp4",
			});
			const get = vi.spyOn(adapter.api, "get").mockResolvedValue({ data: VIDEO });
			await expect(adapter.fetchVideoInfo(id)).rejects.toBeInstanceOf(
				InvalidVideoIdException,
			);
			expect(get).not.toHaveBeenCalled();
		});

		it("refuses a private configured host on both metadata attempts", async () => {
			vi.stubEnv("NODE_ENV", "production");
			const adapter = new InvidiousAdapter();
			adapter.allowedHosts = ["127.0.0.1"];
			vi.spyOn(adapter as any, "parseAsDirect").mockResolvedValue({
				service: "direct",
				id: "video.mp4",
			});
			const get = vi.spyOn(adapter.api, "get").mockResolvedValue({ data: VIDEO });
			await expect(adapter.fetchVideoInfo("127.0.0.1:abc")).rejects.toThrow();
			expect(get).not.toHaveBeenCalled();
		});
	});

	describe("Reddit", () => {
		it.each([
			"https://evilreddit.com/r/videos",
			"https://reddit.com.evil.example/r/videos",
			"ftp://www.reddit.com/r/videos",
		])("rejects a non-Reddit or non-HTTP source: %s", link => {
			expect(new RedditAdapter().canHandleURL(link)).toBe(false);
		});

		it("validates the target inside the fetch method, not only URL admission", async () => {
			const adapter = new RedditAdapter();
			const get = vi.spyOn(adapter.api, "get").mockResolvedValue({ data: [] });
			await expect(
				adapter.fetchRedditUrl("https://evilreddit.com/r/videos.json"),
			).rejects.toThrow();
			expect(get).not.toHaveBeenCalled();
		});

		it("rejects ID path injection before requesting Reddit", async () => {
			const adapter = new RedditAdapter();
			const get = vi.spyOn(adapter.api, "get").mockResolvedValue({ data: [] });
			await expect(adapter.fetchVideoInfo("../about")).rejects.toBeInstanceOf(
				InvalidVideoIdException,
			);
			expect(get).not.toHaveBeenCalled();
		});
	});

	describe("HLS", () => {
		it("rejects an oversized valid media playlist before parsing it", async () => {
			const adapter = new HlsVideoAdapter();
			vi.spyOn(adapter as any, "probeSegmentAccess").mockResolvedValue({});
			vi.spyOn(axios, "get").mockResolvedValue({
				data: MEDIA + "#".repeat(2 * 1024 * 1024),
				headers: {},
			});
			await expect(
				adapter.handleM3u8(URL.parse("https://approved.example/video.m3u8")),
			).rejects.toThrow("size limit");
		});

		it("applies the same byte and deadline budgets to master and selected variant", async () => {
			const adapter = new HlsVideoAdapter();
			vi.spyOn(adapter as any, "probeSegmentAccess").mockResolvedValue({});
			const get = vi.spyOn(axios, "get").mockImplementation(async url => ({
				data: String(url).endsWith("master.m3u8")
					? "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=100000\nvariant.m3u8\n"
					: MEDIA,
				headers: {},
			}));
			await adapter.handleM3u8(URL.parse("https://approved.example/master.m3u8"));
			expect(get).toHaveBeenCalledTimes(2);
			for (const [, options] of get.mock.calls) {
				expect(options).toMatchObject({
					maxContentLength: 2 * 1024 * 1024,
					timeout: 5000,
					maxRedirects: 0,
				});
				expect(options?.signal).toBeInstanceOf(AbortSignal);
			}
		});
	});
});
