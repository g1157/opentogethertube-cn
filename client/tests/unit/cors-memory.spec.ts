import { beforeEach, describe, expect, it } from "vitest";
import { forgetCorsVerdicts, rememberCors, rememberedCors } from "@/util/cors-memory";

describe("cross-origin verdict memory", () => {
	beforeEach(() => {
		forgetCorsVerdicts();
	});

	it("remembers a verdict per host, not per link", () => {
		rememberCors("https://cdn.example.com/anime/ep01.mp4", false);
		expect(rememberedCors("https://cdn.example.com/anime/ep02.mp4")).toBe(false);
		expect(rememberedCors("https://other.example.com/anime/ep01.mp4")).toBeUndefined();
	});

	it("keeps an allowing host allowed", () => {
		rememberCors("https://cdn.example.com/ep01.mp4", true);
		expect(rememberedCors("https://cdn.example.com/ep02.mp4")).toBe(true);
	});

	it("ignores values that are not URLs", () => {
		rememberCors("just some search text", false);
		expect(rememberedCors("just some search text")).toBeUndefined();
	});
});
