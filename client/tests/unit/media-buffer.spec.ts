import { describe, expect, it } from "vitest";
import { HIDDEN_TAB_BUFFER_SECONDS, visibleBufferSeconds } from "@/util/media-buffer";

describe("visible media buffer budget", () => {
	it("keeps the configured window while the tab is visible", () => {
		expect(visibleBufferSeconds(300, false)).toBe(300);
	});

	it("caps a hidden tab without raising a smaller preference", () => {
		expect(visibleBufferSeconds(300, true)).toBe(HIDDEN_TAB_BUFFER_SECONDS);
		expect(visibleBufferSeconds(20, true)).toBe(20);
	});
});
