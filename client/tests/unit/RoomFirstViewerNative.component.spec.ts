import { afterEach, describe, expect, it, vi } from "vitest";
import { flushPromises } from "@vue/test-utils";
import DirectPlayer from "@/components/players/DirectPlayer.vue";
import MediaLoadingNotice from "@/components/players/MediaLoadingNotice.vue";
import type { MediaPlayerV2 } from "@/components/composables";
import { OttSfx } from "@/plugins/sfx";
import Room from "@/views/Room.vue";
import { mountComponent } from "./component-test-utils";

vi.mock("@/components/composables/media-audio-boost", () => ({
	useMediaAudioBoost: () => ({ setBoost: vi.fn(), resetFailedSetup: vi.fn() }),
}));

describe("first viewer native MP4 event chain", () => {
	let page: ReturnType<typeof mountComponent> | undefined;

	afterEach(() => {
		page?.wrapper.unmount();
		(page?.wrapper.vm.player as MediaPlayerV2 | undefined)?.setPlayer(null);
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
	});

	it.each([
		"canplay",
		"loadeddata",
		"progress",
	])("resumes from %s with current data and no compositor callback", async readyEvent => {
		const saved = new Map([["token", "available-token"]]);
		vi.stubGlobal("localStorage", {
			getItem: (key: string) => saved.get(key) ?? null,
			setItem: (key: string, value: string) => saved.set(key, String(value)),
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
		let paused = true;
		let readyState = 0;
		let frameWidth = 0;
		vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(function (
			this: HTMLMediaElement,
		) {
			this.currentTime = 0;
		});
		const play = vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(async () => {
			paused = false;
		});
		vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(function (
			this: HTMLMediaElement,
		) {
			if (!paused) {
				paused = true;
				this.dispatchEvent(new Event("pause"));
			}
		});
		vi.spyOn(HTMLMediaElement.prototype, "paused", "get").mockImplementation(() => paused);
		vi.spyOn(HTMLMediaElement.prototype, "readyState", "get").mockImplementation(
			() => readyState,
		);
		vi.spyOn(HTMLMediaElement.prototype, "duration", "get").mockReturnValue(600);
		vi.spyOn(HTMLVideoElement.prototype, "videoWidth", "get").mockImplementation(
			() => frameWidth,
		);
		vi.spyOn(HTMLVideoElement.prototype, "videoHeight", "get").mockImplementation(() =>
			frameWidth ? 720 : 0,
		);
		page = mountComponent(Room, {
			global: {
				stubs: {
					VideoControls: true,
					Chat: true,
					VideoQueue: true,
					AddPreview: true,
					UserList: true,
					RoomSettingsForm: true,
					ShareInvite: true,
					ClientSettingsDialog: true,
					RoomDisconnected: true,
					WorkaroundPlaybackStatusUpdater: true,
					WorkaroundUserStateNotifier: true,
					RestoreQueue: true,
					VoteSkip: true,
				},
			},
		});
		page.wrapper.vm.debugMode = false;
		page.connection.active.value = true;
		page.connection.connected.value = true;
		page.router.currentRoute.value = page.router.resolve({
			name: "room",
			params: { roomId: "native-preparation-room" },
		});
		await flushPromises();
		page.connection.mockReceive({ action: "you", info: { id: "alice" } });
		const video = { service: "direct", id: "https://media.test/native.mp4" } as const;
		page.connection.mockReceive({
			action: "sync",
			name: "native-preparation-room",
			currentSource: { ...video, mime: "video/mp4", length: 600 },
			isPlaying: false,
			playbackPosition: 125,
			playbackPreparation: { id: "native-resume", clientId: "alice", video, position: 125 },
		});
		await flushPromises();
		expect(page.wrapper.findComponent(DirectPlayer).exists()).toBe(true);
		const element = page.wrapper.get("video");
		Object.defineProperties(element.element, {
			requestVideoFrameCallback: { value: vi.fn(() => 1) },
			cancelVideoFrameCallback: { value: vi.fn() },
		});
		readyState = 1;
		await element.trigger("loadedmetadata");
		readyState = 2;
		await element.trigger(readyEvent);
		await flushPromises();
		expect((element.element as HTMLVideoElement).currentTime).toBe(125);
		expect(play).toHaveBeenCalled();
		expect(page.connection.sent).toEqual([]);

		frameWidth = 1280;
		await element.trigger("loadeddata");
		await flushPromises();
		expect(page.connection.sent).toEqual([]);
		await element.trigger("playing");
		await flushPromises();
		expect(paused).toBe(true);
		expect(page.store.state.room.isPlaying).toBe(false);
		expect(page.connection.sent).toEqual([
			{
				action: "status",
				status: "ready",
				playbackPrepared: { id: "native-resume", position: 125 },
			},
		]);
		page.connection.mockReceive({
			action: "sync",
			isPlaying: true,
			playbackPreparation: null,
			playbackPosition: 125,
		});
		await flushPromises();
		expect(paused).toBe(false);
		expect(page.wrapper.findComponent(MediaLoadingNotice).exists()).toBe(false);
	});
});
