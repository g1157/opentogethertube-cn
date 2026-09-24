import { describe, expect, it } from "vitest";
import {
	FILM_DEBAND,
	FILM_DENOISE,
	FILM_SHARPEN_FACTOR,
	planFilmPasses,
} from "@/util/upscale/film";

describe("film chain plan", () => {
	it("cleans, upscales and sharpens when the target magnifies", () => {
		expect(planFilmPasses({ magnifying: true })).toEqual(["clean", "easu", "cas"]);
	});

	it("skips the upscale when the target is not larger than the source", () => {
		// EASU exists to magnify; on a minifying target the browser's own scaler is the
		// sharper of the two, so the chain only cleans and sharpens.
		expect(planFilmPasses({ magnifying: false })).toEqual(["clean", "cas"]);
	});

	it("keeps the sharpen pass last so it acts at the displayed scale", () => {
		for (const magnifying of [true, false]) {
			const passes = planFilmPasses({ magnifying });
			expect(passes[passes.length - 1]).toBe("cas");
		}
	});
});

describe("film chain weights", () => {
	it("leaves the source mostly intact: the clean pass is gentle by design", () => {
		// Live action loses skin texture and film grain to an aggressive denoise, so both
		// weights stay well below 1 and the deband only acts on flat neighborhoods.
		expect(FILM_DENOISE).toBeGreaterThan(0);
		expect(FILM_DENOISE).toBeLessThanOrEqual(0.5);
		expect(FILM_DEBAND).toBeGreaterThan(0);
		expect(FILM_DEBAND).toBeLessThanOrEqual(0.6);
	});

	it("scales the sharpening slider down instead of using it directly", () => {
		const amount = (strength: number) => strength * FILM_SHARPEN_FACTOR;
		expect(amount(0.4)).toBeCloseTo(0.24, 5);
		// The default strength must not reach CAS' 1.0 ceiling through the scale factor.
		expect(amount(1)).toBeLessThan(1);
	});
});
