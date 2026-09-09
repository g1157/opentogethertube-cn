import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises } from "@vue/test-utils";
import { nextTick } from "vue";
import type { PlaybackPreparation, ServerMessageSync } from "ott-common/models/messages";
import { PlayerStatus } from "ott-common/models/types";
import type { QueueItem } from "ott-common/models/video";
import type { MediaPlayerV2 } from "@/components/composables";
import OmniPlayer from "@/components/players/OmniPlayer.vue";
import { OttSfx } from "@/plugins/sfx";
import Room from "@/views/Room.vue";
import { mountComponent } from "./component-test-utils";

describe("room first viewer preparation integration", () => {
	let page: ReturnType<typeof mountComponent>;
	let api: MediaPlayerV2;
	let position: number;
	let rejectAutoplay: boolean;
	const video: QueueItem = {
		service: "direct",
		id: "https://media.test/episode.mp4",
		mime: "video/mp4",
		length: 600,
	};
	const token: PlaybackPreparation = {
		id: "resume-one",
		clientId: "alice",
		video: { service: video.service, id: video.id },
		position: 125,
	};
	let media: {
		play: ReturnType<typeof vi.fn<[], Promise<void>>>;
		pause: ReturnType<typeof vi.fn<[], void>>;
		getPosition: ReturnType<typeof vi.fn<[], number | Promise<number>>>;
		setPosition: ReturnType<typeof vi.fn<[number], void>>;
		setVolume: ReturnType<typeof vi.fn<[number], void>>;
		isSeeking: () => boolean;
		isRecovering: () => boolean;
		isCaptionsSupported: () => boolean;
		isQualitySupported: () => boolean;
		getAvailablePlaybackRates: () => number[];
	};

	beforeEach(async () => {
		vi.useFakeTimers({
			toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"],
		});
		const saved = new Map([["token", "available-token"]]);
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
		page = mountComponent(Room, {
			global: {
				stubs: {
					OmniPlayer: true,
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
		api = page.wrapper.vm.player as MediaPlayerV2;
		api.setPlayer(null);
		api.playing.value = false;
		page.router.currentRoute.value = page.router.resolve({
			name: "room",
			params: { roomId: "first-viewer-room" },
		});
		page.connection.active.value = true;
		page.connection.connected.value = true;
		position = 0;
		rejectAutoplay = false;
		media = {
			play: vi.fn<[], Promise<void>>(async () => {
				if (rejectAutoplay) {
					throw new DOMException("Interaction required", "NotAllowedError");
				}
			}),
			pause: vi.fn<[], void>(() => {
				playerEvent("paused");
			}),
			getPosition: vi.fn<[], number | Promise<number>>(() => position),
			setPosition: vi.fn<[number], void>(target => {
				position = target;
			}),
			setVolume: vi.fn<[number], void>(),
			isSeeking: () => false,
			isRecovering: () => false,
			isCaptionsSupported: () => false,
			isQualitySupported: () => false,
			getAvailablePlaybackRates: () => [1],
		};
		await flushPromises();
	});

	afterEach(() => {
		page.wrapper.unmount();
		api.setPlayer(null);
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
		vi.useRealTimers();
	});

	function playerEvent(name: "ready" | "apiready" | "playing" | "paused") {
		page.wrapper.findComponent(OmniPlayer).vm.$emit(name);
	}

	async function sync(message: Partial<ServerMessageSync>) {
		page.connection.mockReceive({ action: "sync", ...message });
		await flushPromises();
		await nextTick();
	}

	async function join(
		options: { preparation?: PlaybackPreparation | null; you?: string; playing?: boolean } = {},
	) {
		page.connection.mockReceive({ action: "you", info: { id: options.you ?? "alice" } });
		await sync({
			name: "first-viewer-room",
			currentSource: video,
			isPlaying: options.playing ?? false,
			playbackPosition: 125,
			playbackSpeed: 1,
			playbackPreparation: options.preparation === undefined ? token : options.preparation,
		});
		api.setPlayer(media);
		api.markApiReady();
		page.store.commit("PLAYBACK_STATUS", PlayerStatus.ready);
		playerEvent("apiready");
		await flushPromises();
	}

	async function frame(time = 125.05) {
		position = time;
		page.wrapper.findComponent(OmniPlayer).vm.$emit("loading-state", {
			phase: null,
			currentTime: time,
			bufferAhead: 8,
		});
		await flushPromises();
	}

	function acknowledgements() {
		return page.connection.sent.filter(
			message => message.action === "status" && message.playbackPrepared,
		);
	}

	it("keeps the saved time until the first frame and actual playback, then resumes from the server", async () => {
		await join();
		expect(media.setPosition).toHaveBeenCalledWith(125);
		expect(media.play).toHaveBeenCalled();
		expect(page.store.state.room.isPlaying).toBe(false);
		await vi.advanceTimersByTimeAsync(5000);
		expect(page.wrapper.vm.truePosition).toBe(125);
		expect(media.setPosition).toHaveBeenCalledTimes(1);
		playerEvent("ready");
		await frame();
		expect(acknowledgements()).toEqual([]);
		playerEvent("playing");
		await flushPromises();
		expect(acknowledgements()).toEqual([
			{
				action: "status",
				status: PlayerStatus.ready,
				playbackPrepared: { id: token.id, position: 125.05 },
			},
		]);
		expect(page.wrapper.vm.playbackPreparationState.phase).toBe("waiting-ack");
		const plays = media.play.mock.calls.length;
		await sync({ isPlaying: true, playbackPosition: 125, playbackPreparation: null });
		expect(media.play.mock.calls.length).toBeGreaterThan(plays);
		expect(page.wrapper.vm.playbackPreparationState.active).toBe(false);
		expect(page.store.state.room.playbackStartTime).toBeDefined();
	});

	it("does not send playback requests or stop the clock when joining people already watching", async () => {
		await join({ preparation: null, playing: true });
		playerEvent("playing");
		await frame(125.1);
		expect(page.connection.sent).toEqual([]);
		expect(page.store.state.room.isPlaying).toBe(true);
		expect(media.play).toHaveBeenCalled();
		expect(media.pause).not.toHaveBeenCalled();
	});

	async function deliverLatePrerequisite(late: string) {
		if (late === "token") {
			await sync({ playbackPreparation: token });
		} else {
			page.connection.mockReceive({ action: "you", info: { id: "alice" } });
			await flushPromises();
		}
	}

	it.each(["token", "identity"])("handles a frame before the late %s message", async late => {
		await join(late === "token" ? { preparation: null } : { you: "" });
		await frame();
		await deliverLatePrerequisite(late);
		expect(media.play).toHaveBeenCalled();
		expect(acknowledgements()).toEqual([]);
		playerEvent("playing");
		await flushPromises();
		expect(acknowledgements()).toHaveLength(1);
	});

	it("only seeks locally when the first visible frame is already beyond the saved scene", async () => {
		await join();
		playerEvent("playing");
		await frame(128);
		expect(position).toBe(125);
		expect(acknowledgements()).toEqual([]);
		playerEvent("playing");
		await flushPromises();
		expect(acknowledgements()).toEqual([]);
		await frame();
		expect(acknowledgements()).toHaveLength(1);
		expect(page.connection.sent.every(message => message.action === "status")).toBe(true);
	});

	it("unlocks autoplay locally without prematurely telling the room to play", async () => {
		rejectAutoplay = true;
		await join();
		expect(page.wrapper.vm.mediaPlaybackBlocked).toBe(true);
		await frame();
		expect(acknowledgements()).toEqual([]);
		rejectAutoplay = false;
		page.wrapper.vm.onClickUnblockPlayback();
		playerEvent("playing");
		await flushPromises();
		expect(page.wrapper.vm.mediaPlaybackBlocked).toBe(false);
		expect(acknowledgements()).toHaveLength(1);
		expect(page.connection.sent.every(message => message.action === "status")).toBe(true);
	});

	it("ignores a pending acknowledgement after an explicit pause cancels preparation", async () => {
		await join();
		playerEvent("playing");
		let resolve!: (value: number) => void;
		media.getPosition.mockReturnValueOnce(new Promise<number>(done => (resolve = done)));
		await frame();
		await sync({ isPlaying: false, playbackPreparation: null, playbackPosition: 125 });
		resolve(125.05);
		await flushPromises();
		expect(acknowledgements()).toEqual([]);
		expect(page.wrapper.vm.playbackPreparationState.active).toBe(false);
	});

	it("clears a previous visit's token when a new full snapshot omits the field", async () => {
		await join();
		await sync({
			name: "first-viewer-room",
			currentSource: video,
			isPlaying: false,
			playbackPosition: 125,
		});
		expect(page.store.state.room.playbackPreparation).toBeNull();
		playerEvent("playing");
		await frame();
		expect(acknowledgements()).toEqual([]);
	});
});
