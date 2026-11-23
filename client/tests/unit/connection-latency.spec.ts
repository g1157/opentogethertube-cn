import { afterEach, describe, expect, it, vi } from "vitest";
import {
	getOneWayDelayMs,
	getRttEstimateMs,
	getServerClockOffsetMs,
	isServerClockUncertain,
	noteLatencySample,
	resetLatencySamples,
	subscribeServerClock,
} from "@/util/connection-latency";

describe("connection latency estimate", () => {
	afterEach(() => {
		resetLatencySamples();
		vi.useRealTimers();
	});

	it("reports no compensation until a probe has been answered", () => {
		resetLatencySamples();
		expect(getOneWayDelayMs(1000)).toBe(0);
	});

	it("uses half of the smallest recent round trip", () => {
		resetLatencySamples();
		noteLatencySample(120, 1000);
		noteLatencySample(80, 2000);
		expect(getOneWayDelayMs(3000)).toBe(40);
	});

	it("keeps only the most recent samples so an old low reading cannot stick", () => {
		resetLatencySamples();
		noteLatencySample(20, 1000);
		for (let i = 0; i < 8; i++) {
			noteLatencySample(300 + i, 2000 + i);
		}
		expect(getOneWayDelayMs(3000)).toBe(150);
	});

	it.each([
		[-1, "negative"],
		[Number.NaN, "not a number"],
		[Number.POSITIVE_INFINITY, "infinite"],
		[60_000, "longer than congestion"],
	])("ignores a %s reading (%s)", rtt => {
		resetLatencySamples();
		noteLatencySample(rtt, 1000);
		expect(getOneWayDelayMs(1000)).toBe(0);
	});

	it("stops compensating when the measurement is stale", () => {
		resetLatencySamples();
		noteLatencySample(200, 1000);
		expect(getOneWayDelayMs(120_000)).toBe(100);
		expect(getOneWayDelayMs(1000 + 180_001)).toBe(0);
	});

	it("expires each sample on its own instead of keeping an old minimum alive", () => {
		resetLatencySamples();
		noteLatencySample(40, 1000, 0);
		noteLatencySample(400, 150_000, 9000);

		// Only the fresh sample is left: the old low round trip describes a link state from
		// three minutes ago, and one fresh sample used to keep it in the estimate.
		expect(getOneWayDelayMs(200_000)).toBe(200);
		expect(getRttEstimateMs(200_000)).toBe(400);
		expect(getServerClockOffsetMs(200_000)).toBe(9000);
	});

	it("forgets everything on reset", () => {
		resetLatencySamples();
		noteLatencySample(200, 1000);
		resetLatencySamples();
		expect(getOneWayDelayMs(2000)).toBe(0);
		expect(getServerClockOffsetMs(2000)).toBeNull();
	});

	describe("server clock offset", () => {
		it("is unknown until a reply carries the server's time", () => {
			resetLatencySamples();
			// An older server only echoes the probe: the round trip is still useful.
			noteLatencySample(80, 1000);
			expect(getOneWayDelayMs(1000)).toBe(40);
			expect(getServerClockOffsetMs(1000)).toBeNull();
		});

		it("comes from the sample with the smallest round trip", () => {
			resetLatencySamples();
			// A reply that spent 900 ms in flight is the least certain one, whatever its order.
			noteLatencySample(900, 1000, 5000);
			noteLatencySample(60, 2000, 5120);
			noteLatencySample(700, 3000, 4800);

			expect(getServerClockOffsetMs(4000)).toBe(5120);
		});

		it("expires with its sample", () => {
			resetLatencySamples();
			noteLatencySample(60, 1000, 5120);
			noteLatencySample(80, 150_000, null);

			expect(getServerClockOffsetMs(150_000)).toBe(5120);
			expect(getServerClockOffsetMs(1000 + 180_001)).toBeNull();
		});

		it("drops the samples and asks for new ones when the local clock steps", () => {
			vi.useFakeTimers();
			resetLatencySamples();
			noteLatencySample(100, Date.now(), 5000);
			const events: string[] = [];
			const detach = subscribeServerClock(event => events.push(event));
			try {
				expect(getServerClockOffsetMs()).toBe(5000);

				// A manual clock change (or a machine that slept) moves the wall clock but not
				// the monotonic one, so every offset measured against it is wrong by that much.
				vi.setSystemTime(Date.now() + 5000);

				// No offset is reported until a probe is answered. Keeping the old one would be
				// wrong by the whole step after a clock change, and adjusting it by the step
				// would be wrong by the whole sleep on platforms whose monotonic clock stops;
				// the two cannot be told apart, and arrival-time anchoring needs neither.
				expect(getServerClockOffsetMs()).toBeNull();
				expect(getRttEstimateMs()).toBeNull();
				expect(events).toEqual(["reset"]);
				// The room position derived from the wall clock is not trustworthy either.
				expect(isServerClockUncertain()).toBe(true);

				// The answered probe measures against the clock as it is now.
				noteLatencySample(80, Date.now(), 0);
				expect(isServerClockUncertain()).toBe(false);
				expect(getServerClockOffsetMs()).toBe(0);
			} finally {
				detach();
			}
		});

		it("stops waiting for a probe that is never answered", () => {
			vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
			resetLatencySamples();
			noteLatencySample(100, Date.now(), 5000);
			expect(isServerClockUncertain()).toBe(false);

			vi.setSystemTime(Date.now() + 5000);
			expect(isServerClockUncertain()).toBe(true);

			// A server that never answers must not freeze drift correction for good.
			vi.advanceTimersByTime(5001);
			expect(isServerClockUncertain()).toBe(false);
		});

		it("does not call a legacy server's samples uncertain", () => {
			vi.useFakeTimers();
			resetLatencySamples();
			// Round trips only: there was never an offset that could have gone stale.
			noteLatencySample(100, Date.now());

			vi.setSystemTime(Date.now() + 5000);

			expect(isServerClockUncertain()).toBe(false);
		});

		it("does not let a faster sample from before a clock step outlive it", () => {
			vi.useFakeTimers();
			resetLatencySamples();
			try {
				// The best round trip so far, measured against the old clock mapping.
				noteLatencySample(20, Date.now(), 5000);
				vi.setSystemTime(Date.now() + 5000);

				// The next reply arrives before anything asked for the offset. It is slower,
				// but it is the only one that describes the clock as it is now.
				noteLatencySample(90, Date.now(), 0);

				expect(getServerClockOffsetMs()).toBe(0);
				expect(getRttEstimateMs()).toBe(90);
			} finally {
				vi.useRealTimers();
			}
		});

		it("reports a changed estimate to its subscribers and stops after unsubscribe", () => {
			resetLatencySamples();
			const events: string[] = [];
			const detach = subscribeServerClock(event => events.push(event));
			const now = Date.now();
			noteLatencySample(40, now, 5000);
			expect(getServerClockOffsetMs(now)).toBe(5000);
			noteLatencySample(30, now, 5100);
			expect(getServerClockOffsetMs(now)).toBe(5100);
			detach();
			noteLatencySample(20, now, 5200);

			expect(events).toEqual(["sample", "sample"]);
			expect(getServerClockOffsetMs(now)).toBe(5200);
		});
	});
});
