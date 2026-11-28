import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	EmbyError,
	authenticateEmby,
	embyDeviceId,
	embyItemImageUrl,
	embyItemToVideoAdd,
	formatEmbyRuntime,
	getEmbyPlaybackInfo,
	normalizeEmbyServer,
	pickPlayableEmbySource,
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
		expect(result.source).toMatchObject({ service: "hls", mime: "application/x-mpegURL" });
	});

	it("reports the container when no browser-playable source exists", () => {
		const playback: EmbyPlaybackInfo = {
			MediaSources: [
				{ Container: "mkv", DirectStreamUrl: "/videos/1/original.mkv?api_key=t" },
			],
		};
		const result = pickPlayableEmbySource("https://example.com", playback, ITEM);
		expect(result.source).toBeUndefined();
		expect(result.reason).toBe("mkv");
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
		});
		expect(video).toMatchObject({
			service: "direct",
			id: "https://example.com/videos/1/original.mp4?api_key=token",
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
});
