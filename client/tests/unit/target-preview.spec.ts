import { describe, expect, it } from "vitest";
import { computeRenderedTarget } from "@/util/upscale/target-preview";

const base = {
	dpr: 1,
	requestedScale: "auto" as const,
};

describe("rendered target preview", () => {
	it("fits the source into the box before sizing the canvas", () => {
		// 720p into a 1440p box: the picture keeps its aspect and the canvas covers it.
		expect(
			computeRenderedTarget({
				...base,
				nativeWidth: 1280,
				nativeHeight: 720,
				boxWidth: 2560,
				boxHeight: 1440,
			}),
		).toEqual({ width: 2560, height: 1440, scale: 2 });
	});

	it("accounts for letterboxing in a box of another aspect", () => {
		// A 16:9 picture in a square box is 1000x562 wide, so auto stays at 1x and the
		// helper reports the source resolution rather than stretching to the box.
		const target = computeRenderedTarget({
			...base,
			nativeWidth: 1280,
			nativeHeight: 720,
			boxWidth: 1000,
			boxHeight: 1000,
		});
		expect(target).toEqual({ width: 1280, height: 720, scale: 1 });
	});

	it("follows an explicit multiplier", () => {
		expect(
			computeRenderedTarget({
				...base,
				requestedScale: 3,
				nativeWidth: 1280,
				nativeHeight: 720,
				boxWidth: 400,
				boxHeight: 300,
			}),
		).toEqual({ width: 3840, height: 2160, scale: 3 });
	});

	it("reports nothing without source dimensions or a box", () => {
		expect(computeRenderedTarget({ ...base, boxWidth: 1280, boxHeight: 720 })).toBeNull();
		expect(
			computeRenderedTarget({
				...base,
				nativeWidth: 1280,
				nativeHeight: 720,
				boxWidth: 0,
				boxHeight: 0,
			}),
		).toBeNull();
	});
});
