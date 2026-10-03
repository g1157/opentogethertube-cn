import { describe, expect, it } from "vitest";
import { qualityTierFromHeight } from "@/util/quality-display";

describe("quality tier labels", () => {
	it.each([
		[2160, "ultra"],
		[1440, "ultra"],
		[1080, "ultra"],
		[1079, "hd"],
		[720, "hd"],
		[719, "sd"],
		[480, "sd"],
		[479, "smooth"],
		[360, "smooth"],
	])("labels a %sp rendition as %s", (height, tier) => {
		expect(qualityTierFromHeight(height)).toBe(tier);
	});

	it.each([
		[0],
		[-1],
		[Number.NaN],
		[Number.POSITIVE_INFINITY],
	])("returns null for an unknown height: %s", height => {
		expect(qualityTierFromHeight(height)).toBeNull();
	});
});
