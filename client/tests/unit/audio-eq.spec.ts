import { describe, expect, it } from "vitest";
import {
	AUDIO_EQ_BANDS_HZ,
	AUDIO_EQ_SPECS,
	canRouteMediaThroughWebAudio,
	resolveEqBands,
} from "@/util/audio-eq";

describe("audio EQ presets", () => {
	it("gives every preset one gain per band inside a sane range", () => {
		for (const spec of Object.values(AUDIO_EQ_SPECS)) {
			expect(spec.bands).toHaveLength(AUDIO_EQ_BANDS_HZ.length);
			for (const gain of spec.bands) {
				expect(Math.abs(gain)).toBeLessThanOrEqual(12);
			}
			// The preamp only ever takes headroom away; it must never add gain.
			expect(spec.preampDb).toBeLessThanOrEqual(0);
		}
	});

	it("maps every non-off preset to its bands and preamp", () => {
		expect(resolveEqBands("bass")).toBe(AUDIO_EQ_SPECS.bass);
		expect(resolveEqBands("vocal")).toBe(AUDIO_EQ_SPECS.vocal);
	});

	it("treats off as leaving the mix alone", () => {
		expect(resolveEqBands("off")).toBeNull();
	});
});

describe("Web Audio routing safety", () => {
	const pageOrigin = "https://ott.example.com";

	it("accepts MSE output and same-origin files", () => {
		expect(
			canRouteMediaThroughWebAudio(
				{ currentSrc: "blob:https://ott.example.com/1", src: "", crossOrigin: null },
				pageOrigin,
			),
		).toBe(true);
		expect(
			canRouteMediaThroughWebAudio(
				{ currentSrc: "", src: "https://ott.example.com/v.mp4", crossOrigin: null },
				pageOrigin,
			),
		).toBe(true);
	});

	it("accepts cross-origin media that was fetched in CORS mode", () => {
		expect(
			canRouteMediaThroughWebAudio(
				{ currentSrc: "https://cdn.example.com/v.mp4", src: "", crossOrigin: "anonymous" },
				pageOrigin,
			),
		).toBe(true);
	});

	it("rejects cross-origin media without a crossorigin load", () => {
		// This is the case that would otherwise be silenced by the browser, with no way
		// back, so it must never reach createMediaElementSource.
		expect(
			canRouteMediaThroughWebAudio(
				{ currentSrc: "https://ana.girigirilove.com/a.mp4", src: "", crossOrigin: null },
				pageOrigin,
			),
		).toBe(false);
	});

	it("refuses to judge before anything loaded unless crossorigin is already set", () => {
		expect(
			canRouteMediaThroughWebAudio(
				{ currentSrc: "", src: "", crossOrigin: null },
				pageOrigin,
			),
		).toBe(false);
		expect(
			canRouteMediaThroughWebAudio(
				{ currentSrc: "", src: "", crossOrigin: "anonymous" },
				pageOrigin,
			),
		).toBe(true);
	});

	it("rejects a source that cannot be parsed as a URL", () => {
		expect(
			canRouteMediaThroughWebAudio(
				{ currentSrc: "https://[", src: "", crossOrigin: null },
				pageOrigin,
			),
		).toBe(false);
	});
});
