import { reportEnhancementError } from "./status";
import type { UpscaleRenderer } from "./upscale-renderer";

export interface VideoRenderLoop extends UpscaleRenderer {
	fail(message: string): void;
}

/** One lifecycle for every enhancement: draw new frames, redraw paused pictures, and release failures. */
export function startVideoRenderLoop(
	video: HTMLVideoElement,
	canvas: HTMLCanvasElement,
	draw: () => void,
	release: () => void,
	onFatal?: (message: string) => void,
): VideoRenderLoop {
	let stopped = false;
	let frameRequest = 0;
	let lastMediaTime = Number.NaN;
	let drawFailures = 0;

	const stop = () => {
		if (stopped) {
			return;
		}
		stopped = true;
		if (frameRequest) {
			video.cancelVideoFrameCallback(frameRequest);
			frameRequest = 0;
		}
		video.removeEventListener("pause", redraw);
		video.removeEventListener("seeked", redraw);
		document.removeEventListener("visibilitychange", onVisibilityChange);
		canvas.removeEventListener("webglcontextlost", onContextLost);
		release();
	};
	const fail = (message: string) => {
		if (stopped) {
			return;
		}
		stop();
		reportEnhancementError(message);
		onFatal?.(message);
	};
	const drawCurrentFrame = (requestedRedraw: boolean) => {
		if (stopped || document.hidden || video.readyState < video.HAVE_CURRENT_DATA) {
			return;
		}
		try {
			draw();
			drawFailures = 0;
		} catch (error) {
			drawFailures++;
			// An explicit redraw has already cleared or replaced the picture. A frame-loop
			// hiccup can retry, but an unusable paused picture must fall back immediately.
			if (requestedRedraw || drawFailures >= 3) {
				fail(error instanceof Error ? error.message : String(error));
			}
		}
	};
	const redraw = () => drawCurrentFrame(true);
	const onVisibilityChange = () => {
		if (!document.hidden) {
			redraw();
		}
	};
	const onContextLost = (event: Event) => {
		event.preventDefault();
		fail("WebGL context lost");
	};
	const frame = (_now: number, metadata: VideoFrameCallbackMetadata) => {
		frameRequest = 0;
		if (stopped) {
			return;
		}
		const mediaTime = metadata?.mediaTime;
		if (mediaTime === undefined || !(Math.abs(mediaTime - lastMediaTime) < 1e-4)) {
			lastMediaTime = mediaTime ?? Number.NaN;
			drawCurrentFrame(false);
		}
		if (!stopped) {
			frameRequest = video.requestVideoFrameCallback(frame);
		}
	};

	try {
		if (typeof video.requestVideoFrameCallback !== "function") {
			throw new Error("Video frame callbacks unavailable");
		}
		// A failed first draw must release the same resources as a stopped renderer.
		if (!document.hidden && video.readyState >= video.HAVE_CURRENT_DATA) {
			draw();
		}
		video.addEventListener("pause", redraw);
		video.addEventListener("seeked", redraw);
		document.addEventListener("visibilitychange", onVisibilityChange);
		canvas.addEventListener("webglcontextlost", onContextLost);
		frameRequest = video.requestVideoFrameCallback(frame);
	} catch (error) {
		stop();
		throw error;
	}

	return { stop, redraw, fail };
}

/** A decoded frame is enough; waiting for loadeddata after it already fired would never settle. */
export function waitForDecodedFrame(
	video: HTMLVideoElement,
	signal?: AbortSignal,
	timeoutMs = 4000,
): Promise<void> {
	if (signal?.aborted) {
		return Promise.reject(new DOMException("Enhancement start aborted", "AbortError"));
	}
	if (video.readyState >= video.HAVE_CURRENT_DATA) {
		return Promise.resolve();
	}
	return new Promise((resolve, reject) => {
		const clean = () => {
			clearTimeout(timer);
			video.removeEventListener("loadeddata", onFrame);
			video.removeEventListener("canplay", onFrame);
			video.removeEventListener("error", onError);
			signal?.removeEventListener("abort", onAbort);
		};
		const onFrame = () => {
			if (video.readyState >= video.HAVE_CURRENT_DATA) {
				clean();
				resolve();
			}
		};
		const onError = () => {
			clean();
			reject(new Error("Video frame unavailable"));
		};
		const onAbort = () => {
			clean();
			reject(new DOMException("Enhancement start aborted", "AbortError"));
		};
		const timer = setTimeout(() => {
			clean();
			reject(new Error("Timed out waiting for a decoded video frame"));
		}, timeoutMs);
		video.addEventListener("loadeddata", onFrame);
		video.addEventListener("canplay", onFrame);
		video.addEventListener("error", onError);
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}
