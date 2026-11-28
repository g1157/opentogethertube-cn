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

function installFetch(playbackSource: Record<string, unknown>) {
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
	input('[data-cy="emby-server"]').value = "emby.example.com";
	input('[data-cy="emby-server"]').dispatchEvent(new Event("input"));
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

	it("disables adding when the only source is an MKV", async () => {
		installFetch({
			Container: "mkv",
			DirectStreamUrl: "/videos/1/original.mkv?api_key=token-1",
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
		expect(document.body.textContent).toContain("mkv");
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
