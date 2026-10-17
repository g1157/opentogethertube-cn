import { describe, expect, it } from "vitest";
import { resolveVideoLength } from "@/util/video-length";

describe("resolveVideoLength", () => {
	it("prefers the server-provided length", () => {
		expect(resolveVideoLength(305, 300)).toBe(305);
	});

	it("falls back to the locally measured duration", () => {
		expect(resolveVideoLength(undefined, 125)).toBe(125);
		expect(resolveVideoLength(0, 125)).toBe(125);
		expect(resolveVideoLength(null, 125)).toBe(125);
	});

	it("treats a non-finite or non-positive local duration as unknown", () => {
		expect(resolveVideoLength(undefined, NaN)).toBeNull();
		expect(resolveVideoLength(undefined, Infinity)).toBeNull();
		expect(resolveVideoLength(undefined, 0)).toBeNull();
		expect(resolveVideoLength(undefined, -1)).toBeNull();
		expect(resolveVideoLength(undefined, null)).toBeNull();
	});

	it("returns null when neither side knows the length", () => {
		expect(resolveVideoLength(NaN, undefined)).toBeNull();
	});
});
