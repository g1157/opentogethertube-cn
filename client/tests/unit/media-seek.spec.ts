import { describe, expect, it, vi } from "vitest";
import { createMediaSeek } from "@/util/media-seek";

function mediaWith(currentTime: number) {
	return {
		currentTime,
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
