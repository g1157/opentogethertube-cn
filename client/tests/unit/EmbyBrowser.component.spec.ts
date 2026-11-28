import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RoomRequestType } from "ott-common/models/messages";
import EmbyBrowser from "@/components/EmbyBrowser.vue";
import { flush, mountComponent } from "./component-test-utils";

const { API } = vi.hoisted(() => ({
	API: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
}));
vi.mock("@/common-http", () => ({ API }));

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

const ITEM = {
	Id: "item-1",
	Name: "The Film",
	Type: "Movie",
	ProductionYear: 2024,
	RunTimeTicks: 72_000_000_000,
	ImageTags: { Primary: "tag-1" },
};

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

function installFetch(
	playbackSource: Record<string, unknown>,
	itemsFor?: (url: string) => { Items: unknown[]; TotalRecordCount: number },
) {
	const fetchMock = vi.fn(async (input: string | URL | Request) => {
		const url = String(input);
		if (url.endsWith("/Users/AuthenticateByName")) {
			return jsonResponse({
				AccessToken: "token-1",
				User: { Id: "user-1", Name: "Alice" },
			});
		}
		if (url.endsWith("/System/Info/Public")) {
			return jsonResponse({ ServerName: "Home" });
		}
		if (url.endsWith("/Users/user-1/Views")) {
			return jsonResponse({ Items: [{ Id: "view-1", Name: "Movies" }] });
		}
		if (url.includes("/Users/user-1/Items")) {
			if (itemsFor) {
				return jsonResponse(itemsFor(url));
			}
			return jsonResponse({ Items: [ITEM], TotalRecordCount: 1 });
		}
		if (url.includes("/Items/item-1/PlaybackInfo")) {
			return jsonResponse({ MediaSources: [playbackSource] });
		}
		throw new Error("Unexpected Emby request: " + url);
	});
	vi.stubGlobal("fetch", fetchMock);
	return fetchMock;
}

function input(selector: string): HTMLInputElement {
	return document.querySelector<HTMLInputElement>(`${selector} input`)!;
}

async function connect() {
	input('[data-cy="emby-host"]').value = "emby.example.com";
	input('[data-cy="emby-host"]').dispatchEvent(new Event("input"));
	input('[data-cy="emby-username"]').value = "alice";
	input('[data-cy="emby-username"]').dispatchEvent(new Event("input"));
	await flush();
	document.querySelector<HTMLElement>('[data-cy="emby-connect"]')!.click();
	await flush();
}

describe("EmbyBrowser component", () => {
	beforeEach(() => {
		vi.stubGlobal("localStorage", memoryStorage());
		vi.clearAllMocks();
		API.post.mockResolvedValue({ data: { success: true } });
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("connects, lists the library and adds a direct source", async () => {
		installFetch({
			Container: "mp4",
			DirectStreamUrl: "/videos/1/original.mp4?api_key=token-1",
			RunTimeTicks: 72_000_000_000,
			MediaStreams: [{ Type: "Video", Width: 1920, Height: 1080 }],
		});
		const { wrapper, store } = mountComponent(EmbyBrowser, {
			props: { modelValue: true },
		});
		store.state.room.name = "test-room";
		await flush();

		await connect();
		await vi.waitFor(
			() => {
				expect(document.body.textContent).toContain("The Film");
			},
			{ timeout: 5000 },
		);

		document.querySelector<HTMLElement>('[data-cy="emby-item-item-1"]')!.click();
		await vi.waitFor(
			() => {
				expect(
					document.querySelector<HTMLButtonElement>('[data-cy="emby-add"]')?.disabled,
				).toBe(false);
			},
			{ timeout: 5000 },
		);
		document.querySelector<HTMLElement>('[data-cy="emby-add"]')!.click();
		await flush();
		await flush();

		expect(API.post).toHaveBeenCalledTimes(1);
		const [url, payload] = API.post.mock.calls[0];
		expect(url).toBe("/room/test-room/queue");
		expect(payload).toMatchObject({
			service: "direct",
			id: "https://emby.example.com/videos/1/original.mp4?api_key=token-1",
			metadata: {
				title: "The Film",
				description: "Emby · Home",
				mime: "video/mp4",
				length: 7200,
				cors: true,
			},
		});
		expect(wrapper.emitted("added")).toBeTruthy();
		expect(store.state.toast.notifications.at(-1)?.content).toBe("已加入队列");
	});

	it("disables adding when the only source is an unsupported container", async () => {
		installFetch({
			Container: "avi",
			DirectStreamUrl: "/videos/1/original.avi?api_key=token-1",
		});
		mountComponent(EmbyBrowser, { props: { modelValue: true } });
		await flush();

		await connect();
		await vi.waitFor(
			() => {
				expect(document.body.textContent).toContain("The Film");
			},
			{ timeout: 5000 },
		);

		document.querySelector<HTMLElement>('[data-cy="emby-item-item-1"]')!.click();
		await vi.waitFor(
			() => {
				expect(document.querySelector('[data-cy="emby-unsupported"]')).not.toBeNull();
			},
			{ timeout: 5000 },
		);

		const button = document.querySelector<HTMLButtonElement>('[data-cy="emby-add"]')!;
		expect(button.disabled).toBe(true);
		expect(
			document.querySelector<HTMLButtonElement>('[data-cy="emby-play-now"]')!.disabled,
		).toBe(true);
		expect(document.body.textContent).toContain("avi");
	});

	it("allows direct-only MKV playback with audio warnings and attaches the default ASS subtitle", async () => {
		installFetch({
			Id: "ms-1",
			Container: "mkv",
			DirectStreamUrl: "/videos/1/original.mkv?api_key=token-1",
			RunTimeTicks: 72_000_000_000,
			MediaStreams: [
				{ Type: "Video", Codec: "hevc", Width: 1920, Height: 1080, Index: 0 },
				{ Type: "Audio", Codec: "dts", IsDefault: true, Index: 1 },
				{
					Type: "Subtitle",
					Codec: "ass",
					Index: 2,
					Language: "chi",
					DisplayTitle: "简体中文",
					IsDefault: true,
					DeliveryUrl: "/Videos/item-1/ms-1/Subtitles/2/0/Stream.ass?api_key=token-1",
				},
			],
		});
		const { store } = mountComponent(EmbyBrowser, { props: { modelValue: true } });
		store.state.room.name = "test-room";
		await flush();

		await connect();
		await vi.waitFor(
			() => {
				expect(document.body.textContent).toContain("The Film");
			},
			{ timeout: 5000 },
		);

		document.querySelector<HTMLElement>('[data-cy="emby-item-item-1"]')!.click();
		await vi.waitFor(
			() => {
				expect(
					document.querySelector<HTMLButtonElement>('[data-cy="emby-add"]')?.disabled,
				).toBe(false);
			},
			{ timeout: 5000 },
		);

		expect(document.querySelector('[data-cy="emby-audio-warning"]')?.textContent).toContain(
			"DTS",
		);
		expect(document.querySelector('[data-cy="emby-subtitle-select"]')).not.toBeNull();

		document.querySelector<HTMLElement>('[data-cy="emby-add"]')!.click();
		await flush();
		await flush();

		expect(API.post).toHaveBeenCalledTimes(1);
		const [, payload] = API.post.mock.calls[0];
		expect(payload).toMatchObject({
			service: "direct",
			id: "https://emby.example.com/videos/1/original.mkv?api_key=token-1",
			subtitleUrl:
				"https://emby.example.com/Videos/item-1/ms-1/Subtitles/2/0/Stream.ass?api_key=token-1",
			metadata: {
				mime: "video/x-matroska",
				width: 1920,
				height: 1080,
			},
		});
	});

	it("plays an MKV through Emby's HLS transcode stream", async () => {
		installFetch({
			Container: "mkv",
			DirectStreamUrl: "/videos/1/original.mkv?api_key=token-1",
			TranscodingUrl: "/videos/1/master.m3u8?api_key=token-1",
			TranscodingSubProtocol: "hls",
			MediaStreams: [
				{ Type: "Video", Codec: "hevc", Width: 1920, Height: 1080 },
				{ Type: "Audio", Codec: "dts" },
			],
		});
		const { store } = mountComponent(EmbyBrowser, { props: { modelValue: true } });
		store.state.room.name = "test-room";
		await flush();

		await connect();
		await vi.waitFor(
			() => {
				expect(document.body.textContent).toContain("The Film");
			},
			{ timeout: 5000 },
		);

		document.querySelector<HTMLElement>('[data-cy="emby-item-item-1"]')!.click();
		await vi.waitFor(
			() => {
				expect(
					document.querySelector<HTMLButtonElement>('[data-cy="emby-add"]')?.disabled,
				).toBe(false);
			},
			{ timeout: 5000 },
		);

		document.querySelector<HTMLElement>('[data-cy="emby-add"]')!.click();
		await flush();
		await flush();

		const [, payload] = API.post.mock.calls[0];
		expect(payload).toMatchObject({
			service: "hls",
			id: "https://emby.example.com/videos/1/master.m3u8?api_key=token-1",
			metadata: { mime: "application/x-mpegURL", width: 1920, height: 1080 },
		});
	});

	it("gives transcoding and unverified tiles visually different backgrounds", async () => {
		installFetch(
			{
				Container: "mp4",
				DirectStreamUrl: "/videos/1/original.mp4?api_key=token-1",
			},
			() => ({
				Items: [
					{
						...ITEM,
						Id: "item-mkv",
						Name: "Rip",
						MediaSources: [
							{
								Container: "mkv",
								MediaStreams: [
									{ Type: "Video", Codec: "hevc" },
									{ Type: "Audio", Codec: "dts" },
								],
							},
						],
					},
					{
						...ITEM,
						Id: "item-url",
						Name: "Link",
						MediaSources: [{ Container: "m3u8" }],
					},
					{
						...ITEM,
						Id: "item-mp4",
						Name: "Clean",
						MediaSources: [{ Container: "mp4" }],
					},
				],
				TotalRecordCount: 3,
			}),
		);
		mountComponent(EmbyBrowser, { props: { modelValue: true } });
		await flush();

		await connect();
		await vi.waitFor(
			() => {
				expect(document.querySelector('[data-cy="emby-item-item-mkv"]')).not.toBeNull();
			},
			{ timeout: 5000 },
		);

		const tile = (id: string) =>
			document.querySelector<HTMLElement>(`[data-cy="emby-item-${id}"]`)!;
		expect(tile("item-mkv").classList.contains("emby-tile-transcode")).toBe(true);
		expect(tile("item-url").classList.contains("emby-tile-unknown")).toBe(true);
		expect(tile("item-mp4").classList.contains("emby-tile-direct")).toBe(true);

		// The teal palette's `secondary` is amber, i.e. the same hue as `warning`; the
		// unverified badge must therefore drop the role colour for neutral grey.
		const unverifiedBadge = tile("item-url").querySelector<HTMLElement>(".emby-tile-badge")!;
		expect(unverifiedBadge.classList.contains("emby-badge-unknown")).toBe(true);
		expect(
			tile("item-mp4")
				.querySelector(".emby-tile-badge")!
				.classList.contains("emby-badge-unknown"),
		).toBe(false);
	});

	it("splits the server address into scheme, host and port", async () => {
		const fetchMock = installFetch({
			Container: "mp4",
			DirectStreamUrl: "/videos/1/original.mp4?api_key=token-1",
		});
		mountComponent(EmbyBrowser, { props: { modelValue: true } });
		await flush();

		// Pasting the web UI address must not leave "http://" or "/web/index.html" in a host field.
		input('[data-cy="emby-host"]').value = "http://192.168.1.10/web/index.html";
		input('[data-cy="emby-host"]').dispatchEvent(new Event("input"));
		await flush();
		expect(input('[data-cy="emby-host"]').value).toBe("192.168.1.10");

		input('[data-cy="emby-port"]').value = "8096";
		input('[data-cy="emby-port"]').dispatchEvent(new Event("input"));
		input('[data-cy="emby-username"]').value = "alice";
		input('[data-cy="emby-username"]').dispatchEvent(new Event("input"));
		await flush();
		document.querySelector<HTMLElement>('[data-cy="emby-connect"]')!.click();
		await flush();

		expect(fetchMock).toHaveBeenCalledWith(
			"http://192.168.1.10:8096/Users/AuthenticateByName",
			expect.anything(),
		);
	});

	it("labels an episode with its series and season", async () => {
		installFetch(
			{
				Container: "mp4",
				DirectStreamUrl: "/videos/1/original.mp4?api_key=token-1",
			},
			() => ({
				Items: [
					{
						Id: "ep-1",
						Name: "试播集",
						Type: "Episode",
						SeriesName: "无耻之徒",
						ParentIndexNumber: 1,
						IndexNumber: 2,
						ProductionYear: 2011,
					},
				],
				TotalRecordCount: 1,
			}),
		);
		mountComponent(EmbyBrowser, { props: { modelValue: true } });
		await flush();

		await connect();
		await vi.waitFor(
			() => {
				expect(document.body.textContent).toContain("无耻之徒");
			},
			{ timeout: 5000 },
		);
		expect(document.body.textContent).toContain("S01E02");
	});

	it("opens a series and lists only its episodes", async () => {
		const fetchMock = installFetch(
			{
				Container: "mp4",
				DirectStreamUrl: "/videos/1/original.mp4?api_key=token-1",
			},
			url =>
				url.includes("ParentId=series-1")
					? {
							Items: [
								{
									Id: "ep-9",
									Name: "重逢",
									Type: "Episode",
									SeriesName: "无耻之徒",
									ParentIndexNumber: 2,
									IndexNumber: 5,
								},
							],
							TotalRecordCount: 1,
						}
					: {
							Items: [{ Id: "series-1", Name: "无耻之徒", Type: "Series" }],
							TotalRecordCount: 1,
						},
		);
		mountComponent(EmbyBrowser, { props: { modelValue: true } });
		await flush();

		await connect();
		await vi.waitFor(
			() => {
				expect(document.querySelector('[data-cy="emby-item-series-1"]')).not.toBeNull();
			},
			{ timeout: 5000 },
		);
		document.querySelector<HTMLElement>('[data-cy="emby-item-series-1"]')!.click();
		await vi.waitFor(
			() => {
				expect(document.body.textContent).toContain("S02E05");
			},
			{ timeout: 5000 },
		);

		const itemsCall = fetchMock.mock.calls
			.map(call => String(call[0]))
			.find(url => url.includes("ParentId=series-1"))!;
		expect(itemsCall).toContain("IncludeItemTypes=Episode");
		// Title sort puts S10E12 before S1E1; browse order must be season, then episode.
		expect(itemsCall).toContain("SortBy=ParentIndexNumber%2CIndexNumber");
		expect(document.querySelector('[data-cy="emby-series-back"]')).not.toBeNull();
	});

	it("plays now through the room socket", async () => {
		installFetch({
			Container: "mp4",
			DirectStreamUrl: "/videos/1/original.mp4?api_key=token-1",
		});
		const { store, connection } = mountComponent(EmbyBrowser, {
			props: { modelValue: true },
		});
		store.state.room.name = "test-room";
		await flush();

		await connect();
		await vi.waitFor(
			() => {
				expect(document.body.textContent).toContain("The Film");
			},
			{ timeout: 5000 },
		);
		document.querySelector<HTMLElement>('[data-cy="emby-item-item-1"]')!.click();
		await vi.waitFor(
			() => {
				expect(
					document.querySelector<HTMLButtonElement>('[data-cy="emby-play-now"]')
						?.disabled,
				).toBe(false);
			},
			{ timeout: 5000 },
		);
		document.querySelector<HTMLElement>('[data-cy="emby-play-now"]')!.click();
		await flush();

		expect(connection.sent).toEqual([
			{
				action: "req",
				request: {
					type: RoomRequestType.PlayNowRequest,
					video: expect.objectContaining({
						service: "direct",
						metadata: expect.objectContaining({ title: "The Film" }),
					}),
				},
			},
		]);
	});
});
