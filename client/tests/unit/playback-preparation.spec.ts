import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	createPlaybackPreparation,
	type PlaybackPreparationState,
} from "@/util/playback-preparation";

describe("first viewer playback preparation", () => {
	let input: ReturnType<Parameters<typeof createPlaybackPreparation>[0]["getState"]>;
	let position: number;
	let status: PlaybackPreparationState;
	let preparation: ReturnType<typeof createPlaybackPreparation>;
	let getPosition: ReturnType<typeof vi.fn<[], number | Promise<number>>>;
	let setPosition: ReturnType<typeof vi.fn<[number], void>>;
	let pause: ReturnType<typeof vi.fn<[], void | Promise<void>>>;
	let sendReady: ReturnType<typeof vi.fn>;
	let sendFailed: ReturnType<typeof vi.fn>;
	let onError: ReturnType<typeof vi.fn>;
	/** Injected clock; the paused-wait fallback is decided on it, not on wall time. */
	let clock: number;

	beforeEach(() => {
		const video = { service: "direct", id: "https://media.test/episode.mp4" } as const;
		input = {
			preparation: { id: "resume-one", clientId: "alice", video, position: 125 },
			clientId: "alice",
			source: video,
			player: {},
			connected: true,
			roomPlaying: false,
			ready: true,
			playing: false,
			blocked: false,
			error: false,
			seeking: false,
			recovering: false,
			loading: null,
			frameVersion: 0,
			visible: true,
		};
		position = 0;
		status = { phase: "idle", active: false, priming: false, failed: false };
		getPosition = vi.fn<[], number | Promise<number>>(() => position);
		setPosition = vi.fn<[number], void>(target => {
			position = target;
		});
		pause = vi.fn<[], void | Promise<void>>(() => {
			input.playing = false;
		});
		sendReady = vi.fn();
		sendFailed = vi.fn();
		onError = vi.fn();
		clock = 0;
		preparation = createPlaybackPreparation({
			getState: () => input,
			getPosition,
			setPosition,
			pause,
			sendReady,
			sendFailed,
			now: () => clock,
			onChange: value => {
				status = value;
			},
			onError,
		});
	});

	function frame(time = 125.05, playing = true) {
		position = time;
		input.playing = playing;
		input.loading = { phase: null, currentTime: time, bufferAhead: 8 };
		input.frameVersion++;
	}

	it("holds the saved room time while priming and pauses locally before acknowledging once", async () => {
		await preparation.tick();
		expect(setPosition).toHaveBeenCalledOnce();
		expect(setPosition).toHaveBeenCalledWith(125);
		expect(status.priming).toBe(true);
		input.playing = true;
		input.loading = { phase: "waiting-frame", currentTime: 125, bufferAhead: 8 };
		for (let i = 0; i < 20; i++) {
			position += 0.25;
			await preparation.tick();
		}
		expect(sendReady).not.toHaveBeenCalled();
		expect(setPosition).toHaveBeenCalledTimes(1);
		expect(input.preparation?.position).toBe(125);

		frame();
		await preparation.tick();
		expect(input.playing).toBe(false);
		expect(status.phase).toBe("waiting-ack");
		expect(sendReady).toHaveBeenCalledOnce();
		// The acknowledgement is the room's saved frame, not wherever this element happened
		// to stop, and the runway is measured from that frame.
		expect(sendReady).toHaveBeenCalledWith({
			id: "resume-one",
			position: 125,
			firstFrame: true,
			bufferAhead: 8.05,
		});
		for (let i = 0; i < 20; i++) {
			await preparation.tick();
		}
		expect(sendReady).toHaveBeenCalledTimes(1);
		// The second seek is the park back onto the saved frame before acknowledging.
		expect(setPosition).toHaveBeenCalledTimes(2);
		expect(setPosition).toHaveBeenLastCalledWith(125);
		input.roomPlaying = true;
		input.preparation = null;
		await preparation.tick();
		expect(status.active).toBe(false);
	});

	it("reports a hidden background tab instead of waiting for the round deadline", async () => {
		input.visible = false;
		await preparation.tick();
		expect(sendReady).toHaveBeenCalledOnce();
		expect(sendReady).toHaveBeenCalledWith({
			id: "resume-one",
			position: 125,
			firstFrame: false,
			visible: false,
		});
		// The report is one-shot for this round, not a message per clock tick.
		await preparation.tick();
		expect(sendReady).toHaveBeenCalledOnce();
		// If the server has not processed the drop yet, coming back must not report again.
		input.visible = true;
		await preparation.tick();
		expect(sendReady).toHaveBeenCalledOnce();
	});

	it("waits for the buffer runway before acknowledging readiness", async () => {
		await preparation.tick();
		position = 125.05;
		input.playing = true;
		input.loading = { phase: null, currentTime: 125.05, bufferAhead: 1 };
		await preparation.tick();
		expect(sendReady).not.toHaveBeenCalled();
		// Waiting paused keeps the picture on the first frame while the runway fills.
		expect(status.phase).toBe("buffering");
		expect(input.playing).toBe(false);

		input.loading = { phase: null, currentTime: 125.05, bufferAhead: 5 };
		await preparation.tick();
		expect(sendReady).toHaveBeenCalledOnce();
	});

	it("waits paused through a slow runway instead of throwing the viewer out", async () => {
		await preparation.tick();
		frame();
		// The frame is on the target but only half a second of runway is buffered.
		input.loading = { phase: null, currentTime: 125.05, bufferAhead: 0.5 };
		await preparation.tick();
		expect(status.phase).toBe("buffering");
		expect(status.priming).toBe(false);
		expect(input.playing).toBe(false);

		// The runway fills slowly. Nothing here may look like a missed frame: the element is
		// measured against the room's start position, not against where it happens to be.
		for (let index = 0; index < 20; index++) {
			clock += 500;
			input.loading = { phase: null, currentTime: 125.05, bufferAhead: 0.5 + index * 0.1 };
			await preparation.tick();
			expect(status.failed).toBe(false);
		}
		expect(sendReady).not.toHaveBeenCalled();
		expect(sendFailed).not.toHaveBeenCalled();
		expect(onError).not.toHaveBeenCalled();

		input.loading = { phase: null, currentTime: 125.05, bufferAhead: 3 };
		await preparation.tick();
		expect(sendReady).toHaveBeenCalledOnce();
		expect(sendReady).toHaveBeenCalledWith({
			id: "resume-one",
			position: 125,
			firstFrame: true,
			bufferAhead: 3.05,
		});
	});

	it("keeps playing when a paused element does not fill its buffer", async () => {
		await preparation.tick();
		frame();
		input.loading = { phase: null, currentTime: 125.05, bufferAhead: 0.5 };
		await preparation.tick();
		expect(status.phase).toBe("buffering");

		// A whole paused window without any growth: this browser stops downloading while
		// paused, so waiting paused can never succeed here.
		clock += 2000;
		await preparation.tick();
		expect(status.phase).toBe("preparing");
		expect(status.priming).toBe(true);

		// It plays on past the target with almost no buffer ahead. Whatever the distance from
		// the target, this stage must never call that a missed frame.
		input.playing = true;
		for (let second = 1; second <= 2; second++) {
			clock += 1000;
			position = 125 + second;
			input.loading = { phase: null, currentTime: 125 + second, bufferAhead: 0.1 };
			input.frameVersion++;
			await preparation.tick();
			expect(status.failed).toBe(false);
			expect(sendReady).not.toHaveBeenCalled();
		}
		expect(onError).not.toHaveBeenCalled();
		expect(sendFailed).not.toHaveBeenCalled();

		// Three seconds past the target the runway measured from it is finally enough.
		clock += 1000;
		position = 128;
		input.loading = { phase: null, currentTime: 128, bufferAhead: 0.1 };
		await preparation.tick();
		expect(status.phase).toBe("waiting-ack");
		expect(input.playing).toBe(false);
		expect(setPosition).toHaveBeenLastCalledWith(125);
		expect(sendReady).toHaveBeenCalledWith({
			id: "resume-one",
			position: 125,
			firstFrame: true,
			bufferAhead: 3.1,
		});
	});

	it("acknowledges a player that lands a tenth of a second off the parked frame", async () => {
		await preparation.tick();
		frame();
		// A player that snaps to a nearby keyframe cannot do better than this.
		setPosition.mockImplementation((target: number) => {
			position = target + 0.1;
		});
		await preparation.tick();
		expect(setPosition).toHaveBeenCalledTimes(2);
		expect(sendReady).toHaveBeenCalledOnce();
		// The acknowledgement says where the element really is, so the server can still
		// reject a viewer that is not on the round's frame.
		expect(sendReady).toHaveBeenCalledWith({
			id: "resume-one",
			position: 125.1,
			firstFrame: true,
			bufferAhead: 8.05,
		});
	});

	it("does not seek in a loop when a player cannot park on the frame at all", async () => {
		await preparation.tick();
		frame();
		setPosition.mockImplementation((target: number) => {
			position = target - 0.5;
		});
		for (let index = 0; index < 5; index++) {
			await preparation.tick();
		}
		// One park attempt only: the server's own deadline decides what happens to a player
		// that cannot land, and no failure is reported for it.
		expect(setPosition).toHaveBeenCalledTimes(2);
		expect(sendReady).not.toHaveBeenCalled();
		expect(sendFailed).not.toHaveBeenCalled();
		expect(onError).not.toHaveBeenCalled();
	});

	it.each([
		["token", { preparation: null }],
		["identity", { clientId: "" }],
	])("accepts a visible frame that arrived before the %s", async (_late, missing) => {
		const token = input.preparation;
		Object.assign(input, missing);
		frame();
		await preparation.tick();
		expect(status.active).toBe(false);
		expect(sendReady).not.toHaveBeenCalled();
		input.preparation = token;
		input.clientId = "alice";
		await preparation.tick();
		expect(sendReady).toHaveBeenCalledOnce();
		expect(sendReady).toHaveBeenCalledWith({
			id: "resume-one",
			position: 125,
			firstFrame: true,
			bufferAhead: 8.05,
		});
	});

	it.each([
		["other-viewer", { clientId: "bob" }],
		["already-playing", { roomPlaying: true }],
		["manually-paused", { preparation: null }],
	])("does not control the room or prime when %s", async (_scenario, update) => {
		Object.assign(input, update);
		frame();
		await preparation.tick();
		expect(status.active).toBe(false);
		expect(sendReady).not.toHaveBeenCalled();
		expect(pause).not.toHaveBeenCalled();
		expect(setPosition).not.toHaveBeenCalled();
	});

	it("requires an actual playing event as well as a frame and API readiness", async () => {
		input.ready = false;
		frame(125.05, false);
		await preparation.tick();
		expect(sendReady).not.toHaveBeenCalled();
		input.ready = true;
		await preparation.tick();
		expect(status.priming).toBe(true);
		expect(sendReady).not.toHaveBeenCalled();
		input.playing = true;
		await preparation.tick();
		expect(sendReady).toHaveBeenCalledTimes(1);
	});

	it("allows initial positioning and priming while a browser waits for play to download", async () => {
		input.recovering = true;
		await preparation.tick();
		expect(setPosition).toHaveBeenCalledWith(125);
		expect(status.priming).toBe(true);
		frame();
		await preparation.tick();
		expect(sendReady).not.toHaveBeenCalled();
		input.recovering = false;
		await preparation.tick();
		expect(sendReady).toHaveBeenCalledOnce();
	});

	it.each([
		"blocked",
		"error",
		"seeking",
		"recovering",
	] as const)("never starts the room while %s", async condition => {
		await preparation.tick();
		frame();
		input[condition] = true;
		await preparation.tick();
		expect(sendReady).not.toHaveBeenCalled();
		input[condition] = false;
		await preparation.tick();
		expect(sendReady).toHaveBeenCalledTimes(1);
	});

	it("rewinds an overdue first frame and reports ready once the saved position has data", async () => {
		await preparation.tick();
		frame(128);
		await preparation.tick();
		expect(setPosition).toHaveBeenCalledTimes(2);
		expect(position).toBe(125);
		expect(sendReady).not.toHaveBeenCalled();
		input.playing = true;
		// Readiness follows the loading state, not another compositor callback: the seek
		// back to the saved position publishes a phase again, and clearing it is the signal.
		input.loading = { phase: "seeking", currentTime: 128, bufferAhead: 8 };
		await preparation.tick();
		expect(sendReady).not.toHaveBeenCalled();
		frame();
		await preparation.tick();
		expect(sendReady).toHaveBeenCalledTimes(1);
	});

	it("stops after two missed-frame realignments and permits an explicit local retry", async () => {
		await preparation.tick();
		for (let i = 0; i < 3; i++) {
			frame(128);
			await preparation.tick();
		}
		expect(status.failed).toBe(true);
		expect(input.playing).toBe(false);
		expect(setPosition).toHaveBeenCalledTimes(3);
		expect(onError).toHaveBeenCalledTimes(1);
		for (let i = 0; i < 10; i++) {
			frame(130);
			await preparation.tick();
		}
		expect(setPosition).toHaveBeenCalledTimes(3);
		expect(sendReady).not.toHaveBeenCalled();
		preparation.retry();
		await preparation.tick();
		frame();
		await preparation.tick();
		expect(status.failed).toBe(false);
		expect(sendReady).toHaveBeenCalledTimes(1);
	});

	function invalidateContext(change: string) {
		if (change === "source") {
			input.source = { ...input.source!, id: "another-video" };
		} else if (change === "player") {
			input.player = {};
		} else if (change === "token") {
			input.preparation = { ...input.preparation!, id: "replacement" };
		} else if (change === "pause") {
			input.preparation = null;
		} else if (change === "disconnect") {
			input.connected = false;
		} else {
			preparation.dispose();
		}
	}

	it.each([
		"source",
		"player",
		"token",
		"pause",
		"disconnect",
		"leave",
	])("discards a late position read after %s", async change => {
		frame();
		let resolve!: (value: number) => void;
		getPosition.mockReturnValueOnce(new Promise<number>(done => (resolve = done)));
		const pending = preparation.tick();
		invalidateContext(change);
		resolve(125.05);
		await pending;
		expect(sendReady).not.toHaveBeenCalled();
		expect(pause).not.toHaveBeenCalled();
	});

	it("cannot revive a token cancelled by an explicit local playback request", async () => {
		frame();
		let resolve!: (value: number) => void;
		getPosition.mockReturnValueOnce(new Promise<number>(done => (resolve = done)));
		const pending = preparation.tick();
		preparation.cancel();
		resolve(125.05);
		await pending;
		await preparation.tick();
		expect(status.active).toBe(false);
		expect(sendReady).not.toHaveBeenCalled();
		input.preparation = { ...input.preparation!, id: "next-preparation" };
		await preparation.tick();
		expect(sendReady).toHaveBeenCalledOnce();
		expect(sendReady).toHaveBeenCalledWith({
			id: "next-preparation",
			position: 125,
			firstFrame: true,
			bufferAhead: 8.05,
		});
	});

	it("rechecks error and token state after the local pause completes", async () => {
		frame();
		let resolve!: () => void;
		pause.mockReturnValueOnce(new Promise<void>(done => (resolve = done)));
		const pending = preparation.tick();
		await Promise.resolve();
		// Parking is the pause-and-seek stage; the acknowledgement only follows it.
		expect(status.phase).toBe("parking");
		input.error = true;
		resolve();
		await pending;
		expect(sendReady).not.toHaveBeenCalled();
	});

	it("rejects a send failure and keeps the browser paused for local retry", async () => {
		frame();
		sendReady.mockImplementation(() => {
			throw new Error("connection disappeared");
		});
		await preparation.tick();
		expect(status.failed).toBe(true);
		expect(input.playing).toBe(false);
		expect(onError).toHaveBeenCalledTimes(1);
	});
});
