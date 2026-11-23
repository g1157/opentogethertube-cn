import { describe, expect, it, vi } from "vitest";
import { createMediaSeek } from "@/util/media-seek";

function mediaWith(currentTime: number, paused = false) {
	return {
		currentTime,
		paused,
		pause: vi.fn(),
		seeking: false,
		readyState: 4,
		error: null,
	};
}

describe("media seek tolerance", () => {
	it("does not pause or seek for a difference below the audio-flush threshold", () => {
		const media = mediaWith(0.1);
		const seek = createMediaSeek(() => media as unknown as HTMLVideoElement);

		seek.seek(0);

		expect(media.pause).not.toHaveBeenCalled();
		expect(media.currentTime).toBe(0.1);
		expect(seek.pending()).toBe(false);
	});

	it("places a paused element on the exact frame", () => {
		const media = mediaWith(100, true);
		const seek = createMediaSeek(() => media as unknown as HTMLVideoElement);

		// A paused element has no audio pipeline to flush, so a tenth of a second is real
		// drift: every viewer has to freeze on the same frame.
		seek.seek(100.1);

		expect(media.pause).toHaveBeenCalledOnce();
		expect(media.currentTime).toBe(100.1);
		expect(seek.pending()).toBe(true);
	});

	it("holds a reachable position when asked to seek past the end", () => {
		const media = { ...mediaWith(60), duration: 120 };
		const seek = createMediaSeek(() => media as unknown as HTMLVideoElement);

		// A predicted target can overshoot the media. The element clamps it, so the hold has
		// to wait for the clamped position or it is never released.
		seek.seek(120.8);

		expect(media.currentTime).toBe(120);
		expect(seek.pending()).toBe(true);
		expect(seek.ready()).toBe(true);
		expect(seek.pending()).toBe(false);
	});

	it("still seeks a real jump and tracks the pending target", () => {
		const media = mediaWith(10);
		const seek = createMediaSeek(() => media as unknown as HTMLVideoElement);

		seek.seek(50.25);

		expect(media.pause).toHaveBeenCalledOnce();
		expect(media.currentTime).toBe(50.25);
		expect(seek.pending()).toBe(true);
		expect(seek.ready()).toBe(true);
		expect(seek.pending()).toBe(false);
	});
});
