import { describe, expect, it } from "vitest";
import {
	computeCanvasSize,
	MAX_AUTO_PIXELS,
	MAX_SCALE,
	MIN_AUTO_SCALE,
} from "@/util/upscale/scale";

const base = {
	nativeWidth: 1920,
	nativeHeight: 1080,
	boxWidth: 0,
	boxHeight: 0,
	dpr: 1,
	requestedScale: "auto" as const,
};

describe("enhancement canvas sizing", () => {
	it("never undersamples the source on a phone", () => {
		// A 1080p picture in a 390x219 CSS px box at dpr 2 has 780x438 device pixels.
		// A smaller canvas than the source made the enhanced picture softer than the
		// untouched video, because the browser scales the video with a better filter
		// than the single tap in the shader.
		const size = computeCanvasSize({
			...base,
			boxWidth: 390,
			boxHeight: 219,
			dpr: 2,
		});
		expect(size).toEqual({ width: 1920, height: 1080 });
		expect(size.width).toBeGreaterThanOrEqual(base.nativeWidth);
	});

	it("keeps the source resolution when the box is smaller than the source", () => {
		const size = computeCanvasSize({ ...base, boxWidth: 1280, boxHeight: 720 });
		expect(size).toEqual({ width: 1920, height: 1080 });
	});

	it("upscales small sources up to the displayed box", () => {
		const size = computeCanvasSize({
			...base,
			nativeWidth: 640,
			nativeHeight: 360,
			boxWidth: 1280,
			boxHeight: 720,
		});
		expect(size).toEqual({ width: 1280, height: 720 });
	});

	it("covers a 1440p display from a 720p source with a 2x canvas", () => {
		const size = computeCanvasSize({
			...base,
			nativeWidth: 1280,
			nativeHeight: 720,
			boxWidth: 2560,
			boxHeight: 1440,
		});
		expect(size).toEqual({ width: 2560, height: 1440 });
	});

	it("covers a 4K display from a 720p source with a 3x canvas", () => {
		const size = computeCanvasSize({
			...base,
			nativeWidth: 1280,
			nativeHeight: 720,
			boxWidth: 3840,
			boxHeight: 2160,
		});
		expect(size).toEqual({ width: 3840, height: 2160 });
	});

	it("never renders beyond the supersampling limit", () => {
		const size = computeCanvasSize({
			...base,
			nativeWidth: 320,
			nativeHeight: 180,
			boxWidth: 1920,
			boxHeight: 1080,
			dpr: 2,
		});
		expect(size).toEqual({ width: 320 * MAX_SCALE, height: 180 * MAX_SCALE });
	});

	it("follows an explicit multiplier literally, ignoring the displayed box", () => {
		// A box far smaller than the source must not pull an explicit choice down.
		const size = computeCanvasSize({
			...base,
			boxWidth: 390,
			boxHeight: 219,
			dpr: 2,
			requestedScale: 1,
		});
		expect(size).toEqual({ width: 1920, height: 1080 });
	});

	it("lets an explicit multiplier supersample above the automatic size", () => {
		const size = computeCanvasSize({
			...base,
			boxWidth: 390,
			boxHeight: 219,
			dpr: 2,
			requestedScale: 3,
		});
		expect(size).toEqual({ width: 5760, height: 3240 });
	});

	it("still allows the explicit tiers below the source", () => {
		// These are the rungs the degrade ladder steps down to, so they stay legal
		// even though the automatic size no longer goes there.
		const size = computeCanvasSize({ ...base, requestedScale: 0.5 });
		expect(size).toEqual({ width: 960, height: 540 });
	});

	it("clamps an oversized explicit multiplier", () => {
		const size = computeCanvasSize({ ...base, requestedScale: 4 });
		expect(size).toEqual({ width: 1920 * MAX_SCALE, height: 1080 * MAX_SCALE });
	});

	it("caps very high resolution sources at the automatic pixel budget", () => {
		// 8K on a phone would otherwise render 33M pixels per frame for a picture
		// whose device pixels number 780x438.
		const size = computeCanvasSize({
			...base,
			nativeWidth: 7680,
			nativeHeight: 4320,
			boxWidth: 390,
			boxHeight: 219,
			dpr: 2,
		});
		expect(size.width * size.height).toBeLessThanOrEqual(MAX_AUTO_PIXELS);
		expect(size).toEqual({ width: 3840, height: 2160 });
	});

	it("does not pull a source that fits the budget below the displayed box", () => {
		// The budget is a cap, not a target: a 720p source on a 1080p box keeps
		// rendering at the displayed size.
		const size = computeCanvasSize({
			...base,
			nativeWidth: 1280,
			nativeHeight: 720,
			boxWidth: 1920,
			boxHeight: 1080,
		});
		expect(size).toEqual({ width: 1920, height: 1080 });
	});

	it("survives a box that has not been laid out yet", () => {
		const size = computeCanvasSize({ ...base, boxWidth: 0, boxHeight: 0 });
		expect(size.width).toBeGreaterThan(0);
		expect(size.height).toBeGreaterThan(0);
		expect(size.width).toBe(1920 * MIN_AUTO_SCALE);
	});

	it("survives metadata that has not loaded yet", () => {
		const size = computeCanvasSize({ ...base, nativeWidth: 0, nativeHeight: 0 });
		expect(size.width).toBeGreaterThanOrEqual(1);
		expect(size.height).toBeGreaterThanOrEqual(1);
	});
});
