import { describe, expect, it } from "vitest";
import { computeCanvasSize, MAX_SCALE, MIN_AUTO_SCALE } from "@/util/upscale/scale";

const base = {
	nativeWidth: 1920,
	nativeHeight: 1080,
	boxWidth: 0,
	boxHeight: 0,
	dpr: 1,
	requestedScale: "auto" as const,
};

describe("enhancement canvas sizing", () => {
	it("does not render more pixels than a phone actually displays", () => {
		// A 1080p picture in a 390x219 CSS px box at dpr 2 has 780x438 device pixels to
		// fill. Rendering the full 1920x1080 there was ~6x the work for no visible gain
		// and was what pushed phones below the frame rate floor.
		const size = computeCanvasSize({
			...base,
			boxWidth: 390,
			boxHeight: 219,
			dpr: 2,
		});
		expect(size.height).toBe(438);
		expect(size.width).toBeLessThan(800);
		expect(size.width * size.height).toBeLessThan((1920 * 1080) / 5);
	});

	it("matches the displayed box on a desktop without exceeding the source", () => {
		const size = computeCanvasSize({ ...base, boxWidth: 1280, boxHeight: 720 });
		expect(size).toEqual({ width: 1280, height: 720 });
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

	it("lets an explicit multiplier supersample below the automatic size", () => {
		const size = computeCanvasSize({
			...base,
			boxWidth: 390,
			boxHeight: 219,
			dpr: 2,
			requestedScale: 2,
		});
		expect(size).toEqual({ width: 3840, height: 2160 });
	});

	it("clamps an oversized explicit multiplier", () => {
		const size = computeCanvasSize({ ...base, requestedScale: 4 });
		expect(size).toEqual({ width: 1920 * MAX_SCALE, height: 1080 * MAX_SCALE });
	});

	it("keeps a floor under very high resolution sources shown small", () => {
		// 8K on a phone would otherwise size below the floor; the floor stops the canvas
		// from collapsing rather than forcing it up to the source resolution.
		const size = computeCanvasSize({
			...base,
			nativeWidth: 7680,
			nativeHeight: 4320,
			boxWidth: 390,
			boxHeight: 219,
			dpr: 2,
		});
		expect(size).toEqual({
			width: 7680 * MIN_AUTO_SCALE,
			height: 4320 * MIN_AUTO_SCALE,
		});
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
