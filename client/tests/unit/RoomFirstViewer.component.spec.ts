import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises } from "@vue/test-utils";
import { nextTick } from "vue";
import type { PlaybackPreparation, ServerMessageSync } from "ott-common/models/messages";
import { PlayerStatus } from "ott-common/models/types";
import type { QueueItem } from "ott-common/models/video";
import { type MediaPlayerV2, useVolume } from "@/components/composables";
import { noteLatencySample, resetLatencySamples } from "@/util/connection-latency";
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
		// The acknowledgement carries the room's saved frame, not the frame the element
		// happened to stop on, and the runway measured from that frame.
		expect(acknowledgements()).toEqual([
			{
				action: "status",
				status: PlayerStatus.ready,
				playbackPrepared: {
					id: token.id,
					position: 125,
					firstFrame: true,
					bufferAhead: 8.05,
				},
			},
		]);
		expect(page.wrapper.vm.playbackPreparationState.phase).toBe("waiting-ack");
		const plays = media.play.mock.calls.length;
		await sync({ isPlaying: true, playbackPosition: 125, playbackPreparation: null });
		expect(media.play.mock.calls.length).toBeGreaterThan(plays);
		expect(page.wrapper.vm.playbackPreparationState.active).toBe(false);
		expect(page.store.state.room.playbackStartTime).toBeDefined();
	});

	it("keeps the opening inaudible until the room starts playing", async () => {
		const volume = useVolume();
		await join();
		expect(volume.preparationFactor.value).toBe(0);
		playerEvent("playing");
		await frame();
		// Priming plays the element, so the picture is up while the round is still open and
		// nothing of it may be audible.
		expect(volume.preparationFactor.value).toBe(0);
		await sync({ isPlaying: true, playbackPosition: 125, playbackPreparation: null });
		expect(volume.preparationFactor.value).toBe(1);
	});

	it("restores the volume when a preparation is cancelled", async () => {
		const volume = useVolume();
		await join();
		expect(volume.preparationFactor.value).toBe(0);
		await sync({ isPlaying: false, playbackPosition: 125, playbackPreparation: null });
		expect(volume.preparationFactor.value).toBe(1);
	});

	it("restores the volume when the room unmounts", async () => {
		const volume = useVolume();
		await join();
		expect(volume.preparationFactor.value).toBe(0);
		// The multiplier is a module singleton: leaving it at 0 would silence the next room.
		page.wrapper.unmount();
		expect(volume.preparationFactor.value).toBe(1);
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
		// The loading state already reported current data, so readiness is acknowledged
		// without waiting for another compositor frame.
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

	describe("scheduled start", () => {
		beforeEach(() => {
			resetLatencySamples();
		});
		afterEach(() => {
			resetLatencySamples();
		});

		/** A clean round trip against a server whose clock matches ours. */
		function measureClock(skewMs = 0) {
			noteLatencySample(0, Date.now(), skewMs);
		}

		/** Drive the round to the point where this viewer acknowledged it. */
		async function acknowledge(startAt: number) {
			await join({ preparation: { ...token, startAt } });
			playerEvent("ready");
			await frame();
			playerEvent("playing");
			await flushPromises();
			expect(page.wrapper.vm.playbackPreparationState.phase).toBe("waiting-ack");
			expect(acknowledgements()).toHaveLength(1);
		}

		/**
		 * How far ahead the rounds below are scheduled. `Date` is real in this spec while the
		 * timers are fake, so real time passes while a round is driven; the lead has to be
		 * long enough that a loaded machine cannot use it up before the timer is armed.
		 */
		const LEAD_MS = 5000;

		/** Acknowledge a round scheduled LEAD_MS from now, and report the start time used. */
		async function acknowledgeRound(): Promise<number> {
			const startAt = Date.now() + LEAD_MS;
			await acknowledge(startAt);
			return startAt;
		}

		/**
		 * Run the fake clock past the scheduled start. The timer was armed for at most
		 * LEAD_MS (less whatever real time had passed by then), so this always reaches it,
		 * and overshoots by no more than that real time, far short of the 3s confirmation
		 * deadline.
		 */
		async function passScheduledStart(alreadyAdvanced = 0) {
			await vi.advanceTimersByTimeAsync(LEAD_MS + 20 - alreadyAdvanced);
		}

		it("starts at the scheduled moment instead of waiting for the isPlaying sync", async () => {
			measureClock();
			const startAt = await acknowledgeRound();
			const playsBeforeStart = media.play.mock.calls.length;
			const volume = useVolume();
			expect(page.store.state.room.isPlaying).toBe(false);

			// Short of the instant the client armed its timer for, whatever real time has
			// passed since: the remaining time only ever underestimates the timer's delay.
			const early = Math.max(0, startAt - Date.now() - 60);
			await vi.advanceTimersByTimeAsync(early);
			expect(media.play.mock.calls.length).toBe(playsBeforeStart);

			await passScheduledStart(early);
			// The round published a start time, so every viewer begins on that frame rather
			// than when its own confirmation happened to arrive.
			expect(media.play.mock.calls.length).toBe(playsBeforeStart + 1);
			expect(volume.preparationFactor.value).toBe(1);
			// The room has not confirmed it yet; only this viewer has started.
			expect(page.store.state.room.isPlaying).toBe(false);
		});

		it("treats the following isPlaying sync as a confirmation", async () => {
			measureClock();
			await acknowledgeRound();
			await passScheduledStart();
			// The element plays from the round's position, as the local start left it.
			await frame(await roomPositionNow());
			const pauses = media.pause.mock.calls.length;
			const seeks = media.setPosition.mock.calls.length;

			await sync({
				isPlaying: true,
				playbackPosition: 125,
				playbackSpeed: 1,
				playbackPreparation: null,
			});

			expect(media.pause.mock.calls.length).toBe(pauses);
			expect(media.setPosition.mock.calls.length).toBe(seeks);
			expect(useVolume().preparationFactor.value).toBe(1);
		});

		it("stops playing alone when the round is cancelled after the start", async () => {
			measureClock();
			await acknowledgeRound();
			const playsBeforeStart = media.play.mock.calls.length;
			await passScheduledStart();
			expect(media.play.mock.calls.length).toBe(playsBeforeStart + 1);
			const pauses = media.pause.mock.calls.length;

			// Someone paused or sought: the round is gone and the room is not playing.
			await sync({ isPlaying: false, playbackPosition: 125, playbackPreparation: null });

			expect(media.pause.mock.calls.length).toBeGreaterThan(pauses);
		});

		it("gives up a start the room never confirms", async () => {
			measureClock();
			await acknowledgeRound();
			const playsBeforeStart = media.play.mock.calls.length;
			await passScheduledStart();
			expect(media.play.mock.calls.length).toBe(playsBeforeStart + 1);
			const pauses = media.pause.mock.calls.length;

			await vi.advanceTimersByTimeAsync(3000);

			// The room was supposed to start at that moment; nothing confirmed it, so this
			// viewer must not stay the only one playing.
			expect(media.pause.mock.calls.length).toBeGreaterThan(pauses);
		});

		it("does not start the same round again after giving it up", async () => {
			measureClock();
			const startAt = await acknowledgeRound();
			await passScheduledStart();
			await vi.advanceTimersByTimeAsync(3000);
			const plays = media.play.mock.calls.length;
			const volume = useVolume();
			expect(volume.preparationFactor.value).toBe(0);

			// The round is still open and something about it is published again (another
			// viewer's acknowledgement), and a fresh clock sample arrives. Re-arming here
			// would start this viewer alone, with sound, on every such event for as long as
			// the round stays open: in production the start time is in the past by now and
			// the timer fires at once. `Date` is real in this spec, so the same re-armed
			// timer is reached by running the fake clock past the lead again.
			await sync({
				playbackPreparation: {
					...token,
					startAt,
					ready: [{ clientId: "bob", firstFrame: true, bufferAhead: 8, at: startAt }],
				},
			});
			measureClock();
			await passScheduledStart();

			expect(media.play.mock.calls.length).toBe(plays);
			expect(volume.preparationFactor.value).toBe(0);
			expect(page.store.state.room.isPlaying).toBe(false);

			// The confirming sync is still the way in.
			await sync({ isPlaying: true, playbackPosition: 125, playbackPreparation: null });
			expect(media.play.mock.calls.length).toBeGreaterThan(plays);
			expect(volume.preparationFactor.value).toBe(1);
		});

		it("waits for the isPlaying sync while no clock offset is known", async () => {
			await acknowledge(Date.now() + LEAD_MS);
			const playsBeforeStart = media.play.mock.calls.length;

			await vi.advanceTimersByTimeAsync(LEAD_MS + 4000);
			expect(media.play.mock.calls.length).toBe(playsBeforeStart);
			expect(page.store.state.room.isPlaying).toBe(false);

			await sync({ isPlaying: true, playbackPosition: 125, playbackPreparation: null });
			expect(media.play.mock.calls.length).toBeGreaterThan(playsBeforeStart);
		});

		it("does not start before this viewer acknowledged the round", async () => {
			measureClock();
			await join({ preparation: { ...token, startAt: Date.now() + LEAD_MS } });
			const playsBeforeStart = media.play.mock.calls.length;

			await vi.advanceTimersByTimeAsync(LEAD_MS + 4000);

			expect(media.play.mock.calls.length).toBe(playsBeforeStart);
			expect(page.store.state.room.isPlaying).toBe(false);
		});
	});

	/** The room's clock as the view materialises it, for keeping the element in step. */
	async function roomPositionNow(): Promise<number> {
		await nextTick();
		return page.wrapper.vm.truePosition as number;
	}
});
