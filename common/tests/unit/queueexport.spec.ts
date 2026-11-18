import { describe, it, expect } from "vitest";
import { exportQueue } from "../../queueexport.js";
import type { QueueItem } from "../../models/video.js";
import { ALL_VIDEO_SERVICES } from "../../constants.js";

describe("exportQueue", () => {
	it("should export a queue of 2 videos", () => {
		const queue: QueueItem[] = [
			{
				service: "youtube",
				id: "1",
			},
			{
				service: "vimeo",
				id: "5",
			},
			{
				service: "direct",
				id: "https://example.com/video.mp4",
			},
			{
				service: "hls",
				id: "video.m3u8",
				hls_url: "https://example.com/video.m3u8",
			},
		];

		const result = exportQueue(queue);

		expect(result.split("\n")).toEqual([
			"https://youtu.be/1",
			"https://vimeo.com/5",
			"https://example.com/video.mp4",
			"https://example.com/video.m3u8",
		]);
	});

	it("exports the playable DASH URL in a mixed native queue", () => {
		expect(
			exportQueue([
				{ service: "direct", id: "https://example.com/video.mp4" },
				{
					service: "dash",
					id: "https://example.com/watch",
					dash_url: "https://example.com/manifest.mpd",
				},
				{ service: "dash", id: "https://example.com/next.mpd" },
			]),
		).toBe(
			"https://example.com/video.mp4\nhttps://example.com/manifest.mpd\nhttps://example.com/next.mpd",
		);
	});

	it("exports every supported service in one mixed queue", () => {
		const queue: QueueItem[] = [
			{ service: "youtube", id: "video" },
			{ service: "vimeo", id: "123" },
			{ service: "direct", id: "https://media.example.com/video.mp4" },
			{ service: "hls", id: "https://media.example.com/video.m3u8" },
			{ service: "dash", id: "https://media.example.com/video.mpd" },
			{ service: "tubi", id: "123456" },
			{ service: "reddit", id: "abc123" },
			{ service: "googledrive", id: "file-id" },
			{ service: "peertube", id: "tube.example.com:video-id" },
			{ service: "pluto", id: "series/abc123/def456" },
			{ service: "invidious", id: "inv.example.com:video-id" },
			{ service: "odysee", id: "lbry://@channel#abc/video#def" },
			{ service: "bilibili", id: "BV1xx411c7mD@p3" },
		];
		expect(queue.map(item => item.service)).toEqual(ALL_VIDEO_SERVICES);
		expect(exportQueue(queue).split("\n")).toEqual([
			"https://youtu.be/video",
			"https://vimeo.com/123",
			"https://media.example.com/video.mp4",
			"https://media.example.com/video.m3u8",
			"https://media.example.com/video.mpd",
			"https://tubitv.com/movies/123456",
			"https://www.reddit.com/comments/abc123/",
			"https://drive.google.com/file/d/file-id/view",
			"https://tube.example.com/w/video-id",
			"https://pluto.tv/en/on-demand/series/abc123/episode/def456",
			"https://inv.example.com/watch?v=video-id",
			"https://odysee.com/@channel:abc/video:def",
			"https://www.bilibili.com/video/BV1xx411c7mD/?p=3",
		]);
	});
});
