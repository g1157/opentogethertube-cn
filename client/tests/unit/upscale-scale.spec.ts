import { afterEach, describe, expect, it, vi } from "vitest";
import {
	canAffordCnnUpscale,
	computeCanvasSize,
	ladderFloorScale,
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

describe("CNN upscale target", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("clears the CNN's upscale gate when the display box is smaller than it", () => {
		// Anime4K's presets skip their upscale stages below ~1.2x, so the canvas used to
		// sit on the box and only the restore passes ran. The gate is the floor now, not a
		// reason to render at 2x: this box is 960x540, a quarter of the source.
		const size = computeCanvasSize({
			...base,
			boxWidth: 960,
			boxHeight: 540,
			cnnUpscale: true,
		});
		expect(size).toEqual({ width: 2400, height: 1350 });
		expect(size.width / base.nativeWidth).toBeGreaterThanOrEqual(1.2);
	});

	it("follows the display box once it is past the gate", () => {
		// A 1600x900 CSS box at dpr 2 is 3200x1800 device pixels — more than the gate, and
		// all the screen can show. Aiming at a flat 2x here would render half again as many
		// pixels as the display has, for no visible gain.
		const size = computeCanvasSize({
			...base,
			boxWidth: 1600,
			boxHeight: 900,
			dpr: 2,
			cnnUpscale: true,
		});
		expect(size).toEqual({ width: 3200, height: 1800 });
	});

	it("keeps the pixel budget as the ceiling", () => {
		const size = computeCanvasSize({
			...base,
			nativeWidth: 3840,
			nativeHeight: 2160,
			boxWidth: 1920,
			boxHeight: 1080,
			dpr: 2,
			cnnUpscale: true,
		});
		// 1.25x a 4K source would be 4800x2700, past the budget; the budget settles for 1x.
		expect(size).toEqual({ width: 3840, height: 2160 });
		expect(size.width * size.height).toBeLessThanOrEqual(MAX_AUTO_PIXELS);
	});

	it("adds nothing when the box already exceeds the CNN target", () => {
		const size = computeCanvasSize({
			...base,
			nativeWidth: 640,
			nativeHeight: 360,
			boxWidth: 1920,
			boxHeight: 1080,
			cnnUpscale: true,
		});
		expect(size).toEqual({ width: 1920, height: 1080 });
	});

	it("leaves an explicit multiplier alone", () => {
		const size = computeCanvasSize({
			...base,
			boxWidth: 390,
			boxHeight: 219,
			dpr: 2,
			requestedScale: 1,
			cnnUpscale: true,
		});
		expect(size).toEqual({ width: 1920, height: 1080 });
	});

	it("keeps the box-fitted target on touch devices", () => {
		vi.stubGlobal("matchMedia", () => ({ matches: true }));
		expect(canAffordCnnUpscale()).toBe(false);
		vi.stubGlobal("matchMedia", () => ({ matches: false }));
		expect(canAffordCnnUpscale()).toBe(true);
	});

	it("treats an environment without media queries as a pointer device", () => {
		vi.stubGlobal("matchMedia", undefined);
		expect(canAffordCnnUpscale()).toBe(false);
	});
});

describe("auto-degrade floor", () => {
	it("never steps below the source resolution on a desktop display", () => {
		// 1130x686 CSS at dpr 2 is 2260x1372 device pixels: more than the 1080p source, so
		// there is no pixel the screen cannot show that shrinking the canvas would save.
		expect(
			ladderFloorScale({
				nativeWidth: 1920,
				nativeHeight: 1080,
				boxWidth: 1130,
				boxHeight: 686,
				dpr: 2,
			}),
		).toBe(1);
	});

	it("still allows shrinking on a phone, where the box is smaller than the source", () => {
		// A 390x219 box at dpr 2 is 780x438 device pixels; a 0.5x canvas is still above it,
		// so the ladder may go there without showing the viewer anything less than the box.
		expect(
			ladderFloorScale({
				nativeWidth: 1920,
				nativeHeight: 1080,
				boxWidth: 390,
				boxHeight: 219,
				dpr: 2,
			}),
		).toBeCloseTo(0.406, 2);
	});
});
