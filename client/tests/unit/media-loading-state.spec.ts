import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	createMediaLoadingState,
	getBufferAhead,
	type MediaLoadingState,
} from "@/util/media-loading-state";

function ranges(values: [number, number][]): TimeRanges {
	return {
		length: values.length,
		start: index => values[index][0],
		end: index => values[index][1],
	};
}

describe("local media frame readiness", () => {
	let video: HTMLVideoElement;
	let controller: ReturnType<typeof createMediaLoadingState>;
	let states: MediaLoadingState[];
	let frameCallbacks: Map<number, VideoFrameRequestCallback>;
	let nextFrameId: number;
	let audioOnly: boolean;
	let hidden: boolean;
	let mediaState: {
		readyState: number;
		currentTime: number;
		paused: boolean;
		seeking: boolean;
		videoWidth: number;
		videoHeight: number;
		buffered: TimeRanges;
		error: MediaError | null;
	};

	function event(name: string) {
		video.dispatchEvent(new Event(name));
	}

	function frame(id = nextFrameId, mediaTime = mediaState.currentTime) {
		frameCallbacks.get(id)!(0, {
			mediaTime,
			width: 1280,
			height: 720,
			presentedFrames: 1,
			expectedDisplayTime: 0,
			presentationTime: 0,
		});
	}

	function last() {
		return states.at(-1)!;
	}

	beforeEach(() => {
		vi.useFakeTimers();
		audioOnly = false;
		hidden = false;
		vi.spyOn(document, "hidden", "get").mockImplementation(() => hidden);
		video = document.createElement("video");
		mediaState = {
			readyState: 0,
			currentTime: 0,
			paused: true,
			seeking: false,
			videoWidth: 0,
			videoHeight: 0,
			buffered: ranges([]),
			error: null,
		};
		for (const key of Object.keys(mediaState) as (keyof typeof mediaState)[]) {
			Object.defineProperty(video, key, { configurable: true, get: () => mediaState[key] });
		}
		nextFrameId = 0;
		frameCallbacks = new Map();
		Object.defineProperties(video, {
			requestVideoFrameCallback: {
				configurable: true,
				value: vi.fn((callback: VideoFrameRequestCallback) => {
					frameCallbacks.set(++nextFrameId, callback);
					return nextFrameId;
				}),
			},
			cancelVideoFrameCallback: { configurable: true, value: vi.fn() },
		});
		states = [];
		controller = createMediaLoadingState({
			media: () => video,
			onChange: state => states.push(state),
			isAudioOnly: () => audioOnly,
		});
		controller.attach();
		controller.reset();
	});

	afterEach(() => {
		controller.dispose();
		vi.restoreAllMocks();
		vi.useRealTimers();
	});

	it("waits for the first presented frame even after canplay, playing and time progression", () => {
		expect(last()).toEqual({ phase: "preparing", currentTime: null, bufferAhead: null });
		event("loadstart");
		mediaState.readyState = 1;
		mediaState.currentTime = 310;
		event("loadedmetadata");
		expect(last().phase).toBe("buffering");
		mediaState.readyState = 4;
		mediaState.videoWidth = 1280;
		mediaState.videoHeight = 720;
		mediaState.buffered = ranges([[300, 350]]);
		event("loadeddata");
		event("canplay");
		event("playing");
		mediaState.currentTime = 311;
		event("timeupdate");
		expect(last()).toEqual({ phase: "waiting-frame", currentTime: 311, bufferAhead: 39 });
		expect(video.requestVideoFrameCallback).toHaveBeenCalledOnce();
		frame();
		expect(last().phase).toBeNull();
		const emissions = states.length;
		mediaState.currentTime = 312;
		event("timeupdate");
		vi.advanceTimersByTime(60000);
		expect(states).toHaveLength(emissions);
		expect(video.requestVideoFrameCallback).toHaveBeenCalledOnce();
		expect(vi.getTimerCount()).toBe(0);
	});

	it("accepts the first displayed frame while paused without issuing a play or seeking command", () => {
		const play = vi.spyOn(video, "play");
		event("loadstart");
		mediaState.readyState = 2;
		event("loadeddata");
		frame();
		expect(last().phase).toBeNull();
		expect(play).not.toHaveBeenCalled();
		expect(mediaState.currentTime).toBe(0);
	});

	it.each([
		0, 1,
	])("does not accept a queued frame without current media data (readyState %s)", readyState => {
		mediaState.readyState = readyState;
		event("loadstart");
		frame();
		expect(last().phase).not.toBeNull();
		mediaState.readyState = 2;
		event("loadeddata");
		frame();
		expect(last().phase).toBeNull();
	});

	it("ignores a late native error event when the replacement source has no current media error", () => {
		mediaState.readyState = 4;
		event("canplay");
		mediaState.readyState = 0;
		controller.reset();
		event("loadstart");
		event("error");
		mediaState.readyState = 4;
		event("canplay");
		frame();
		expect(last().phase).toBeNull();
	});

	it("invalidates old source callbacks without cancelling the replacement source's callback", () => {
		event("loadstart");
		const oldFrame = nextFrameId;
		controller.reset();
		event("loadstart");
		const newFrame = nextFrameId;
		expect(video.cancelVideoFrameCallback).toHaveBeenCalledWith(oldFrame);
		mediaState.readyState = 4;
		mediaState.currentTime = 310;
		event("canplay");
		frame(oldFrame, 310);
		expect(last().phase).toBe("waiting-frame");
		expect(video.cancelVideoFrameCallback).not.toHaveBeenCalledWith(newFrame);
		frame(newFrame);
		expect(last().phase).toBeNull();
	});

	it("requires a frame at the new seek position and ignores both cancelled and wrong-time frames", () => {
		mediaState.readyState = 4;
		event("canplay");
		const beforeSeek = nextFrameId;
		mediaState.currentTime = 310;
		mediaState.seeking = true;
		event("seeking");
		expect(last().phase).toBe("seeking");
		frame(beforeSeek, 310);
		expect(last().phase).toBe("seeking");
		mediaState.seeking = false;
		event("seeked");
		frame(nextFrameId, 0);
		expect(last().phase).toBe("waiting-frame");
		event("timeupdate");
		frame();
		expect(last().phase).toBeNull();
	});

	it("does not clear fallback loading until the current frame has video dimensions and data", () => {
		Reflect.deleteProperty(video, "requestVideoFrameCallback");
		mediaState.readyState = 4;
		event("canplay");
		event("playing");
		expect(last().phase).toBe("waiting-frame");
		mediaState.videoWidth = 1280;
		mediaState.videoHeight = 720;
		mediaState.readyState = 1;
		event("loadedmetadata");
		expect(last().phase).toBe("buffering");
		mediaState.readyState = 2;
		event("loadeddata");
		expect(last().phase).toBeNull();
		mediaState.seeking = true;
		event("seeking");
		event("loadeddata");
		expect(last().phase).toBe("seeking");
		mediaState.seeking = false;
		event("seeked");
		expect(last().phase).toBeNull();
	});

	it("keeps a matching paused seek frame that arrives before seeked", () => {
		mediaState.readyState = 4;
		event("canplay");
		frame();
		const previousFrame = nextFrameId;
		mediaState.currentTime = 310;
		mediaState.seeking = true;
		event("seeking");
		expect(nextFrameId).toBeGreaterThan(previousFrame);
		frame();
		expect(last().phase).toBe("seeking");
		mediaState.seeking = false;
		event("seeked");
		expect(last().phase).toBeNull();
	});

	it("observes a replacement frame after a wrong-time callback even without another media event", () => {
		mediaState.readyState = 4;
		mediaState.currentTime = 310;
		event("canplay");
		const wrongFrame = nextFrameId;
		frame(wrongFrame, 0);
		expect(nextFrameId).toBeGreaterThan(wrongFrame);
		frame();
		expect(last().phase).toBeNull();
	});

	it("falls back to current frame data if the frame callback API throws", () => {
		vi.mocked(video.requestVideoFrameCallback).mockImplementation(() => {
			throw new DOMException("Not available", "NotSupportedError");
		});
		mediaState.readyState = 2;
		mediaState.videoWidth = 1280;
		mediaState.videoHeight = 720;
		event("loadeddata");
		expect(last().phase).toBeNull();
		expect(video.requestVideoFrameCallback).toHaveBeenCalledOnce();
	});

	it("does not wait for nonexistent video frames on a declared audio source", () => {
		audioOnly = true;
		event("loadstart");
		mediaState.readyState = 1;
		event("loadedmetadata");
		expect(last().phase).toBe("buffering");
		mediaState.readyState = 2;
		event("loadeddata");
		expect(last().phase).toBeNull();
		expect(video.requestVideoFrameCallback).not.toHaveBeenCalled();
	});

	it("recognizes native audio-only tracks without guessing from zero video dimensions", () => {
		mediaState.readyState = 2;
		event("loadeddata");
		expect(last().phase).toBe("waiting-frame");
		Object.defineProperties(video, {
			audioTracks: { value: { length: 1 } },
			videoTracks: { value: { length: 0 } },
		});
		controller.refresh();
		expect(last().phase).toBeNull();
		expect(video.cancelVideoFrameCallback).toHaveBeenCalledWith(nextFrameId);
	});

	it("keeps the paused displayed frame available after a wait and cancels the pending callback", () => {
		mediaState.readyState = 4;
		mediaState.paused = false;
		event("canplay");
		frame();
		event("stalled");
		expect(last().phase).toBeNull();
		mediaState.readyState = 2;
		event("waiting");
		expect(last().phase).toBe("buffering");
		const waitingFrame = nextFrameId;
		mediaState.paused = true;
		event("pause");
		expect(last().phase).toBeNull();
		expect(video.cancelVideoFrameCallback).toHaveBeenCalledWith(waitingFrame);
	});

	it("cancels background callbacks, resumes observation when visible, and releases listeners on disposal", () => {
		mediaState.readyState = 4;
		event("canplay");
		const backgroundFrame = nextFrameId;
		hidden = true;
		document.dispatchEvent(new Event("visibilitychange"));
		expect(video.cancelVideoFrameCallback).toHaveBeenCalledWith(backgroundFrame);
		frame(backgroundFrame);
		expect(last().phase).toBe("waiting-frame");
		event("timeupdate");
		expect(nextFrameId).toBe(backgroundFrame);
		hidden = false;
		document.dispatchEvent(new Event("visibilitychange"));
		expect(nextFrameId).toBeGreaterThan(backgroundFrame);
		const visibleFrame = nextFrameId;
		controller.dispose();
		const emissions = states.length;
		frame(visibleFrame);
		event("canplay");
		document.dispatchEvent(new Event("visibilitychange"));
		controller.reset();
		vi.advanceTimersByTime(60000);
		expect(states).toHaveLength(emissions);
		expect(nextFrameId).toBe(visibleFrame);
		expect(video.cancelVideoFrameCallback).toHaveBeenCalledWith(visibleFrame);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("stops on media errors and waits for an explicit source or recovery reset", () => {
		mediaState.readyState = 4;
		event("canplay");
		const failedFrame = nextFrameId;
		mediaState.error = { code: 3 } as MediaError;
		event("error");
		mediaState.error = null;
		frame(failedFrame);
		event("playing");
		expect(last().phase).toBe("waiting-frame");
		expect(nextFrameId).toBe(failedFrame);
		controller.reset();
		event("canplay");
		frame();
		expect(last().phase).toBeNull();
	});
});

describe("continuous media buffer ahead", () => {
	it("reports only the current buffered range, including exact boundaries and holes", () => {
		const buffered = ranges([
			[0, 30],
			[100, 120],
			[120, 130],
			[140, 200],
		]);
		expect(getBufferAhead(buffered, 20)).toBe(10);
		expect(getBufferAhead(buffered, 30)).toBe(0);
		expect(getBufferAhead(buffered, 50)).toBe(0);
		expect(getBufferAhead(buffered, 110)).toBe(20);
		expect(getBufferAhead(buffered, 130)).toBe(0);
		expect(getBufferAhead(buffered, 140)).toBe(60);
		expect(getBufferAhead(ranges([]), 0)).toBe(0);
	});

	it("returns unknown for invalid positions, nonfinite ranges or invalidated reads", () => {
		expect(getBufferAhead(ranges([[0, 10]]), Number.NaN)).toBeNull();
		expect(getBufferAhead(ranges([[0, 10]]), Number.POSITIVE_INFINITY)).toBeNull();
		expect(getBufferAhead(ranges([[0, 10]]), -1)).toBeNull();
		expect(getBufferAhead(ranges([[0, Number.POSITIVE_INFINITY]]), 5)).toBeNull();
		expect(getBufferAhead(ranges([[10, 5]]), 5)).toBeNull();
		expect(
			getBufferAhead(
				{
					length: 1,
					start: () => {
						throw new DOMException("detached");
					},
					end: () => 10,
				},
				0,
			),
		).toBeNull();
	});
});
