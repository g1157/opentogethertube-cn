/**
 * Unit tests for HlsVideoAdapter's access probing: a playlist can be wide open while the
 * segments it points at refuse every request a browser on another origin would send.
 */
import axios from "axios";
import URL from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";
import HlsVideoAdapter from "../../../services/hls.js";

vi.mock("axios");
// The SSRF guard resolves DNS; the adapter must not depend on real hosts in tests.
vi.mock("../../../ffprobe.js", () => ({
	assertPublicMediaUrl: vi.fn().mockResolvedValue(undefined),
}));

const PLAYLIST_URL = "https://example.com/master.m3u8";
const SEGMENT_URL = "https://cdn.example.com/seg-1.ts";

const MEDIA_PLAYLIST = [
	"#EXTM3U",
	"#EXT-X-VERSION:3",
	"#EXT-X-TARGETDURATION:7",
	"#EXTINF:6.0,",
	SEGMENT_URL,
	"#EXT-X-ENDLIST",
].join("\n");

interface MockResponse {
	status: number;
	headers: Record<string, string>;
	data: any;
}

function playlistResponse(data: string): MockResponse {
	return {
		status: 200,
		headers: { "access-control-allow-origin": "*" },
		data,
	};
}

function probeResponse(status: number, headers: Record<string, string> = {}): MockResponse {
	return { status, headers, data: { destroy: vi.fn() } };
}

describe("HlsVideoAdapter access probe", () => {
	let mockGet: ReturnType<typeof vi.fn>;
	let adapter: HlsVideoAdapter;

	beforeEach(() => {
		mockGet = axios.get as unknown as ReturnType<typeof vi.fn>;
		mockGet.mockReset();
		adapter = new HlsVideoAdapter();
	});

	it("marks a stream whose segments refuse this app's Referer", async () => {
		mockGet.mockImplementation(async (url: string, config: any) => {
			if (url === PLAYLIST_URL) {
				return playlistResponse(MEDIA_PLAYLIST);
			}
			// The host answers only requests that arrive without a Referer.
			return config?.headers?.Referer ? probeResponse(403) : probeResponse(206);
		});

		const video = await adapter.fetchVideoInfo(PLAYLIST_URL);

		expect(video.mediaAccess).toEqual({ referrerPolicy: "no-referrer" });
		// The probe asked about the segment, not the playlist, and tried the browser's own
		// policy first.
		const probed = mockGet.mock.calls.map(call => call[0]);
		expect(probed).toContain(SEGMENT_URL);
		expect(mockGet.mock.calls[1][1].headers).toMatchObject({
			Referer: "https://localhost/",
		});
	});

	it("leaves an ordinary stream unmarked", async () => {
		mockGet.mockImplementation(async (url: string) => {
			if (url === PLAYLIST_URL) {
				return playlistResponse(MEDIA_PLAYLIST);
			}
			return probeResponse(206, { "access-control-allow-origin": "*" });
		});

		const video = await adapter.fetchVideoInfo(PLAYLIST_URL);

		expect(video.mediaAccess).toBeUndefined();
		expect(video.cors).toBe(true);
	});

	it("keeps the playlist's own duration and header verdict", async () => {
		mockGet.mockImplementation(async (url: string) => {
			if (url === PLAYLIST_URL) {
				return playlistResponse(MEDIA_PLAYLIST);
			}
			return probeResponse(200, { "access-control-allow-origin": "*" });
		});

		const video = await adapter.fetchVideoInfo(PLAYLIST_URL);

		expect(video.length).toBe(6);
		expect(video.mime).toBe("application/x-mpegURL");
		expect(video.hls_url).toBe(PLAYLIST_URL);
	});

	it("still resolves a link when the segment cannot be probed at all", async () => {
		mockGet.mockImplementation(async (url: string) => {
			if (url === PLAYLIST_URL) {
				return playlistResponse(MEDIA_PLAYLIST);
			}
			throw new Error("ETIMEDOUT");
		});

		const video = await adapter.fetchVideoInfo(PLAYLIST_URL);

		expect(video.mediaAccess).toBeUndefined();
		expect(video.length).toBe(6);
	});

	it("accepts the URL shape the adapter claims", () => {
		expect(adapter.canHandleURL(PLAYLIST_URL)).toBe(true);
		expect(URL.parse(PLAYLIST_URL).pathname).toBe("/master.m3u8");
	});
});
