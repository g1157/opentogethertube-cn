import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	EmbyError,
	analyzeEmbyCompatibility,
	authenticateEmby,
	embyDeviceId,
	embyItemImageUrl,
	embyItemToVideoAdd,
	extractEmbySubtitles,
	formatEmbyEpisodeCode,
	formatEmbyRuntime,
	getEmbyPlaybackInfo,
	isCurrentBrowserLikelyNonChromium,
	normalizeEmbyServer,
	pickDefaultEmbySubtitle,
	pickPlayableEmbySource,
	summarizeEmbyPlaybackMedia,
	type EmbyItem,
	type EmbyPlaybackInfo,
} from "@/util/emby";

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

const DEVICE_ID_PATTERN = /^ott-/;

function memoryStorage(): Storage {
	const values = new Map<string, string>();
	return {
		get length() {
			return values.size;
		},
		clear: () => values.clear(),
		getItem: (key: string) => values.get(key) ?? null,
		key: (index: number) => [...values.keys()][index] ?? null,
		removeItem: (key: string) => {
			values.delete(key);
		},
		setItem: (key: string, value: string) => {
			values.set(key, String(value));
		},
	};
}

const ITEM: EmbyItem = {
	Id: "item-1",
	Name: "The Film",
	Type: "Movie",
	ProductionYear: 2024,
	RunTimeTicks: 72_000_000_000,
	ImageTags: { Primary: "tag-1" },
};

describe("Emby client", () => {
	beforeEach(() => {
		// Node 26's jsdom does not expose a working localStorage without a file URL.
		vi.stubGlobal("localStorage", memoryStorage());
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("normalizes server addresses and rejects unsafe protocols", () => {
		expect(normalizeEmbyServer("emby.example.com")).toBe("https://emby.example.com");
		expect(normalizeEmbyServer("http://192.168.1.20:8096/")).toBe("http://192.168.1.20:8096");
		expect(normalizeEmbyServer("https://example.com/emby///?x=1")).toBe(
			"https://example.com/emby",
		);
		for (const value of ["", "ftp://example.com", "https://user:pass@example.com"]) {
			expect(() => normalizeEmbyServer(value)).toThrow(EmbyError);
		}
	});

	it("keeps one device id per browser", () => {
		const first = embyDeviceId();
		expect(first).toMatch(DEVICE_ID_PATTERN);
		expect(embyDeviceId()).toBe(first);
		expect(localStorage.getItem("ott-emby-device-id")).toBe(first);
	});

	it("authenticates with the device header and returns the token", async () => {
		const fetchImpl = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
			jsonResponse({
				AccessToken: "token-123",
				ServerId: "server-1",
				User: { Id: "user-1", Name: "Alice" },
			}),
		);
		const auth = await authenticateEmby("https://emby.example.com", "alice", "", "device-1", {
			fetchImpl,
		});
		expect(auth).toEqual({
			token: "token-123",
			userId: "user-1",
			userName: "Alice",
			serverId: "server-1",
		});
		const [url, init] = fetchImpl.mock.calls[0];
		expect(url).toBe("https://emby.example.com/Users/AuthenticateByName");
		expect(init?.method).toBe("POST");
		expect((init?.headers as Record<string, string>)["X-Emby-Authorization"]).toContain(
			'DeviceId="device-1"',
		);
		expect(JSON.parse(String(init?.body))).toEqual({ Username: "alice", Pw: "" });
	});

	it("maps a rejected login to an unauthorized error", async () => {
		const fetchImpl = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
			jsonResponse({ Message: "no" }, 401),
		);
		await expect(
			authenticateEmby("https://emby.example.com", "alice", "wrong", "d", { fetchImpl }),
		).rejects.toMatchObject({ kind: "unauthorized", status: 401 });
	});

	it("requests playback info with a browser device profile", async () => {
		const fetchImpl = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
			jsonResponse({ PlaySessionId: "ps", MediaSources: [] }),
		);
		await getEmbyPlaybackInfo("https://emby.example.com", "token", "user-1", "item-1", {
			fetchImpl,
		});
		const [url, init] = fetchImpl.mock.calls[0];
		expect(url).toContain("/Items/item-1/PlaybackInfo");
		expect(url).toContain("EnableDirectPlay=true");
		const body = JSON.parse(String(init?.body));
		expect(body.DeviceProfile.DirectPlayProfiles[0].Container).toContain("mp4");
		expect((init?.headers as Record<string, string>)["X-Emby-Token"]).toBe("token");
	});

	it("prefers a direct MP4 and resolves relative URLs", () => {
		const playback: EmbyPlaybackInfo = {
			MediaSources: [
				{
					Container: "mp4",
					DirectStreamUrl:
						"/videos/1/original.mp4?DeviceId=d&MediaSourceId=m&api_key=token",
				},
			],
		};
		const result = pickPlayableEmbySource("https://example.com/emby", playback, ITEM);
		expect(result.source).toMatchObject({
			service: "direct",
			mime: "video/mp4",
			url: "https://example.com/emby/videos/1/original.mp4?DeviceId=d&MediaSourceId=m&api_key=token",
		});
	});

	it("falls back to an HLS transcode when the original is MKV", () => {
		const playback: EmbyPlaybackInfo = {
			MediaSources: [
				{
					Container: "mkv",
					DirectStreamUrl: "/videos/1/original.mkv?api_key=token",
					TranscodingUrl: "/videos/1/master.m3u8?api_key=token",
					TranscodingSubProtocol: "hls",
				},
			],
		};
		const result = pickPlayableEmbySource("https://example.com", playback, ITEM);
		expect(result.source).toMatchObject({
			service: "hls",
			mime: "application/x-mpegURL",
			// The direct MKV must not win: Emby flags `TranscodingSubProtocol` on the whole
			// MediaSource, so classifying the direct URL with it would send the MKV file to
			// hls.js as if it were a playlist.
			url: "https://example.com/videos/1/master.m3u8?api_key=token",
		});
	});

	it("classifies a direct-only MKV as direct video/x-matroska even when the source declares an HLS subprotocol", () => {
		const playback: EmbyPlaybackInfo = {
			MediaSources: [
				{
					Container: "mkv",
					DirectStreamUrl: "/videos/1/original.mkv?api_key=token",
					TranscodingSubProtocol: "hls",
					MediaStreams: [
						{ Type: "Video", Codec: "hevc" },
						{ Type: "Audio", Codec: "aac", IsDefault: true },
					],
				},
			],
		};
		const result = pickPlayableEmbySource("https://example.com", playback, ITEM);
		// Must NOT be misclassified as HLS (which would feed MKV bytes to hls.js).
		expect(result.source).toMatchObject({
			service: "direct",
			mime: "video/x-matroska",
			container: "mkv",
			limitedCompatibility: true,
			url: "https://example.com/videos/1/original.mkv?api_key=token",
			compatibility: {
				chromiumOnly: true,
				audioStatus: "compatible",
			},
		});
		const summary = summarizeEmbyPlaybackMedia(ITEM, playback, result);
		expect(summary.status).toBe("direct-limited");
	});

	it("synthesizes a static direct MKV URL when Emby omits DirectStreamUrl on a direct-play source", () => {
		const playback: EmbyPlaybackInfo = {
			MediaSources: [
				{
					Id: "ms-1",
					Container: "matroska,webm",
					SupportsDirectPlay: true,
					MediaStreams: [
						{ Type: "Video", Codec: "h264" },
						{ Type: "Audio", Codec: "flac" },
					],
				},
			],
		};
		const result = pickPlayableEmbySource("https://example.com/emby", playback, ITEM, {
			token: "tok-1",
		});
		expect(result.source).toMatchObject({
			service: "direct",
			mime: "video/x-matroska",
			limitedCompatibility: true,
			url: "https://example.com/emby/Videos/item-1/stream.mkv?Static=true&mediaSourceId=ms-1&api_key=tok-1",
		});
	});

	it("recognizes an extensionless HLS transcode URL", () => {
		const playback: EmbyPlaybackInfo = {
			MediaSources: [
				{
					Container: "mkv",
					TranscodingUrl:
						"/videos/1/stream?Static=false&MediaSourceId=m&TranscodingProtocol=hls&api_key=t",
					TranscodingSubProtocol: "hls",
				},
			],
		};
		const result = pickPlayableEmbySource("https://example.com", playback, ITEM);
		expect(result.source).toMatchObject({ service: "hls", mime: "application/x-mpegURL" });
	});

	it("falls back to the declared container for an extensionless direct URL", () => {
		const playback: EmbyPlaybackInfo = {
			MediaSources: [
				{ Container: "mp4", DirectStreamUrl: "/videos/1/stream?Static=true&api_key=t" },
			],
		};
		const result = pickPlayableEmbySource("https://example.com", playback, ITEM);
		expect(result.source).toMatchObject({ service: "direct", mime: "video/mp4" });
	});

	it("reports the container when no browser-playable source exists", () => {
		const playback: EmbyPlaybackInfo = {
			MediaSources: [
				{ Container: "avi", DirectStreamUrl: "/videos/1/original.avi?api_key=t" },
			],
		};
		const result = pickPlayableEmbySource("https://example.com", playback, ITEM);
		expect(result.source).toBeUndefined();
		expect(result.reason).toBe("avi");
		// A direct-only answer means the server refuses to transcode; the UI says so instead
		// of telling the user to switch on a setting they may not control.
		expect(result.directOnly).toBe(true);
	});

	it("analyzes MKV video and audio codec compatibility accurately", () => {
		expect(
			analyzeEmbyCompatibility("mkv", [
				{ Type: "Video", Codec: "hevc" },
				{ Type: "Audio", Codec: "dts", IsDefault: true },
			]),
		).toEqual({
			chromiumOnly: true,
			audioStatus: "incompatible",
			audioCodec: "DTS",
		});

		expect(
			analyzeEmbyCompatibility("mkv", [
				{ Type: "Video", Codec: "vc1" },
				{ Type: "Audio", Codec: "ac3", IsDefault: true },
				{ Type: "Audio", Codec: "aac", IsDefault: false },
			]),
		).toEqual({
			chromiumOnly: true,
			audioStatus: "fallback-track",
			audioCodec: "AC3",
			compatibleAudioCodec: "AAC",
			unsupportedVideoCodec: "VC1",
		});
	});

	it("extracts public ASS/VTT subtitles, skips bitmap tracks, and picks Chinese ASS by default", () => {
		const mediaSource = {
			Id: "ms-1",
			Container: "mkv",
			MediaStreams: [
				{ Type: "Video", Codec: "hevc", Index: 0 },
				{ Type: "Audio", Codec: "aac", Index: 1 },
				{
					Type: "Subtitle",
					Codec: "pgssub",
					Index: 2,
					DisplayTitle: "Chinese PGS",
					IsTextSubtitleStream: false,
				},
				{
					Type: "Subtitle",
					Codec: "srt",
					Index: 3,
					Language: "eng",
					DisplayTitle: "English",
					DeliveryUrl: "/Videos/item-1/ms-1/Subtitles/3/0/Stream.srt",
				},
				{
					Type: "Subtitle",
					Codec: "ass",
					Index: 4,
					Language: "chi",
					DisplayTitle: "简体中文",
					IsDefault: true,
					DeliveryUrl: "/Videos/item-1/ms-1/Subtitles/4/0/Stream.ass",
				},
			],
		};

		const tracks = extractEmbySubtitles(
			"https://emby.example.com/emby",
			"tok-1",
			ITEM,
			mediaSource,
		);
		expect(tracks).toHaveLength(2);
		expect(tracks[0]).toMatchObject({
			format: "vtt",
			url: "https://emby.example.com/emby/Videos/item-1/ms-1/Subtitles/3/Stream.vtt?api_key=tok-1",
		});
		expect(tracks[1]).toMatchObject({
			format: "ass",
			label: "简体中文 · ASS",
			url: "https://emby.example.com/emby/Videos/item-1/ms-1/Subtitles/4/0/Stream.ass?api_key=tok-1",
		});

		expect(pickDefaultEmbySubtitle(tracks, "zh-CN")?.format).toBe("ass");
		// LAN IP servers must yield no subtitle URLs because the room enforces public subtitle URLs.
		expect(
			extractEmbySubtitles("http://192.168.1.10:8096", "tok-1", ITEM, mediaSource),
		).toEqual([]);
	});

	it("detects Safari, Firefox, and iOS WebKit browsers as non-Chromium, while allowing Android/desktop Chrome and Edge", () => {
		expect(
			isCurrentBrowserLikelyNonChromium(
				"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15",
			),
		).toBe(true);
		expect(
			isCurrentBrowserLikelyNonChromium(
				"Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/126.0.0.0 Mobile/15E148 Safari/604.1",
			),
		).toBe(true);
		expect(
			isCurrentBrowserLikelyNonChromium(
				"Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 EdgiOS/126.0.0.0 Mobile/15E148 Safari/605.1.15",
			),
		).toBe(true);
		expect(
			isCurrentBrowserLikelyNonChromium(
				"Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:128.0) Gecko/20100101 Firefox/128.0",
			),
		).toBe(true);
		expect(
			isCurrentBrowserLikelyNonChromium(
				"Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Mobile Safari/537.36",
			),
		).toBe(false);
		expect(
			isCurrentBrowserLikelyNonChromium(
				"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
			),
		).toBe(false);
		expect(
			isCurrentBrowserLikelyNonChromium(
				"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36 Edg/128.0.0.0",
			),
		).toBe(false);
	});

	it("builds a queue payload without leaking the token into text", () => {
		const source = {
			service: "direct" as const,
			url: "https://example.com/videos/1/original.mp4?api_key=token",
			mime: "video/mp4",
			container: "mp4",
			source: {
				RunTimeTicks: 72_000_000_000,
				MediaStreams: [{ Type: "Video", Width: 1920, Height: 1080 }],
			},
		};
		const video = embyItemToVideoAdd({
			server: "https://example.com",
			serverName: "Home",
			token: "token",
			item: ITEM,
			source,
			subtitleUrl:
				"https://example.com/Videos/item-1/ms-1/Subtitles/2/Stream.ass?api_key=token",
		});
		expect(video).toMatchObject({
			service: "direct",
			id: "https://example.com/videos/1/original.mp4?api_key=token",
			subtitleUrl:
				"https://example.com/Videos/item-1/ms-1/Subtitles/2/Stream.ass?api_key=token",
			metadata: {
				title: "The Film",
				description: "Emby · Home",
				mime: "video/mp4",
				length: 7200,
				width: 1920,
				height: 1080,
				cors: true,
			},
		});
		expect(video.metadata?.thumbnail).toContain("api_key=token");
		expect(video.metadata?.description).not.toContain("token");
	});

	it("formats runtimes and omits a missing poster", () => {
		expect(formatEmbyRuntime(72_000_000_000)).toBe("2h 0m");
		expect(formatEmbyRuntime(90 * 60 * 10_000_000)).toBe("1h 30m");
		expect(formatEmbyRuntime(undefined)).toBe("");
		expect(embyItemImageUrl("https://example.com", "token", ITEM)).toContain(
			"/Items/item-1/Images/Primary",
		);
		expect(embyItemImageUrl("https://example.com", "token", { ...ITEM, ImageTags: {} })).toBe(
			undefined,
		);
	});

	it("labels an episode with its season and episode number", () => {
		expect(
			formatEmbyEpisodeCode({
				...ITEM,
				Type: "Episode",
				ParentIndexNumber: 2,
				IndexNumber: 5,
			}),
		).toBe("S02E05");
		expect(formatEmbyEpisodeCode({ ...ITEM, ParentIndexNumber: 12, IndexNumber: 103 })).toBe(
			"S12E103",
		);
		// Movies and unnumbered items must not render an "S00E00" that means nothing.
		expect(formatEmbyEpisodeCode(ITEM)).toBe("");
		expect(formatEmbyEpisodeCode({ ...ITEM, ParentIndexNumber: 0, IndexNumber: 0 })).toBe("");
	});
});
