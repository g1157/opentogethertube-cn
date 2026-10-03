import { describe, expect, it } from "vitest";
import {
	AUDIO_EQ_BANDS_HZ,
	AUDIO_EQ_SPECS,
	canRouteMediaThroughWebAudio,
	elementAudioRoutingSupported,
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

describe("WebKit element-audio routing guard", () => {
	it("rejects every WebKit browser and accepts the Chromium and Gecko families", () => {
		// Attaching element audio in WebKit stutters playback permanently; Safari and every
		// iOS browser (all WebKit under the hood) must be kept away from the graph.
		const chromeUA =
			"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36";
		const firefoxUA =
			"Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:141.0) Gecko/20100101 Firefox/141.0";
		const safariUA =
			"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/27.2 Safari/605.1.15";
		const iosSafariUA =
			"Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1";
		const iosChromeUA =
			"Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/154.0.0.0 Mobile/15E148 Safari/604.1";
		expect(elementAudioRoutingSupported(chromeUA)).toBe(true);
		expect(elementAudioRoutingSupported(firefoxUA)).toBe(true);
		expect(elementAudioRoutingSupported(safariUA)).toBe(false);
		expect(elementAudioRoutingSupported(iosSafariUA)).toBe(false);
		expect(elementAudioRoutingSupported(iosChromeUA)).toBe(false);
		// An empty user agent (an environment without one) must not disable the feature.
		expect(elementAudioRoutingSupported("")).toBe(true);
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
