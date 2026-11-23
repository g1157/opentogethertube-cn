import { describe, expect, it } from "vitest";
import { hlsBufferBudget } from "@/util/hls-buffer";

const MB = 1024 * 1024;

describe("HLS byte budget", () => {
	it("turns a high-bitrate budget into a much shorter forward window", () => {
		const budget = hlsBufferBudget(300, 96 * MB, 20_000_000, 180);
		// 96 MB at 20 Mbps is ~38.4 s; the old config could still target 300 s.
		expect(budget.forwardSeconds).toBeLessThan(25);
		expect(budget.maxForwardSeconds).toBe(budget.forwardSeconds);
		const totalSeconds = budget.forwardSeconds + budget.backSeconds;
		expect((totalSeconds * 20_000_000) / 8).toBeLessThanOrEqual(96 * MB);
	});

	it("keeps a low-bitrate source's larger time window", () => {
		const budget = hlsBufferBudget(300, 256 * MB, 1_000_000, 180);
		expect(budget.forwardSeconds).toBe(300);
		expect(budget.backSeconds).toBe(180);
	});

	it("uses a conservative fallback when the bitrate is not known yet", () => {
		const budget = hlsBufferBudget(600, 256 * MB, 0, 180);
		expect(budget.forwardSeconds).toBeLessThan(600);
		expect(budget.forwardSeconds).toBeGreaterThan(0);
	});

	it("does not allocate more forward time than the configured preference", () => {
		expect(hlsBufferBudget(30, 256 * MB, 1_000_000, 180).forwardSeconds).toBe(30);
	});
});
