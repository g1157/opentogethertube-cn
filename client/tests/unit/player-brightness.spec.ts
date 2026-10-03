import { describe, expect, it } from "vitest";
import { MIN_PLAYER_BRIGHTNESS, usePlayerBrightness } from "@/util/player-brightness";

describe("player brightness", () => {
	it("clamps the simulated brightness and mirrors it as a scrim", () => {
		const playerBrightness = usePlayerBrightness();
		playerBrightness.setBrightness(0.05);
		expect(playerBrightness.brightness.value).toBe(MIN_PLAYER_BRIGHTNESS);
		expect(playerBrightness.dimmerOpacity.value).toBeCloseTo(0.8, 5);

		playerBrightness.setBrightness(0.6);
		expect(playerBrightness.dimmerOpacity.value).toBeCloseTo(0.4, 5);

		playerBrightness.setBrightness(Number.NaN);
		expect(playerBrightness.brightness.value).toBe(1);
		expect(playerBrightness.dimmerOpacity.value).toBe(0);
	});
});
