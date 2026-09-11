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
