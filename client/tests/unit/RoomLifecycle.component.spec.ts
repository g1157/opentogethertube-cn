import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises } from "@vue/test-utils";
import { defineComponent, h, nextTick, ref, type Component } from "vue";
import type { QueueItem } from "ott-common/models/video";
import { PlayerStatus } from "ott-common/models/types";
import DirectPlayer from "@/components/players/DirectPlayer.vue";
import Room from "@/views/Room.vue";
import { OttSfx } from "@/plugins/sfx";
import { flush, mountComponent } from "./component-test-utils";

vi.mock("@/components/composables/media-audio-boost", () => ({
	useMediaAudioBoost: () => ({ setBoost: vi.fn(), resetFailedSetup: vi.fn() }),
}));

describe("room connection lifecycle", () => {
	let page: ReturnType<typeof mountComponent> | undefined;

	beforeEach(() => {
		vi.useFakeTimers();
		const saved = new Map<string, string>();
		vi.stubGlobal("localStorage", {
			getItem: (key: string) => saved.get(key) ?? null,
			setItem: (key: string, value: string) => saved.set(key, String(value)),
			removeItem: (key: string) => saved.delete(key),
			clear: () => saved.clear(),
		});
		vi.stubGlobal("matchMedia", () => ({
			matches: false,
			addEventListener: vi.fn(),
			removeEventListener: vi.fn(),
			addListener: vi.fn(),
			removeListener: vi.fn(),
		}));
		vi.spyOn(window, "scrollTo").mockImplementation(() => undefined);
		vi.spyOn(OttSfx.prototype, "loadSfx").mockResolvedValue(undefined);
	});

	afterEach(() => {
		page?.wrapper.unmount();
		page = undefined;
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
		vi.useRealTimers();
	});

	async function mountRoom(
		options: { component?: Component; realPlayer?: boolean; realMessages?: boolean } = {},
	) {
		const mounted = mountComponent(options.component ?? Room, {
			global: {
				stubs: {
					OmniPlayer: !options.realPlayer,
					VideoControls: true,
					Chat: true,
					VideoQueue: true,
					AddPreview: true,
					UserList: true,
					RoomSettingsForm: true,
					ShareInvite: true,
					ClientSettingsDialog: true,
					RoomDisconnected: true,
					ServerMessageHandler: !options.realMessages,
					WorkaroundPlaybackStatusUpdater: true,
					WorkaroundUserStateNotifier: true,
					RestoreQueue: true,
					VoteSkip: true,
				},
			},
		});
		page = mounted;
		const connect = vi.spyOn(mounted.connection, "connect").mockImplementation(() => {
			mounted.connection.active.value = true;
		});
		const disconnect = vi.spyOn(mounted.connection, "disconnect").mockImplementation(() => {
			mounted.connection.active.value = false;
			mounted.connection.connected.value = false;
		});
		const addMessageHandler = vi.spyOn(mounted.connection, "addMessageHandler");
		mounted.router.currentRoute.value = mounted.router.resolve({
			name: "room",
			params: { roomId: "lifecycle-room" },
		});
		await nextTick();
		return { ...mounted, connect, disconnect, addMessageHandler };
	}

	it("does not connect or register a sync handler when a token arrives after leaving", async () => {
		const { wrapper, store, connection, connect, addMessageHandler } = await mountRoom();
		expect(connect).not.toHaveBeenCalled();
		wrapper.unmount();

		store.commit("users/SET_AUTH_TOKEN", "late-token");
		await flush();
		await nextTick();
		store.commit("misc/ROOM_CREATED", { name: "another-room" });
		await vi.advanceTimersByTimeAsync(1000);

		expect(connect).not.toHaveBeenCalled();
		expect(addMessageHandler).not.toHaveBeenCalledWith("sync", expect.any(Function));
		expect(connection.active.value).toBe(false);
	});

	it("cancels a pending room-created reconnect when the room unmounts", async () => {
		const { wrapper, store, connection, connect, disconnect } = await mountRoom();
		store.commit("users/SET_AUTH_TOKEN", "available-token");
		await flush();
		await nextTick();
		expect(connect).toHaveBeenCalledOnce();
		expect(connect).toHaveBeenCalledWith("lifecycle-room");

		store.commit("misc/ROOM_CREATED", { name: "another-room" });
		expect(disconnect).toHaveBeenCalledOnce();
		wrapper.unmount();
		await vi.advanceTimersByTimeAsync(1000);

		expect(connect).toHaveBeenCalledOnce();
		expect(connection.active.value).toBe(false);
	});

	it("clears a previous playback error when the fresh room snapshot is empty", async () => {
		vi.useFakeTimers({
			toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"],
		});
		localStorage.setItem("token", "available-token");
		const { wrapper, store, connection } = await mountRoom({
			realPlayer: true,
			realMessages: true,
		});
		store.commit("PLAYBACK_STATUS", PlayerStatus.error);
		store.commit("PLAYBACK_BUFFER", 0.8);
		await flushPromises();
		connection.connected.value = true;
		connection.mockReceive({
			action: "sync",
			name: "lifecycle-room",
			currentSource: null,
			isPlaying: false,
			playbackPosition: 0,
		});
		await flushPromises();
		expect(wrapper.find('[data-cy="room-player-loading"]').exists()).toBe(false);
		expect(wrapper.find("video").exists()).toBe(false);
		expect(wrapper.find(".playback-error").exists()).toBe(false);
		expect(store.state.playerStatus).toBe(PlayerStatus.none);
		expect(store.state.playerBufferPercent).toBeNull();
	});

	it.each([
		true,
		false,
	])("waits for a fresh room sync on rejoin (saved token: %s)", async savedToken => {
		vi.useFakeTimers({
			toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"],
		});
		localStorage.setItem("token", savedToken ? "available-token" : "");
		const loadedUrls: string[] = [];
		const playedUrls: string[] = [];
		vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(function (
			this: HTMLMediaElement,
		) {
			const url = this.getAttribute("src");
			if (url) {
				loadedUrls.push(url);
			}
			this.currentTime = 0;
		});
		vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(function (
			this: HTMLMediaElement,
		) {
			playedUrls.push(this.getAttribute("src") ?? "");
			return Promise.resolve();
		});
		vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => undefined);
		vi.spyOn(HTMLMediaElement.prototype, "duration", "get").mockReturnValue(600);
		vi.spyOn(HTMLMediaElement.prototype, "readyState", "get").mockReturnValue(4);
		const joined = ref(true);
		const session = defineComponent({
			setup: () => () => (joined.value ? h(Room) : null),
		});
		const { wrapper, store, connection, connect } = await mountRoom({
			component: session,
			realPlayer: true,
			realMessages: true,
		});
		store.commit("users/SET_AUTH_TOKEN", "available-token");
		await flushPromises();
		const previousVideo: QueueItem = {
			service: "direct",
			id: "https://media.example/previous-episode.mp4",
			mime: "video/mp4",
			length: 600,
		};
		const freshVideo: QueueItem = {
			...previousVideo,
			id: "https://media.example/fresh-episode.mp4",
		};
		async function fullSync(video: QueueItem, position: number) {
			connection.connected.value = true;
			connection.mockReceive({
				action: "sync",
				name: "lifecycle-room",
				currentSource: video,
				isPlaying: true,
				playbackPosition: position,
				playbackSpeed: 1,
			});
			await flushPromises();
			await nextTick();
			const element = wrapper.get("video");
			await element.trigger("loadedmetadata");
			await element.trigger("canplay");
			await flushPromises();
		}

		await fullSync(previousVideo, 120);
		expect(wrapper.findComponent(DirectPlayer).exists()).toBe(true);
		expect(loadedUrls).toContain(previousVideo.id);
		expect(playedUrls).toContain(previousVideo.id);
		const firstElement = wrapper.get("video").element;
		const loadCount = loadedUrls.length;
		connection.connected.value = false;
		await nextTick();
		expect(wrapper.get("video").element).toBe(firstElement);
		expect(loadedUrls).toHaveLength(loadCount);
		connection.connected.value = true;
		joined.value = false;
		await nextTick();
		expect(connection.connected.value).toBe(false);
		loadedUrls.length = 0;
		playedUrls.length = 0;

		// The shared store still describes the previous visit while the room changes remotely.
		joined.value = true;
		await nextTick();
		await flushPromises();
		await vi.advanceTimersByTimeAsync(1000);
		expect(connect).toHaveBeenCalledTimes(2);
		expect(connection.connected.value).toBe(false);
		expect.soft(loadedUrls).toEqual([]);
		expect.soft(playedUrls).toEqual([]);
		connection.mockReceive({ action: "sync", isPlaying: true, playbackPosition: 150 });
		await nextTick();
		expect(wrapper.find("video").exists()).toBe(false);
		expect(wrapper.find('[data-cy="room-player-loading"]').exists()).toBe(true);

		await fullSync(freshVideo, 310);
		const video = wrapper.get("video").element as HTMLVideoElement;
		expect(loadedUrls).toEqual([freshVideo.id]);
		expect(playedUrls).toContain(freshVideo.id);
		expect(video.currentTime).toBeGreaterThanOrEqual(310);
		expect(video.currentTime).toBeLessThan(312);
		expect(connection.sent).toEqual([]);
	});
});
