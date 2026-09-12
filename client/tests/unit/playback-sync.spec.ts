import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { createPlaybackSync } from "@/util/playback-sync";

describe("room playback synchronization", () => {
	let sync: ReturnType<typeof createPlaybackSync>;
	let state: ReturnType<Parameters<typeof createPlaybackSync>[0]["getState"]>;
	let getPosition: Mock<[], number | Promise<number>>;
	let setPosition: Mock<[number], void | Promise<void>>;
	let onError: Mock<[unknown], void>;

	beforeEach(() => {
		vi.useFakeTimers();
		state = {
			source: { id: "episode-one" },
			player: {},
			ready: true,
			error: false,
			blocked: false,
			seeking: false,
			recovering: false,
			buffering: false,
			playing: true,
			position: 100,
		};
		getPosition = vi.fn<[], number | Promise<number>>(() => 0);
		setPosition = vi.fn<[number], void | Promise<void>>();
		onError = vi.fn<[unknown], void>();
		sync = createPlaybackSync({
			getState: () => ({ ...state }),
			getPosition,
			setPosition,
			onError,
		});
	});
	afterEach(() => {
		sync.dispose();
		vi.useRealTimers();
	});

	it("allows two seconds for an automatic correction to finish before seeking again", async () => {
		await sync.tick();
		for (let i = 0; i < 7; i++) {
			vi.advanceTimersByTime(250);
			await sync.tick();
		}
		expect(setPosition).toHaveBeenCalledTimes(1);
		vi.advanceTimersByTime(250);
		await sync.tick();
		expect(setPosition).toHaveBeenCalledTimes(2);
		getPosition.mockReturnValue(99.5);
		vi.advanceTimersByTime(2000);
		await sync.tick();
		expect(setPosition).toHaveBeenCalledTimes(2);
	});

	it("gives buffering eight seconds without permanently disabling drift correction", async () => {
		state.buffering = true;
		await sync.tick();
		vi.advanceTimersByTime(7999);
		await sync.tick();
		expect(setPosition).toHaveBeenCalledTimes(1);
		vi.advanceTimersByTime(1);
		await sync.tick();
		expect(setPosition).toHaveBeenCalledTimes(2);
		vi.advanceTimersByTime(8000);
		await sync.tick();
		expect(setPosition).toHaveBeenCalledTimes(3);
	});

	it("keeps the buffering grace period when canplay arrives before the download settles", async () => {
		await sync.tick();
		state.buffering = true;
		vi.advanceTimersByTime(1000);
		await sync.tick();
		state.buffering = false;
		vi.advanceTimersByTime(6000);
		await sync.tick();
		expect(setPosition).toHaveBeenCalledTimes(1);
		vi.advanceTimersByTime(1000);
		await sync.tick();
		expect(setPosition).toHaveBeenCalledTimes(2);
	});

	it.each([
		"seeking",
		"recovering",
		"error",
		"blocked",
	] as const)("does not automatically seek while %s", async field => {
		await sync.tick();
		state[field] = true;
		vi.advanceTimersByTime(10000);
		await sync.tick();
		expect(setPosition).toHaveBeenCalledTimes(1);
		expect(getPosition).not.toHaveBeenCalled();
	});

	it("keeps only the latest explicit seek until the API is ready", async () => {
		state.ready = false;
		state.recovering = true;
		await sync.requestSeek();
		state.position = 350;
		await sync.requestSeek();
		expect(setPosition).not.toHaveBeenCalled();
		state.ready = true;
		await sync.tick();
		expect(setPosition).toHaveBeenCalledOnce();
		expect(setPosition).toHaveBeenCalledWith(350);
	});

	it("applies a room seek immediately even during buffering, recovery or an earlier read", async () => {
		await sync.tick();
		setPosition.mockClear();
		vi.advanceTimersByTime(2000);
		let resolve!: (position: number) => void;
		getPosition.mockReturnValue(new Promise<number>(done => (resolve = done)));
		const pendingRead = sync.tick();
		state.buffering = true;
		state.recovering = true;
		state.seeking = true;
		state.position = 400;
		const explicit = sync.requestSeek();
		expect(setPosition).toHaveBeenCalledOnce();
		expect(setPosition).toHaveBeenCalledWith(400);
		resolve(0);
		await Promise.all([pendingRead, explicit]);
		expect(setPosition).toHaveBeenCalledTimes(1);
	});

	it.each([
		"source",
		"player",
	] as const)("does not apply a late read to a replacement %s", async field => {
		await sync.tick();
		setPosition.mockClear();
		vi.advanceTimersByTime(2000);
		let resolve!: (position: number) => void;
		getPosition.mockReturnValue(new Promise<number>(done => (resolve = done)));
		const pending = sync.tick();
		state[field] = { id: "replacement" };
		state.position = 20;
		resolve(0);
		await pending;
		expect(setPosition).not.toHaveBeenCalled();
		await sync.tick();
		expect(setPosition).toHaveBeenCalledOnce();
		expect(setPosition).toHaveBeenCalledWith(20);
	});

	it("does not overlap position reads and rechecks recovery after an awaited read", async () => {
		await sync.tick();
		vi.advanceTimersByTime(2000);
		let resolve!: (position: number) => void;
		getPosition.mockReturnValue(new Promise<number>(done => (resolve = done)));
		const pending = sync.tick();
		await sync.tick();
		expect(getPosition).toHaveBeenCalledOnce();
		state.recovering = true;
		resolve(0);
		await pending;
		expect(setPosition).toHaveBeenCalledTimes(1);
	});

	it("handles asynchronous player failures and cancels work after disposal", async () => {
		setPosition.mockRejectedValueOnce(new Error("seek failed"));
		await sync.tick();
		expect(onError).toHaveBeenCalledOnce();
		vi.advanceTimersByTime(2000);
		getPosition.mockRejectedValueOnce(new Error("read failed"));
		await sync.tick();
		expect(onError).toHaveBeenCalledTimes(2);
		let resolve!: (position: number) => void;
		getPosition.mockReturnValue(new Promise<number>(done => (resolve = done)));
		const pending = sync.tick();
		sync.dispose();
		resolve(0);
		await pending;
		await sync.requestSeek();
		expect(setPosition).toHaveBeenCalledTimes(1);
	});
});

describe("native playback rate correction", () => {
	let sync: ReturnType<typeof createPlaybackSync>;
	let state: ReturnType<Parameters<typeof createPlaybackSync>[0]["getState"]>;
	let base: number | null;
	let getPosition: Mock<[], number | Promise<number>>;
	let setPosition: Mock<[number], void | Promise<void>>;
	let setLocalRate: Mock<[number], void | Promise<void>>;
	let onError: Mock<[unknown], void>;

	beforeEach(async () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		base = 1;
		state = {
			source: {},
			player: {},
			ready: true,
			error: false,
			blocked: false,
			seeking: false,
			recovering: false,
			buffering: false,
			playing: true,
			position: 100,
		};
		getPosition = vi.fn<[], number | Promise<number>>(() => 99.6);
		setPosition = vi.fn<[number], void | Promise<void>>();
		setLocalRate = vi.fn<[number], void | Promise<void>>();
		onError = vi.fn<[unknown], void>();
		sync = createPlaybackSync({
			getState: () => ({ ...state }),
			getPosition,
			setPosition,
			getBendBase: () => base,
			setLocalRate,
			onError,
		});
		await sync.tick(); // Initial source alignment is always an explicit seek.
		setPosition.mockClear();
	});

	afterEach(() => {
		sync.dispose();
		vi.useRealTimers();
	});

	it("starts above 300 ms, remains active below that threshold, and stops at 150 ms", async () => {
		getPosition.mockReturnValue(99.71);
		await sync.tick();
		expect(setLocalRate).not.toHaveBeenCalled();
		getPosition.mockReturnValue(99.69);
		await sync.tick();
		expect(setLocalRate).toHaveBeenLastCalledWith(expect.closeTo(1.0496, 6));
		getPosition.mockReturnValue(99.8);
		await sync.tick();
		expect(setLocalRate).toHaveBeenLastCalledWith(expect.closeTo(1.032, 6));
		getPosition.mockReturnValue(99.85);
		await sync.tick();
		expect(setLocalRate).toHaveBeenLastCalledWith(1);
		getPosition.mockReturnValue(99.8);
		await sync.tick();
		expect(setLocalRate).toHaveBeenCalledTimes(3);
		expect(setPosition).not.toHaveBeenCalled();
	});

	it.each([
		[0.5, 1.08],
		[0.8, 1.08],
		[-0.31, 0.9504],
		[-0.5, 0.92],
		[-0.8, 0.92],
	])("corrects a %s second drift at a bounded rate of %s", async (drift, rate) => {
		getPosition.mockReturnValue(100 - drift);
		await sync.tick();
		expect(setLocalRate).toHaveBeenLastCalledWith(expect.closeTo(rate, 6));
	});

	it.each([0.25, 1.5, 4])("multiplies the room's %sx speed", async rate => {
		base = rate;
		await sync.tick();
		expect(setLocalRate).toHaveBeenLastCalledWith(expect.closeTo(rate * 1.064, 6));
	});

	it("keeps observing and changing rates during the seek cooldown", async () => {
		for (const position of [99.6, 99.65, 99.7]) {
			getPosition.mockReturnValue(position);
			vi.advanceTimersByTime(250);
			await sync.tick();
		}
		expect(getPosition).toHaveBeenCalledTimes(3);
		expect(setLocalRate).toHaveBeenCalledTimes(3);
		expect(setLocalRate).toHaveBeenLastCalledWith(expect.closeTo(1.048, 6));
		expect(setPosition).not.toHaveBeenCalled();
	});

	it("does not repeatedly write the same rate or changes smaller than 0.002", async () => {
		await sync.tick();
		await sync.tick();
		getPosition.mockReturnValue(99.605);
		await sync.tick();
		expect(setLocalRate).toHaveBeenCalledOnce();
	});

	it("cancels the bend before a drift larger than one second triggers a seek", async () => {
		await sync.tick();
		getPosition.mockReturnValue(98);
		vi.advanceTimersByTime(2000);
		await sync.tick();
		expect(setLocalRate).toHaveBeenLastCalledWith(1);
		expect(setPosition).toHaveBeenCalledOnce();
		expect(setPosition).toHaveBeenCalledWith(100);
		expect(setLocalRate.mock.invocationCallOrder[1]).toBeLessThan(
			setPosition.mock.invocationCallOrder[0],
		);
	});

	it("bends a large drift while a buffering seek is still cooling down", async () => {
		state.buffering = true;
		getPosition.mockReturnValue(98);
		vi.advanceTimersByTime(250);
		await sync.tick();
		expect(setLocalRate).toHaveBeenLastCalledWith(1.08);
		vi.advanceTimersByTime(7500);
		await sync.tick();
		expect(setPosition).not.toHaveBeenCalled();
		vi.advanceTimersByTime(250);
		await sync.tick();
		expect(setLocalRate).toHaveBeenLastCalledWith(1);
		expect(setPosition).toHaveBeenCalledOnce();
	});

	it.each([
		"playing",
		"ready",
		"blocked",
		"seeking",
		"recovering",
		"error",
	] as const)("restores the base rate when %s prevents bending", async field => {
		await sync.tick();
		state[field] = field !== "playing" && field !== "ready";
		await sync.tick();
		await sync.tick();
		expect(setLocalRate).toHaveBeenLastCalledWith(1);
		expect(setLocalRate).toHaveBeenCalledTimes(2);
	});

	it("suspends during temporary 2x and reapplies the restored room base afterwards", async () => {
		await sync.tick();
		base = 2;
		state.temporarySpeed = true;
		sync.invalidateRate();
		await sync.tick();
		expect(setLocalRate).toHaveBeenLastCalledWith(2);
		expect(setLocalRate).toHaveBeenCalledTimes(2);
		base = 1;
		state.temporarySpeed = false;
		sync.invalidateRate();
		await sync.tick();
		expect(setLocalRate).toHaveBeenLastCalledWith(expect.closeTo(1.064, 6));
	});

	it("does not send any rate to an unsupported player, even when seeking", async () => {
		base = null;
		await sync.tick();
		getPosition.mockReturnValue(98);
		vi.advanceTimersByTime(2000);
		await sync.tick();
		expect(setLocalRate).not.toHaveBeenCalled();
		expect(setPosition).toHaveBeenCalledOnce();
	});

	it("falls back after eight seconds and refreshes the hard-seek cooldown", async () => {
		await sync.tick();
		vi.advanceTimersByTime(7999);
		await sync.tick();
		expect(setPosition).not.toHaveBeenCalled();
		vi.advanceTimersByTime(1);
		await sync.tick();
		expect(setLocalRate).toHaveBeenLastCalledWith(1);
		expect(setPosition).toHaveBeenCalledOnce();
		expect(setLocalRate.mock.invocationCallOrder[1]).toBeLessThan(
			setPosition.mock.invocationCallOrder[0],
		);
		getPosition.mockReturnValue(98);
		vi.advanceTimersByTime(1999);
		await sync.tick();
		expect(setPosition).toHaveBeenCalledTimes(1);
		vi.advanceTimersByTime(1);
		await sync.tick();
		expect(setPosition).toHaveBeenCalledTimes(2);
	});

	it("clears the deadline when a bend converges", async () => {
		await sync.tick();
		vi.advanceTimersByTime(7000);
		getPosition.mockReturnValue(99.9);
		await sync.tick();
		vi.advanceTimersByTime(1500);
		getPosition.mockReturnValue(99.6);
		await sync.tick();
		expect(setPosition).not.toHaveBeenCalled();
		expect(setLocalRate).toHaveBeenLastCalledWith(expect.closeTo(1.064, 6));
	});

	it.each([
		"reset",
		"requestSeek",
		"dispose",
	] as const)("restores the base rate on %s", async method => {
		await sync.tick();
		await sync[method]();
		expect(setLocalRate).toHaveBeenLastCalledWith(1);
	});

	it.each(["source", "player"] as const)("clears the bend on a new %s", async field => {
		await sync.tick();
		state[field] = {};
		await sync.tick();
		expect(setLocalRate).toHaveBeenLastCalledWith(1);
		expect(setPosition).toHaveBeenCalledOnce();
	});

	it("invalidates a rate overwritten by the room and discards the preceding position read", async () => {
		await sync.tick();
		let resolve!: (position: number) => void;
		getPosition.mockReturnValueOnce(new Promise<number>(done => (resolve = done)));
		const pending = sync.tick();
		base = 1.5;
		sync.invalidateRate();
		resolve(99.3);
		await pending;
		expect(setLocalRate).toHaveBeenLastCalledWith(1.5);
		await sync.tick();
		expect(setLocalRate).toHaveBeenLastCalledWith(expect.closeTo(1.596, 6));
	});

	it("handles rejected native rate writes", async () => {
		setLocalRate.mockRejectedValueOnce(new Error("rate failed"));
		await sync.tick();
		expect(onError).toHaveBeenCalledOnce();
		await sync.tick();
		expect(setLocalRate).toHaveBeenCalledTimes(2);
	});
});
