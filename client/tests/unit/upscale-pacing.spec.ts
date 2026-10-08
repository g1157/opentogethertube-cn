import { describe, expect, it } from "vitest";
import {
	medianFrameInterval,
	pacingVerdict,
	PACING_MIN_FRAMES,
	PACING_SHORTFALL,
} from "@/util/upscale/pacing";

/** Media times of `count` frames at `fps`, starting at 0. */
function frameTimes(count: number, fps: number): number[] {
	return Array.from({ length: count }, (_, index) => index / fps);
}

describe("medianFrameInterval", () => {
	it("reads the nominal interval of a CFR source", () => {
		expect(medianFrameInterval(frameTimes(100, 24))).toBeCloseTo(1 / 24, 9);
		expect(medianFrameInterval(frameTimes(100, 23.976))).toBeCloseTo(1 / 23.976, 9);
	});

	it("ignores the doubled steps a dropped frame leaves", () => {
		const times = frameTimes(30, 24).filter((_, index) => index !== 10 && index !== 20);
		expect(medianFrameInterval(times)).toBeCloseTo(1 / 24, 9);
	});

	it("ignores duplicate presentations and unusable input", () => {
		expect(medianFrameInterval([0, 0, 1 / 24, 1 / 24, 2 / 24])).toBeCloseTo(1 / 24, 9);
		expect(medianFrameInterval([])).toBeNull();
		expect(medianFrameInterval([0.5])).toBeNull();
		expect(medianFrameInterval([1, 1, 1])).toBeNull();
	});
});

describe("pacingVerdict", () => {
	it("keeps a healthy 24 fps window", () => {
		const verdict = pacingVerdict({
			frameCount: 145,
			elapsedMs: 6000,
			mediaTimes: frameTimes(145, 24),
		});
		expect(verdict.judged).toBe(true);
		expect(verdict.degrade).toBe(false);
		expect(verdict.shortfall).toBeLessThan(0.01);
	});

	it("steps down when the media clock outruns the presenter", () => {
		// Every tenth frame never arrives: the media clock covers its usual 6 seconds but
		// only 131 of the 145 frames it implies were presented.
		const times = frameTimes(145, 24).filter((_, index) => index % 10 !== 0);
		const verdict = pacingVerdict({
			frameCount: times.length,
			elapsedMs: 6000,
			mediaTimes: times,
		});
		expect(verdict.judged).toBe(true);
		expect(verdict.shortfall).toBeGreaterThan(PACING_SHORTFALL);
		expect(verdict.degrade).toBe(true);
	});

	it("tolerates a shortfall below the threshold", () => {
		// A few frames missed at the window edges, or a source whose cadence is not perfectly
		// constant, must not take the viewer's tier away: 5% missing is well under what the
		// threshold accepts, and stepping down for it is what made the ladder feel eager.
		const times = frameTimes(145, 24).filter((_, index) => index % 20 !== 0);
		const verdict = pacingVerdict({
			frameCount: times.length,
			elapsedMs: 6000,
			mediaTimes: times,
		});
		expect(verdict.shortfall).toBeGreaterThan(0.04);
		expect(verdict.shortfall).toBeLessThan(PACING_SHORTFALL);
		expect(verdict.degrade).toBe(false);
	});

	it("degrades a steady slow presentation rate through the floor", () => {
		// A consistently overloaded renderer degrades into a regular, self-consistent
		// cadence the shortfall cannot see; the absolute floor is what still catches it.
		const slow = pacingVerdict({
			frameCount: 60,
			elapsedMs: 6000,
			mediaTimes: frameTimes(60, 10),
		});
		expect(slow.fps).toBeCloseTo(10, 3);
		expect(slow.degrade).toBe(true);
	});

	it("degrades a stream whose clock never resolves through the floor too", () => {
		const stalled = pacingVerdict({
			frameCount: 30,
			elapsedMs: 6000,
			mediaTimes: new Array(30).fill(0),
		});
		expect(stalled.expectedFrames).toBeNull();
		expect(stalled.degrade).toBe(true);
	});

	it("degrades a crawling renderer even from a handful of frames", () => {
		// A heavy tier on a weak GPU presents a couple of frames per second; the media
		// clock keeps moving, so the shortfall is enormous and the ladder must step down
		// rather than wait forever for a frame count that will never arrive.
		const times = frameTimes(145, 24).filter((_, index) => index % 18 === 0);
		const verdict = pacingVerdict({
			frameCount: times.length,
			elapsedMs: 6000,
			mediaTimes: times,
		});
		expect(verdict.judged).toBe(true);
		expect(verdict.degrade).toBe(true);
	});

	it("does not judge a window that is too short of frames", () => {
		const verdict = pacingVerdict({
			frameCount: PACING_MIN_FRAMES - 1,
			elapsedMs: 6000,
			mediaTimes: frameTimes(PACING_MIN_FRAMES - 1, 24),
		});
		expect(verdict.judged).toBe(false);
		expect(verdict.degrade).toBe(false);
	});

	it("degrades on the pipeline's own drop count when the cadence looks consistent", () => {
		// An evenly thinned presentation (20 fps for a 20 fps-looking stream) hides its
		// drops from the cadence estimate; the browser still reports them as dropped.
		const times = frameTimes(120, 20);
		const withDrops = pacingVerdict({
			frameCount: times.length,
			elapsedMs: 6000,
			mediaTimes: times,
			droppedFrames: 30,
			totalFrames: 150,
		});
		expect(withDrops.degrade).toBe(true);

		const barelyAny = pacingVerdict({
			frameCount: times.length,
			elapsedMs: 6000,
			mediaTimes: times,
			droppedFrames: 4,
			totalFrames: 150,
		});
		expect(barelyAny.degrade).toBe(false);

		const noCounters = pacingVerdict({
			frameCount: times.length,
			elapsedMs: 6000,
			mediaTimes: times,
		});
		expect(noCounters.degrade).toBe(false);
	});

	it("never reports a negative shortfall", () => {
		// More frames than the median interval implies (a burst of duplicate-rate frames)
		// is not a shortfall.
		const times = frameTimes(100, 24);
		const verdict = pacingVerdict({ frameCount: 120, elapsedMs: 4000, mediaTimes: times });
		expect(verdict.shortfall).toBe(0);
		expect(verdict.degrade).toBe(false);
	});

	it("reports the presentation rate it measured", () => {
		const verdict = pacingVerdict({
			frameCount: 144,
			elapsedMs: 6000,
			mediaTimes: frameTimes(144, 24),
		});
		expect(verdict.fps).toBeCloseTo(24, 3);
		expect(verdict.degrade).toBe(false);
	});
});
