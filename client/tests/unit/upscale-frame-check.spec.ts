import { describe, expect, it } from "vitest";
import { compareFrames, MIN_CORRELATION, MIN_SHARPNESS } from "@/util/upscale/frame-check";

const WIDTH = 64;
const HEIGHT = 64;

/** A busy synthetic frame: a ramp with stripes, the kind of detail a blur removes. */
function frame(): Float32Array {
	const frame = new Float32Array(WIDTH * HEIGHT);
	for (let y = 0; y < HEIGHT; y++) {
		for (let x = 0; x < WIDTH; x++) {
			const stripe = (x + Math.floor(y / 4)) % 8 < 4 ? 40 : 0;
			frame[y * WIDTH + x] = 60 + (y / HEIGHT) * 60 + stripe;
		}
	}
	return frame;
}

/** What the two failures look like: a frame blurred the way a mis-resampled picture is, and one
 *  shifted a few samples down. */
function blurred(source: Float32Array): Float32Array {
	let current = source;
	// The failure this guards against is visibly soft, not slightly softened: one pass of a 3x3
	// box is within what a legitimate enhancement may do to fine detail.
	for (let pass = 0; pass < 4; pass++) {
		const out = new Float32Array(current.length);
		for (let y = 1; y < HEIGHT - 1; y++) {
			for (let x = 1; x < WIDTH - 1; x++) {
				let sum = 0;
				for (let dy = -1; dy <= 1; dy++) {
					for (let dx = -1; dx <= 1; dx++) {
						sum += current[(y + dy) * WIDTH + x + dx];
					}
				}
				out[y * WIDTH + x] = sum / 9;
			}
		}
		current = out;
	}
	return current;
}

function shifted(source: Float32Array, by: number): Float32Array {
	const out = new Float32Array(source.length);
	for (let y = 0; y + by < HEIGHT; y++) {
		for (let x = 0; x < WIDTH; x++) {
			out[(y + by) * WIDTH + x] = source[y * WIDTH + x];
		}
	}
	return out;
}

describe("enhanced frame check", () => {
	it("accepts the frame the enhancement drew from the same picture", () => {
		const source = frame();
		const verdict = compareFrames(source, source, WIDTH);
		expect(verdict.correlation).toBeCloseTo(1, 5);
		expect(verdict.sharpness).toBeCloseTo(1, 5);
		expect(verdict.ok).toBe(true);
	});

	it("accepts a frame that is sharper than the video", () => {
		// What a working AI tier does: the same picture with more contrast at the edges.
		const source = frame();
		const enhanced = Float32Array.from(source, value => 64 + (value - 64) * 1.4);
		const verdict = compareFrames(source, enhanced, WIDTH);
		expect(verdict.ok).toBe(true);
		expect(verdict.sharpness).toBeGreaterThan(1);
	});

	it("rejects a blurred frame", () => {
		const verdict = compareFrames(frame(), blurred(frame()), WIDTH);
		expect(verdict.sharpness).toBeLessThan(MIN_SHARPNESS);
		expect(verdict.ok).toBe(false);
	});

	it("rejects a frame that is offset from the video", () => {
		const verdict = compareFrames(frame(), shifted(frame(), 6), WIDTH);
		expect(verdict.correlation).toBeLessThan(MIN_CORRELATION);
		expect(verdict.ok).toBe(false);
	});

	it("rejects a frame that has nothing to do with the video", () => {
		const verdict = compareFrames(frame(), new Float32Array(WIDTH * HEIGHT), WIDTH);
		expect(verdict.ok).toBe(false);
	});
});
