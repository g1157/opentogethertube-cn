import { describe, expect, it } from "vitest";
import {
	getOneWayDelayMs,
	noteLatencySample,
	resetLatencySamples,
} from "@/util/connection-latency";

describe("connection latency estimate", () => {
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

	it("forgets everything on reset", () => {
		resetLatencySamples();
		noteLatencySample(200, 1000);
		resetLatencySamples();
		expect(getOneWayDelayMs(2000)).toBe(0);
	});
});
