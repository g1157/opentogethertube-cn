import { afterEach, describe, expect, it, vi } from "vitest";
import { startVideoRenderLoop, waitForDecodedFrame } from "@/util/upscale/video-render-loop";

function videoFixture(readyState = 4) {
	const video = document.createElement("video");
	const callbacks = new Map<number, VideoFrameRequestCallback>();
	let id = 0;
	Object.defineProperty(video, "readyState", { value: readyState, configurable: true });
	Object.defineProperties(video, {
		requestVideoFrameCallback: { value: () => 0, writable: true },
		cancelVideoFrameCallback: { value: () => undefined, writable: true },
	});
	vi.spyOn(video, "requestVideoFrameCallback").mockImplementation(callback => {
		callbacks.set(++id, callback);
		return id;
	});
	vi.spyOn(video, "cancelVideoFrameCallback").mockImplementation(request =>
		callbacks.delete(request),
	);
	return {
		video,
		callbacks,
		frame(mediaTime: number) {
			const pending = [...callbacks.entries()][0];
			if (!pending) {
				throw new Error("No frame scheduled");
			}
			callbacks.delete(pending[0]);
			pending[1](0, { mediaTime } as VideoFrameCallbackMetadata);
		},
	};
}

describe("video enhancement", () => {
	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
		Reflect.deleteProperty(document, "hidden");
	});

	describe("enhancement render lifecycle", () => {
		it("releases the first draw's resources when a tainted video throws", () => {
			const { video, callbacks } = videoFixture();
			const release = vi.fn();
			expect(() =>
				startVideoRenderLoop(
					video,
					document.createElement("canvas"),
					() => {
						throw new DOMException("Tainted video", "SecurityError");
					},
					release,
				),
			).toThrow("Tainted video");
			expect(release).toHaveBeenCalledTimes(1);
			expect(callbacks.size).toBe(0);
		});

		it("stops, frees resources, and reports three consecutive draw failures", () => {
			const { video, callbacks, frame } = videoFixture();
			const draw = vi.fn();
			const release = vi.fn();
			const fatal = vi.fn();
			const loop = startVideoRenderLoop(
				video,
				document.createElement("canvas"),
				draw,
				release,
				fatal,
			);
			draw.mockImplementation(() => {
				throw new Error("Upload rejected");
			});
			frame(1);
			frame(2);
			expect(fatal).not.toHaveBeenCalled();
			frame(3);
			expect(fatal).toHaveBeenCalledWith("Upload rejected");
			expect(release).toHaveBeenCalledTimes(1);
			expect(callbacks.size).toBe(0);
			loop.stop();
			video.dispatchEvent(new Event("pause"));
			expect(release).toHaveBeenCalledTimes(1);
			expect(draw).toHaveBeenCalledTimes(4);
		});

		it("falls back on context loss and removes its media listeners", () => {
			const { video, callbacks } = videoFixture();
			const canvas = document.createElement("canvas");
			const draw = vi.fn();
			const release = vi.fn();
			const fatal = vi.fn();
			startVideoRenderLoop(video, canvas, draw, release, fatal);
			canvas.dispatchEvent(new Event("webglcontextlost", { cancelable: true }));
			video.dispatchEvent(new Event("seeked"));
			expect(fatal).toHaveBeenCalledWith("WebGL context lost");
			expect(release).toHaveBeenCalledTimes(1);
			expect(draw).toHaveBeenCalledTimes(1);
			expect(callbacks.size).toBe(0);
		});

		it("skips duplicate presentations and GPU work in a hidden tab", () => {
			const { video, frame } = videoFixture();
			const draw = vi.fn();
			const loop = startVideoRenderLoop(
				video,
				document.createElement("canvas"),
				draw,
				vi.fn(),
			);
			frame(1);
			frame(1);
			expect(draw).toHaveBeenCalledTimes(2);
			Object.defineProperty(document, "hidden", { value: true, configurable: true });
			frame(2);
			loop.redraw?.();
			expect(draw).toHaveBeenCalledTimes(2);
			Object.defineProperty(document, "hidden", { value: false, configurable: true });
			document.dispatchEvent(new Event("visibilitychange"));
			expect(draw).toHaveBeenCalledTimes(3);
			loop.stop();
		});
	});

	describe("decoded frame readiness", () => {
		it("accepts HAVE_CURRENT_DATA without waiting for a loadeddata event that already fired", async () => {
			const { video } = videoFixture(2);
			await expect(waitForDecodedFrame(video)).resolves.toBeUndefined();
		});

		it("cancels a stale start and removes its frame listener", async () => {
			const { video } = videoFixture(0);
			const remove = vi.spyOn(video, "removeEventListener");
			const abort = new AbortController();
			const pending = waitForDecodedFrame(video, abort.signal);
			abort.abort();
			await expect(pending).rejects.toMatchObject({ name: "AbortError" });
			expect(remove).toHaveBeenCalledWith("loadeddata", expect.any(Function));
		});

		it("times out a video that never decodes instead of keeping enhancement startup pending", async () => {
			vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
			const { video } = videoFixture(0);
			const pending = expect(waitForDecodedFrame(video)).rejects.toThrow("Timed out");
			await vi.advanceTimersByTimeAsync(4000);
			await pending;
		});
	});
});
