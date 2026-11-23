import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	recallHlsBandwidthEstimate,
	rememberHlsBandwidthEstimate,
} from "@/util/hls-bandwidth-memory";

describe("HLS bandwidth hint", () => {
	let connection: { effectiveType?: string; saveData?: boolean };
	beforeEach(() => {
		window.localStorage.clear();
		connection = { effectiveType: "4g" };
		Object.defineProperty(navigator, "connection", {
			configurable: true,
			value: connection,
		});
	});
	afterEach(() => {
		vi.useRealTimers();
		Object.defineProperty(navigator, "connection", {
			configurable: true,
			value: undefined,
		});
	});

	it("remembers a recent estimate on the same network", () => {
		rememberHlsBandwidthEstimate(2_000_000);
		expect(recallHlsBandwidthEstimate()).toBe(2_000_000);
	});

	it("expires an old estimate and ignores the untimestamped format", () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
		rememberHlsBandwidthEstimate(2_000_000);
		vi.setSystemTime(new Date("2026-01-09T00:00:00Z"));
		expect(recallHlsBandwidthEstimate()).toBeNull();

		window.localStorage.setItem("ott/hls-bandwidth-estimate", "2000000");
		expect(recallHlsBandwidthEstimate()).toBeNull();
	});

	it("invalidates a fast hint after the connection becomes slower", () => {
		rememberHlsBandwidthEstimate(2_000_000);
		connection.effectiveType = "3g";
		expect(recallHlsBandwidthEstimate()).toBeNull();
	});

	it("honours the browser's data-saver preference", () => {
		rememberHlsBandwidthEstimate(2_000_000);
		connection.saveData = true;
		expect(recallHlsBandwidthEstimate()).toBeNull();
	});
});
