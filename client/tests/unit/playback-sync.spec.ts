import { PLAYBACK_INITIAL_SYNC_COOLDOWN_MS } from "ott-common/constants";
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
			// These tests are about cooldowns, gating and read ordering, not the seek lead.
			initialSeekLeadSeconds: { load: 0, seek: 0 },
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
		// A drift just above the native dead band still waits out the full cooldown.
		getPosition.mockReturnValue(99.6);
		vi.advanceTimersByTime(1999);
		await sync.tick();
		expect(setPosition).toHaveBeenCalledTimes(2);
		vi.advanceTimersByTime(1);
		await sync.tick();
		expect(setPosition).toHaveBeenCalledTimes(3);
	});

	it("suspends drift correction entirely while the element is buffering", async () => {
		await sync.tick();
		setPosition.mockClear();
		getPosition.mockClear();
		state.buffering = true;
		vi.advanceTimersByTime(30000);
		await sync.tick();
		// A stopped clock cannot drift: no reads, no seeks, no matter the waiting time.
		expect(getPosition).not.toHaveBeenCalled();
		expect(setPosition).not.toHaveBeenCalled();
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

	it("leaves live media on its own timeline instead of seeking it to the VOD clock", async () => {
		state.live = true;
		getPosition.mockReturnValue(0);
		await sync.tick();
		expect(setPosition).not.toHaveBeenCalled();
		expect(getPosition).not.toHaveBeenCalled();
	});

	it("seeks a paused native player that sits a tenth of a second from the room frame", async () => {
		await sync.tick();
		setPosition.mockClear();
		state.playing = false;
		getPosition.mockReturnValue(99.9);

		// No cooldown wait: a paused element has no audio to flush, so it can land on the
		// room's frame immediately instead of freezing a fraction of a second away.
		await sync.tick();

		expect(setPosition).toHaveBeenCalledOnce();
		expect(setPosition).toHaveBeenCalledWith(100);
	});

	it("leaves a paused native player alone within one frame of the room position", async () => {
		await sync.tick();
		setPosition.mockClear();
		state.playing = false;
		getPosition.mockReturnValue(99.98);

		await sync.tick();
		await sync.requestSeek("room-sync", { tolerateSmallDrift: true });

		expect(setPosition).not.toHaveBeenCalled();
	});

	it("corrects a paused native drift right after a pause message", async () => {
		await sync.tick();
		setPosition.mockClear();
		state.playing = false;
		getPosition.mockReturnValue(99.9);

		await sync.requestSeek("room-sync", { tolerateSmallDrift: true });

		expect(setPosition).toHaveBeenCalledOnce();
		expect(setPosition).toHaveBeenCalledWith(100);
	});

	it("tries each paused frame only once", async () => {
		await sync.tick();
		setPosition.mockClear();
		state.playing = false;
		// A player that snaps to a keyframe stays this far away after the seek.
		getPosition.mockReturnValue(99.5);

		await sync.requestSeek("room-sync", { tolerateSmallDrift: true });
		await sync.requestSeek("room-sync", { tolerateSmallDrift: true });
		vi.advanceTimersByTime(250);
		await sync.tick();

		expect(setPosition).toHaveBeenCalledOnce();
	});

	it("keeps an embedded player's one-second dead band while the room is paused", async () => {
		const embedded = createPlaybackSync({
			getState: () => ({ ...state, playing: false }),
			getPosition,
			setPosition,
			getBendBase: () => null,
			seekIsExpensive: () => true,
			onError,
		});
		await embedded.tick();
		setPosition.mockClear();
		getPosition.mockReturnValue(99.5);

		await embedded.tick();
		await embedded.requestSeek("room-sync", { tolerateSmallDrift: true });

		expect(setPosition).not.toHaveBeenCalled();
		embedded.dispose();
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
			// A zero lead keeps these rate assertions about the bend, not the seek.
			initialSeekLeadSeconds: { load: 0, seek: 0 },
			onError,
		});
		await sync.tick(); // Initial source alignment is always an explicit seek.
		setPosition.mockClear();
	});

	afterEach(() => {
		sync.dispose();
		vi.useRealTimers();
	});

	it("starts above 300 ms, holds one rate, and stops at 150 ms", async () => {
		getPosition.mockReturnValue(99.71);
		await sync.tick();
		expect(setLocalRate).not.toHaveBeenCalled();
		getPosition.mockReturnValue(99.69);
		await sync.tick();
		expect(setLocalRate).toHaveBeenLastCalledWith(1.08);
		getPosition.mockReturnValue(99.8);
		await sync.tick();
		// Still catching up: the held 8% is not re-written as the drift shrinks.
		expect(setLocalRate).toHaveBeenLastCalledWith(1.08);
		expect(setLocalRate).toHaveBeenCalledOnce();
		getPosition.mockReturnValue(99.85);
		await sync.tick();
		expect(setLocalRate).toHaveBeenLastCalledWith(1);
		getPosition.mockReturnValue(99.8);
		await sync.tick();
		expect(setLocalRate).toHaveBeenCalledTimes(2);
		expect(setPosition).not.toHaveBeenCalled();
	});

	it.each([
		[0.5, 1.08],
		[0.8, 1.08],
		[-0.31, 0.92],
		[-0.5, 0.92],
		[-0.8, 0.92],
	])("corrects a %s second drift at a bounded rate of %s", async (drift, rate) => {
		getPosition.mockReturnValue(100 - drift);
		await sync.tick();
		expect(setLocalRate).toHaveBeenLastCalledWith(expect.closeTo(rate, 6));
	});

	it.each([
		[1.5, 1.0975],
		[2, 1.115],
		[3, 1.15],
	])("catches up a %s second drift instead of seeking", async (drift, rate) => {
		getPosition.mockReturnValue(100 - drift);
		await sync.tick();
		expect(setLocalRate).toHaveBeenLastCalledWith(expect.closeTo(rate, 6));
		expect(setPosition).not.toHaveBeenCalled();
		// Still catching up after the gentle deadline would have expired.
		vi.advanceTimersByTime(10000);
		await sync.tick();
		expect(setPosition).not.toHaveBeenCalled();
	});

	it.each([0.25, 1.5, 4])("multiplies the room's %sx speed", async rate => {
		base = rate;
		await sync.tick();
		expect(setLocalRate).toHaveBeenLastCalledWith(expect.closeTo(rate * 1.08, 6));
	});

	it("keeps observing during the seek cooldown and holds one rate", async () => {
		for (const position of [99.6, 99.65, 99.7]) {
			getPosition.mockReturnValue(position);
			vi.advanceTimersByTime(250);
			await sync.tick();
		}
		expect(getPosition).toHaveBeenCalledTimes(3);
		expect(setLocalRate).toHaveBeenCalledOnce();
		expect(setLocalRate).toHaveBeenLastCalledWith(1.08);
		expect(setPosition).not.toHaveBeenCalled();
	});

	it("does not repeatedly write the same rate or changes smaller than 0.002", async () => {
		await sync.tick();
		await sync.tick();
		getPosition.mockReturnValue(99.605);
		await sync.tick();
		expect(setLocalRate).toHaveBeenCalledOnce();
	});

	it("cancels the bend before a drift larger than three seconds triggers a seek", async () => {
		await sync.tick();
		// Leave the post-join grace period so the normal three-second threshold applies.
		vi.advanceTimersByTime(PLAYBACK_INITIAL_SYNC_COOLDOWN_MS + 100);
		getPosition.mockReturnValue(96);
		vi.advanceTimersByTime(2000);
		await sync.tick();
		expect(setLocalRate).toHaveBeenLastCalledWith(1);
		expect(setPosition).toHaveBeenCalledOnce();
		expect(setPosition).toHaveBeenCalledWith(100);
		expect(setLocalRate.mock.invocationCallOrder[1]).toBeLessThan(
			setPosition.mock.invocationCallOrder[0],
		);
	});

	it("seeks a large drift while the room is paused", async () => {
		await sync.tick();
		state.playing = false;
		getPosition.mockReturnValue(98);
		vi.advanceTimersByTime(2000);
		await sync.tick();
		expect(setPosition).toHaveBeenCalledOnce();
		expect(setPosition).toHaveBeenCalledWith(100);
	});

	it("uses the tight native dead band when the player has no rate setter", async () => {
		base = null;
		getPosition.mockReturnValue(99.6);
		vi.advanceTimersByTime(2000);
		await sync.tick();
		expect(setPosition).toHaveBeenCalledWith(100);
	});

	it("does not reload an embedded player for sub-second drift", async () => {
		const embedded = createPlaybackSync({
			getState: () => ({ ...state }),
			getPosition,
			setPosition,
			getBendBase: () => null,
			seekIsExpensive: () => true,
			onError,
		});
		await embedded.tick();
		setPosition.mockClear();

		getPosition.mockReturnValue(99.4);
		vi.advanceTimersByTime(2000);
		await embedded.tick();
		expect(setPosition).not.toHaveBeenCalled();

		getPosition.mockReturnValue(98.6);
		vi.advanceTimersByTime(2000);
		await embedded.tick();
		expect(setPosition).toHaveBeenCalledWith(100);
		embedded.dispose();
	});

	it("applies the same expensive-seek dead band to a room sync", async () => {
		const embedded = createPlaybackSync({
			getState: () => ({ ...state }),
			getPosition,
			setPosition,
			getBendBase: () => null,
			seekIsExpensive: () => true,
			onError,
		});
		await embedded.tick();
		setPosition.mockClear();

		getPosition.mockReturnValue(99.4);
		await embedded.requestSeek("room-sync", { tolerateSmallDrift: true });
		expect(setPosition).not.toHaveBeenCalled();

		getPosition.mockReturnValue(98.6);
		await embedded.requestSeek("room-sync", { tolerateSmallDrift: true });
		expect(setPosition).toHaveBeenCalledWith(100);
		embedded.dispose();
	});

	it("absorbs a room sync drift up to three seconds instead of seeking", async () => {
		await sync.tick();
		setPosition.mockClear();
		getPosition.mockReturnValue(97.5);
		await sync.requestSeek("room-sync", { tolerateSmallDrift: true });
		expect(setPosition).not.toHaveBeenCalled();
		getPosition.mockReturnValue(96);
		await sync.requestSeek("room-sync", { tolerateSmallDrift: true });
		expect(setPosition).toHaveBeenCalledOnce();
	});

	it("pauses the bend while the element is buffering and resumes it on recovery", async () => {
		getPosition.mockReturnValue(99.6);
		state.buffering = true;
		vi.advanceTimersByTime(250);
		await sync.tick();
		// A stopped clock cannot drift: no rate, no seek.
		expect(setLocalRate).not.toHaveBeenCalled();
		expect(setPosition).not.toHaveBeenCalled();
		state.buffering = false;
		vi.advanceTimersByTime(250);
		await sync.tick();
		expect(setLocalRate).toHaveBeenLastCalledWith(1.08);
		expect(setPosition).not.toHaveBeenCalled();
	});

	it("keeps the longer seek cooldown once a buffering source recovers", async () => {
		state.buffering = true;
		vi.advanceTimersByTime(250);
		await sync.tick();
		state.buffering = false;
		getPosition.mockReturnValue(96);
		vi.advanceTimersByTime(250);
		await sync.tick();
		// 4 s of drift cannot be bent away, but the seek still waits out the cooldown.
		expect(setLocalRate).toHaveBeenLastCalledWith(expect.closeTo(1.15, 6));
		expect(setPosition).not.toHaveBeenCalled();
		vi.advanceTimersByTime(8000);
		await sync.tick();
		expect(setPosition).toHaveBeenCalledOnce();
		expect(setPosition).toHaveBeenCalledWith(100);
	});

	it.each([
		"playing",
		"ready",
		"blocked",
		"seeking",
		"recovering",
		"error",
		"buffering",
	] as const)("restores the base rate when %s prevents bending", async field => {
		await sync.tick();
		state[field] = field !== "playing" && field !== "ready";
		await sync.tick();
		await sync.tick();
		expect(setLocalRate).toHaveBeenLastCalledWith(1);
		expect(setLocalRate).toHaveBeenCalledTimes(2);
	});

	it("counts rate writes and deadline fallbacks for the diagnostics panel", async () => {
		const before = sync.getMetrics();
		expect(before.deadlineSeeks).toBe(0);
		getPosition.mockReturnValue(99.69);
		await sync.tick();
		expect(sync.getMetrics().rateWrites).toBe(before.rateWrites + 1);
		// A catch-up the bend cannot finish expires into the visible seek.
		getPosition.mockReturnValue(98.5);
		vi.advanceTimersByTime(250);
		await sync.tick();
		vi.advanceTimersByTime(30000);
		await sync.tick();
		expect(sync.getMetrics().deadlineSeeks).toBe(1);
		expect(setPosition).toHaveBeenCalledWith(100);
		// The 1.5s catch-up is the largest drift this source saw.
		expect(sync.getMetrics().maxAbsDrift).toBeCloseTo(1.5, 6);
		sync.resetMetrics();
		// The seek-latency estimates are state, not counters, so only the counters are compared.
		const counters = sync.getMetrics();
		expect({
			rateWrites: counters.rateWrites,
			deadlineSeeks: counters.deadlineSeeks,
			maxAbsDrift: counters.maxAbsDrift,
			driftSeconds: counters.driftSeconds,
			bendSeconds: counters.bendSeconds,
		}).toEqual({
			rateWrites: 0,
			deadlineSeeks: 0,
			maxAbsDrift: 0,
			driftSeconds: [0, 0, 0, 0, 0, 0],
			bendSeconds: 0,
		});
	});

	it("does not write rates at all when the preference disables bending", async () => {
		const local = createPlaybackSync({
			getState: () => ({ ...state }),
			getPosition,
			setPosition,
			getBendBase: () => base,
			setLocalRate,
			allowRateBend: () => false,
			initialSeekLeadSeconds: { load: 0, seek: 0 },
			onError,
		});
		await local.tick();
		setPosition.mockClear();
		// A drift that would bend if the switch were on stays untouched...
		getPosition.mockReturnValue(99.6);
		vi.advanceTimersByTime(2000);
		await local.tick();
		expect(setLocalRate).not.toHaveBeenCalled();
		// ...and beyond one second the coarser seek path still corrects it.
		getPosition.mockReturnValue(98.5);
		vi.advanceTimersByTime(2000);
		await local.tick();
		expect(setPosition).toHaveBeenCalledWith(100);
		expect(local.getMetrics().rateWrites).toBe(0);
		local.dispose();
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
		expect(setLocalRate).toHaveBeenLastCalledWith(1.08);
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
		getPosition.mockReturnValue(96);
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
		expect(setLocalRate).toHaveBeenLastCalledWith(1.08);
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
		expect(setLocalRate).toHaveBeenLastCalledWith(1.62);
	});

	it("handles rejected native rate writes", async () => {
		setLocalRate.mockRejectedValueOnce(new Error("rate failed"));
		await sync.tick();
		expect(onError).toHaveBeenCalledOnce();
		await sync.tick();
		expect(setLocalRate).toHaveBeenCalledTimes(2);
	});
});

describe("drift and bend telemetry", () => {
	let sync: ReturnType<typeof createPlaybackSync>;
	let state: ReturnType<Parameters<typeof createPlaybackSync>[0]["getState"]>;
	let playerPosition: number;
	let base: number | null;

	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		base = 1;
		playerPosition = 100;
		state = {
			source: { id: "telemetry" },
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
		sync = createPlaybackSync({
			getState: () => ({ ...state }),
			getPosition: () => playerPosition,
			setPosition: () => undefined,
			getBendBase: () => base,
			setLocalRate: () => undefined,
			onError: () => undefined,
		});
	});
	afterEach(() => {
		sync.dispose();
		vi.useRealTimers();
	});

	function distributed() {
		return sync.getMetrics().driftSeconds.reduce((total, seconds) => total + seconds, 0);
	}

	/** The first tick of a source only seeks; drift is credited from the next observation on. */
	async function start() {
		await sync.tick();
		vi.advanceTimersByTime(250);
		await sync.tick();
	}

	async function observe(drift: number, ticks: number) {
		playerPosition = state.position - drift;
		for (let index = 0; index < ticks; index++) {
			vi.advanceTimersByTime(250);
			await sync.tick();
		}
	}

	it("credits the time between observations to the bucket the drift falls in", async () => {
		await start();
		await observe(0.02, 4);
		await observe(0.06, 4);
		await observe(0.5, 4);

		const metrics = sync.getMetrics();
		expect(metrics.driftSeconds[0]).toBeCloseTo(1, 6);
		expect(metrics.driftSeconds[1]).toBeCloseTo(1, 6);
		expect(metrics.driftSeconds[4]).toBeCloseTo(1, 6);
		// Drift inside the 150-300ms bucket never happened here.
		expect(metrics.driftSeconds[2]).toBe(0);
		expect(distributed()).toBeCloseTo(3, 6);
	});

	it("caps one observation at a second so a throttled tab cannot credit its gap", async () => {
		await start();
		vi.advanceTimersByTime(30_000);
		await sync.tick();
		expect(distributed()).toBeCloseTo(1, 6);
	});

	it("credits nothing while the room is paused or the element is stalled", async () => {
		await start();
		playerPosition = 99.98;
		state.playing = false;
		for (let index = 0; index < 8; index++) {
			vi.advanceTimersByTime(250);
			await sync.tick();
		}
		expect(distributed()).toBe(0);

		state.playing = true;
		state.buffering = true;
		for (let index = 0; index < 8; index++) {
			vi.advanceTimersByTime(250);
			await sync.tick();
		}
		expect(distributed()).toBe(0);

		// The first observation after the gap only re-anchors the chain...
		state.buffering = false;
		vi.advanceTimersByTime(250);
		await sync.tick();
		expect(distributed()).toBe(0);
		// ...and the one after it is credited again.
		vi.advanceTimersByTime(250);
		await sync.tick();
		expect(sync.getMetrics().driftSeconds[0]).toBeCloseTo(0.25, 6);
	});

	it("counts only the time during which a rate bend is applied", async () => {
		await start();
		// The tick that starts the bend is still credited to the unbent interval it ends,
		// so 5 ticks at 250ms leave one second of bend.
		await observe(0.5, 5);
		expect(sync.getMetrics().bendSeconds).toBeCloseTo(1, 6);

		// The interval that ends the bend was still bent; after that its clock stops.
		await observe(0.1, 4);
		expect(sync.getMetrics().bendSeconds).toBeCloseTo(1.25, 6);
		await observe(0.1, 4);
		expect(sync.getMetrics().bendSeconds).toBeCloseTo(1.25, 6);
		// The drift itself is still distributed, just without bend time.
		expect(sync.getMetrics().driftSeconds[2]).toBeCloseTo(2, 6);
	});

	it("resets both counters and starts a new observation chain", async () => {
		await start();
		await observe(0.02, 4);
		expect(distributed()).toBeCloseTo(1, 6);

		sync.resetMetrics();
		expect(sync.getMetrics().driftSeconds).toEqual([0, 0, 0, 0, 0, 0]);
		expect(sync.getMetrics().bendSeconds).toBe(0);

		// The reset broke the chain, so the first observation after it adds nothing.
		await observe(0.02, 1);
		expect(distributed()).toBe(0);
		await observe(0.02, 1);
		expect(distributed()).toBeCloseTo(0.25, 6);
	});
});

describe("hard-seek latency lead", () => {
	let sync: ReturnType<typeof createPlaybackSync>;
	let state: ReturnType<Parameters<typeof createPlaybackSync>[0]["getState"]>;
	let base: number | null;
	let playerPosition: number;
	let getPosition: Mock<[], number | Promise<number>>;
	let setPosition: Mock<[number], void | Promise<void>>;
	let setLocalRate: Mock<[number], void | Promise<void>>;

	function build(overrides: Partial<Parameters<typeof createPlaybackSync>[0]> = {}) {
		return createPlaybackSync({
			getState: () => ({ ...state }),
			getPosition,
			setPosition,
			getBendBase: () => base,
			setLocalRate,
			// Round numbers for the arithmetic below; the shipped starting points have their
			// own test at the end of this block.
			initialSeekLeadSeconds: { load: 1, seek: 0.3 },
			onError: () => undefined,
			...overrides,
		});
	}

	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		base = 1;
		playerPosition = 100;
		state = {
			source: { id: "lead" },
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
		getPosition = vi.fn<[], number | Promise<number>>(() => playerPosition);
		setPosition = vi.fn<[number], void | Promise<void>>();
		setLocalRate = vi.fn<[number], void | Promise<void>>();
		sync = build();
	});
	afterEach(() => {
		sync.dispose();
		vi.useRealTimers();
	});

	it("leads a playing native seek by the cold-load and then the jump estimate", async () => {
		await sync.tick();
		// A new source pays for fetching a whole load, not just the region it jumps into.
		expect(setPosition).toHaveBeenLastCalledWith(expect.closeTo(101, 6));
		await sync.requestSeek("room-sync");
		expect(setPosition).toHaveBeenLastCalledWith(expect.closeTo(100.3, 6));
	});

	it("multiplies the lead by the room speed", async () => {
		base = 2;
		await sync.tick();
		expect(setPosition).toHaveBeenLastCalledWith(expect.closeTo(102, 6));
		await sync.requestSeek("room-sync");
		expect(setPosition).toHaveBeenLastCalledWith(expect.closeTo(100.6, 6));
	});

	it("keeps today's exact target while the room is paused", async () => {
		state.playing = false;
		await sync.requestSeek("room-sync");
		expect(setPosition).toHaveBeenCalledWith(100);
	});

	it("keeps today's exact target for an embedded player", async () => {
		const embedded = build({ getBendBase: () => null, seekIsExpensive: () => true });
		await embedded.tick();
		expect(setPosition).toHaveBeenLastCalledWith(100);
		embedded.dispose();
	});

	it("does not seek a live source ahead of its own edge", async () => {
		state.live = true;
		await sync.tick();
		await sync.requestSeek("room-sync");
		expect(setPosition).not.toHaveBeenCalled();
	});

	it("uses the configured estimates for the cold seek and the warm ones after it", async () => {
		const custom = build({ initialSeekLeadSeconds: { load: 2, seek: 0.5 } });
		await custom.tick();
		expect(setPosition).toHaveBeenLastCalledWith(expect.closeTo(102, 6));
		await custom.requestSeek("room-sync");
		expect(setPosition).toHaveBeenLastCalledWith(expect.closeTo(100.5, 6));
		// Another source on the same device starts cold again.
		custom.reset();
		await custom.tick();
		expect(setPosition).toHaveBeenLastCalledWith(expect.closeTo(102, 6));
		custom.dispose();
	});

	it("raises the estimate that was used when the seek leaves the player behind", async () => {
		await sync.tick();
		// The player resumed 0.4s behind the target: the latency was underestimated.
		playerPosition = 99.6;
		vi.advanceTimersByTime(250);
		await sync.tick();
		expect(sync.getMetrics().loadLeadSeconds).toBeCloseTo(1.2, 6);
		// The warm estimate was never used, so it is untouched.
		expect(sync.getMetrics().seekLeadSeconds).toBeCloseTo(0.3, 6);
	});

	it("lowers the estimate when the seek overshoots the room", async () => {
		await sync.tick();
		await sync.requestSeek("room-sync");
		// The player landed 0.4s ahead: the latency was overestimated.
		playerPosition = 100.4;
		vi.advanceTimersByTime(250);
		await sync.tick();
		expect(sync.getMetrics().seekLeadSeconds).toBeCloseTo(0.1, 6);
	});

	it("waits for an observable read before learning", async () => {
		await sync.tick();
		// A native element reports seeking right after the seek; that read is not evidence.
		state.seeking = true;
		playerPosition = 99.6;
		vi.advanceTimersByTime(250);
		await sync.tick();
		expect(sync.getMetrics().loadLeadSeconds).toBeCloseTo(1, 6);

		state.seeking = false;
		vi.advanceTimersByTime(250);
		await sync.tick();
		expect(sync.getMetrics().loadLeadSeconds).toBeCloseTo(1.2, 6);
	});

	it("drops the pending learning when the room pauses", async () => {
		await sync.tick();
		state.playing = false;
		vi.advanceTimersByTime(250);
		await sync.tick();
		state.playing = true;
		playerPosition = 99.6;
		vi.advanceTimersByTime(250);
		await sync.tick();
		expect(sync.getMetrics().loadLeadSeconds).toBeCloseTo(1, 6);
	});

	it("learns once per seek", async () => {
		await sync.tick();
		playerPosition = 99.6;
		vi.advanceTimersByTime(250);
		await sync.tick();
		expect(sync.getMetrics().loadLeadSeconds).toBeCloseTo(1.2, 6);
		vi.advanceTimersByTime(250);
		await sync.tick();
		vi.advanceTimersByTime(250);
		await sync.tick();
		expect(sync.getMetrics().loadLeadSeconds).toBeCloseTo(1.2, 6);
	});

	it.each([
		[-3, 0],
		[3, 3],
	])("clamps the learned estimate for a %s second error into 0-3s", async (error, expected) => {
		const clamped = build({
			initialSeekLeadSeconds: { load: 0, seek: error < 0 ? 0 : 2.9 },
		});
		await clamped.tick();
		await clamped.requestSeek("room-sync");
		playerPosition = 100 - error;
		vi.advanceTimersByTime(250);
		await clamped.tick();
		expect(clamped.getMetrics().seekLeadSeconds).toBeCloseTo(expected, 6);
		clamped.dispose();
	});

	it("keeps both estimates across a reset", async () => {
		await sync.tick();
		playerPosition = 99.6;
		vi.advanceTimersByTime(250);
		await sync.tick();
		const learned = sync.getMetrics().loadLeadSeconds;
		expect(learned).toBeCloseTo(1.2, 6);
		sync.reset();
		expect(sync.getMetrics().loadLeadSeconds).toBeCloseTo(learned, 6);
		expect(sync.getMetrics().seekLeadSeconds).toBeCloseTo(0.3, 6);
	});

	it("starts from conservative estimates before the device has taught it anything", async () => {
		sync.dispose();
		sync = build({ initialSeekLeadSeconds: undefined });
		// An overestimate leaves the viewer ahead of the room, which only a slow-down can
		// undo, so the cold start leans low.
		expect(sync.getMetrics().loadLeadSeconds).toBe(0.5);
		expect(sync.getMetrics().seekLeadSeconds).toBe(0.3);
	});

	it("scales the lead by the room speed even when this viewer has bending switched off", async () => {
		sync.dispose();
		base = 2;
		sync = build({ allowRateBend: () => false });
		await sync.tick();
		// The preference changes how drift is corrected, not how fast the room runs.
		expect(setPosition).toHaveBeenLastCalledWith(expect.closeTo(102, 6));
	});

	it("learns in wall time when the room does not run at 1x", async () => {
		base = 2;
		await sync.tick();
		setPosition.mockClear();
		// Still 0.4s of media behind at 2x is 0.2s of latency that was not predicted.
		playerPosition = 99.6;
		vi.advanceTimersByTime(250);
		await sync.tick();
		expect(sync.getMetrics().loadLeadSeconds).toBeCloseTo(1.1, 6);
	});

	it("does not predict past the end of the media", async () => {
		sync.dispose();
		sync = build({ getSeekLimit: () => 100.4 });
		await sync.tick();
		// The element would clamp a target past its end, and the native seek hold would wait
		// for a position the media does not have.
		expect(setPosition).toHaveBeenLastCalledWith(expect.closeTo(100.4, 6));
		// A clamped seek was not a prediction, so its residual teaches nothing.
		playerPosition = 99;
		vi.advanceTimersByTime(250);
		await sync.tick();
		expect(sync.getMetrics().loadLeadSeconds).toBe(1);
	});

	it("never seeks behind the room when the room is already past the limit", async () => {
		sync.dispose();
		sync = build({ getSeekLimit: () => 90 });
		await sync.tick();
		expect(setPosition).toHaveBeenLastCalledWith(100);
	});
});

describe("fine correction below the bend start", () => {
	let sync: ReturnType<typeof createPlaybackSync>;
	let state: ReturnType<Parameters<typeof createPlaybackSync>[0]["getState"]>;
	let base: number | null;
	let playerPosition: number;
	let getPosition: Mock<[], number | Promise<number>>;
	let setPosition: Mock<[number], void | Promise<void>>;
	let setLocalRate: Mock<[number], void | Promise<void>>;
	let setPreservesPitch: Mock<[boolean], boolean>;

	function build(overrides: Partial<Parameters<typeof createPlaybackSync>[0]> = {}) {
		return createPlaybackSync({
			getState: () => ({ ...state }),
			getPosition,
			setPosition,
			getBendBase: () => base,
			setLocalRate,
			setPreservesPitch,
			// A zero lead keeps these assertions about the band, not the seek target.
			initialSeekLeadSeconds: { load: 0, seek: 0 },
			onError: () => undefined,
			...overrides,
		});
	}

	beforeEach(async () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		base = 1;
		playerPosition = 100;
		state = {
			source: { id: "micro" },
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
		getPosition = vi.fn<[], number | Promise<number>>(() => playerPosition);
		setPosition = vi.fn<[number], void | Promise<void>>();
		setLocalRate = vi.fn<[number], void | Promise<void>>();
		setPreservesPitch = vi.fn<[boolean], boolean>(() => true);
		sync = build();
		await sync.tick(); // The source alignment seek; the band starts from the next read.
	});
	afterEach(() => {
		sync.dispose();
		vi.useRealTimers();
	});

	async function observeWith(
		engine: ReturnType<typeof createPlaybackSync>,
		drift: number,
		ticks: number,
	) {
		playerPosition = state.position - drift;
		for (let index = 0; index < ticks; index++) {
			vi.advanceTimersByTime(250);
			await engine.tick();
		}
	}

	async function observe(drift: number, ticks: number) {
		await observeWith(sync, drift, ticks);
	}

	function rates() {
		return setLocalRate.mock.calls.map(([rate]) => rate);
	}

	it("leaves a room speed change in place when it ends the band", async () => {
		await observe(0.1, 3);
		expect(rates().at(-1)).toBeCloseTo(1.02, 6);

		// A temporary 2x gesture: the player applies the new room speed first, and only then
		// is the engine told that its rate is stale (Room.vue invalidates after the flush).
		base = 2;
		state.temporarySpeed = true;
		sync.invalidateRate();

		// Writing the band's old 1x back here left the whole gesture playing at 1x, because
		// nothing corrects the rate again while the temporary speed lasts.
		expect(rates().at(-1)).toBe(2);
		expect(setPreservesPitch).toHaveBeenLastCalledWith(true);
		await observe(0.1, 3);
		expect(rates().at(-1)).toBe(2);
	});

	it("starts only after three matching observations and plays resampled", async () => {
		await observe(0.1, 2);
		expect(setLocalRate).not.toHaveBeenCalled();
		expect(setPreservesPitch).not.toHaveBeenCalled();

		await observe(0.1, 1);
		expect(setPreservesPitch).toHaveBeenCalledTimes(1);
		expect(setPreservesPitch).toHaveBeenLastCalledWith(false);
		expect(setLocalRate).toHaveBeenCalledTimes(1);
		expect(setLocalRate).toHaveBeenLastCalledWith(expect.closeTo(1.02, 6));
	});

	it.each([
		[0.1, 1.02],
		[0.06, 1.015],
		[-0.1, 0.98],
		[-0.06, 0.985],
	])("quantises a steady %s second drift into a %s rate", async (drift, rate) => {
		await observe(drift, 3);
		expect(setLocalRate).toHaveBeenLastCalledWith(expect.closeTo(rate, 6));
	});

	it("follows the quantised step while the band is already active", async () => {
		await observe(0.1, 3);
		// 0.03 / 4 = 0.0075 rounds half up to two steps of 0.005.
		await observe(0.03, 1);
		expect(setLocalRate).toHaveBeenLastCalledWith(expect.closeTo(1.01, 6));
		await observe(-0.03, 1);
		expect(setLocalRate).toHaveBeenLastCalledWith(expect.closeTo(0.99, 6));
	});

	it("ignores a single spike between small drifts", async () => {
		await observe(0.02, 3);
		await observe(0.1, 1);
		await observe(0.02, 3);
		expect(setLocalRate).not.toHaveBeenCalled();
		expect(setPreservesPitch).not.toHaveBeenCalled();
	});

	it("stops at two hundredths and gives the element its base rate and pitch back", async () => {
		await observe(0.1, 3);
		await observe(0.02, 1);
		expect(setLocalRate).toHaveBeenLastCalledWith(1);
		expect(setPreservesPitch).toHaveBeenLastCalledWith(true);
		await observe(0.02, 1);
		expect(setLocalRate).toHaveBeenCalledTimes(2);
		expect(setPreservesPitch).toHaveBeenCalledTimes(2);
	});

	it("writes the rate once per quantised step while the drift shrinks", async () => {
		await observe(0.1, 3);
		await observe(0.05, 1);
		await observe(0.03, 1);
		await observe(0.02, 1);
		expect(rates()).toEqual([
			expect.closeTo(1.02, 6),
			expect.closeTo(1.015, 6),
			expect.closeTo(1.01, 6),
			1,
		]);
		expect(setPreservesPitch).toHaveBeenCalledTimes(2);
	});

	it("never resamples at a room speed other than 1", async () => {
		base = 1.5;
		await observe(0.1, 4);
		expect(setLocalRate).not.toHaveBeenCalled();
		expect(setPreservesPitch).not.toHaveBeenCalled();
	});

	it.each([
		"missing",
		"unsupported",
	] as const)("keeps today's behaviour when pitch preservation is %s", async kind => {
		const limited =
			kind === "missing"
				? build({ setPreservesPitch: undefined })
				: build({ setPreservesPitch: () => false });
		await limited.tick();
		await observeWith(limited, 0.1, 4);
		expect(setLocalRate).not.toHaveBeenCalled();
		expect(setPreservesPitch).not.toHaveBeenCalled();
		limited.dispose();
	});

	it.each([
		["the room is paused", () => (state.playing = false)],
		["the element is buffering", () => (state.buffering = true)],
		["the source is live", () => (state.live = true)],
		["the room is at a temporary 2x", () => (state.temporarySpeed = true)],
	] as const)("never corrects below the bend start while %s", async (_label, apply) => {
		apply();
		await observe(0.1, 4);
		expect(setLocalRate).not.toHaveBeenCalled();
		expect(setPreservesPitch).not.toHaveBeenCalled();
	});

	it.each([
		["cannot bend", { getBendBase: () => null }],
		["is embedded", { getBendBase: () => null, seekIsExpensive: () => true }],
		["has the bend switch off", { allowRateBend: () => false }],
	] as const)("stays off for a player that %s", async (_label, overrides) => {
		const limited = build(overrides);
		await limited.tick();
		await observeWith(limited, 0.1, 4);
		expect(setLocalRate).not.toHaveBeenCalled();
		expect(setPreservesPitch).not.toHaveBeenCalled();
		limited.dispose();
	});

	it("ends the band when the bend switch is turned off", async () => {
		let bendEnabled = true;
		const toggleable = build({ allowRateBend: () => bendEnabled });
		await toggleable.tick();
		await observeWith(toggleable, 0.1, 3);
		expect(setLocalRate).toHaveBeenLastCalledWith(expect.closeTo(1.02, 6));

		bendEnabled = false;
		await observeWith(toggleable, 0.1, 1);
		expect(setLocalRate).toHaveBeenLastCalledWith(1);
		expect(setPreservesPitch).toHaveBeenLastCalledWith(true);
		toggleable.dispose();
	});

	it("hands a growing drift to the bend and gives pitch preservation back first", async () => {
		await observe(0.1, 3);
		await observe(0.4, 1);
		expect(setPreservesPitch).toHaveBeenLastCalledWith(true);
		expect(rates()).toEqual([expect.closeTo(1.02, 6), 1, expect.closeTo(1.08, 6)]);
		expect(setPreservesPitch.mock.invocationCallOrder[1]).toBeLessThan(
			setLocalRate.mock.invocationCallOrder[2],
		);
	});

	it("picks up what the bend leaves at its own stop on a later tick", async () => {
		await observe(0.5, 1);
		expect(setLocalRate).toHaveBeenLastCalledWith(expect.closeTo(1.08, 6));
		await observe(0.2, 1);
		await observe(0.15, 1);
		// The bend stops at 150ms; its remainder is not corrected on the same tick.
		expect(setLocalRate).toHaveBeenLastCalledWith(1);
		expect(setPreservesPitch).not.toHaveBeenCalled();
		await observe(0.15, 1);
		expect(setLocalRate).toHaveBeenLastCalledWith(expect.closeTo(1.02, 6));
		expect(setPreservesPitch).toHaveBeenLastCalledWith(false);
	});

	it.each([
		"requestSeek",
		"invalidateRate",
		"reset",
	] as const)("ends the band and forgets the applied pitch on %s", async method => {
		await observe(0.1, 3);
		expect(setPreservesPitch).toHaveBeenLastCalledWith(false);
		await sync[method]();
		expect(setLocalRate).toHaveBeenLastCalledWith(1);
		expect(setPreservesPitch).toHaveBeenLastCalledWith(true);

		setLocalRate.mockClear();
		setPreservesPitch.mockClear();
		// A reloaded element preserves pitch by default, so the next entry switches it again.
		// A reset defers its seek to the next tick, so one observation there is a hole.
		await observe(0.1, 4);
		expect(setPreservesPitch).toHaveBeenLastCalledWith(false);
		expect(setLocalRate).toHaveBeenLastCalledWith(expect.closeTo(1.02, 6));
	});

	it("counts the band's time and its rate writes as bend telemetry", async () => {
		await observe(0.1, 3);
		expect(sync.getMetrics().rateWrites).toBe(1);
		await observe(0.1, 4);
		expect(sync.getMetrics().rateWrites).toBe(1);
		expect(sync.getMetrics().bendSeconds).toBeCloseTo(1, 6);
	});
});
