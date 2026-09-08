import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import type { MediaPlayerError } from "@/components/composables/media-player";
import { createMediaRecovery, nativeMediaError } from "@/util/media-recovery";

describe("media error recovery", () => {
	let media: HTMLVideoElement;
	let restart: Mock<[MediaPlayerError, boolean], void | Promise<void>>;
	let onError: ReturnType<typeof vi.fn>;
	let onRecovering: ReturnType<typeof vi.fn>;
	let recovery: ReturnType<typeof createMediaRecovery>;

	beforeEach(() => {
		vi.useFakeTimers();
		media = document.createElement("video");
		Object.defineProperties(media, {
			readyState: { configurable: true, value: 4 },
			duration: { configurable: true, value: 1800 },
		});
		vi.spyOn(media, "play").mockResolvedValue(undefined);
		vi.spyOn(media, "pause").mockImplementation(() => undefined);
		restart = vi.fn();
		onError = vi.fn();
		onRecovering = vi.fn();
		recovery = createMediaRecovery({ media: () => media, restart, onError, onRecovering });
		recovery.canPlay();
	});

	afterEach(() => {
		recovery.dispose();
		vi.restoreAllMocks();
		vi.useRealTimers();
	});

	it("starts an attached source before canplay even when the browser does not preload", async () => {
		recovery.reset();
		Object.defineProperty(media, "readyState", { configurable: true, value: 0 });
		recovery.play();
		expect(media.play).not.toHaveBeenCalled();
		media.src = "https://media.example/episode.mp4";
		const playing = recovery.play();
		expect(media.play).toHaveBeenCalledOnce();
		await playing;
		expect(media.readyState).toBe(0);
		expect(recovery.isRecovering()).toBe(true);
	});

	it("does not issue repeated native play calls while a recovery is queued or running", () => {
		media.src = "https://media.example/episode.mp4";
		recovery.handleError({ type: "network" });
		recovery.play();
		expect(media.play).not.toHaveBeenCalled();
		vi.advanceTimersByTime(1000);
		recovery.play();
		expect(restart).toHaveBeenCalledOnce();
		expect(media.play).not.toHaveBeenCalled();
	});

	it("retries network errors three times with backoff and then exposes the error", () => {
		recovery.handleError({ type: "network" });
		recovery.handleError({ type: "network" });
		vi.advanceTimersByTime(999);
		expect(restart).not.toHaveBeenCalled();
		vi.advanceTimersByTime(1);
		expect(restart).toHaveBeenCalledTimes(1);
		recovery.handleError({ type: "network" });
		vi.advanceTimersByTime(2999);
		expect(restart).toHaveBeenCalledTimes(1);
		vi.advanceTimersByTime(1);
		expect(restart).toHaveBeenCalledTimes(2);
		recovery.handleError({ type: "network" });
		vi.advanceTimersByTime(6000);
		expect(restart).toHaveBeenCalledTimes(3);
		recovery.handleError({ type: "network" });
		expect(onError).toHaveBeenCalledOnce();
		expect(onError).toHaveBeenCalledWith({ type: "network" });
		expect(recovery.isFailed()).toBe(true);
		vi.advanceTimersByTime(120000);
		expect(restart).toHaveBeenCalledTimes(3);
	});

	it("also finishes when reload silently hangs without firing another media error", () => {
		recovery.handleError({ type: "network" });
		vi.advanceTimersByTime(100001);
		expect(restart).toHaveBeenCalledTimes(3);
		expect(onError).toHaveBeenCalledOnce();
		expect(onError).toHaveBeenCalledWith({ type: "network" });
		expect(recovery.isRecovering()).toBe(false);
	});

	it("does not change the pending recovery strategy when another layer reports the same failure", () => {
		recovery.handleError({ type: "decode" });
		recovery.handleError({ type: "network" });
		vi.advanceTimersByTime(1000);
		expect(restart).toHaveBeenCalledWith({ type: "decode" }, false);
		recovery.handleError({ type: "decode" });
		expect(onError).toHaveBeenCalledWith({ type: "decode" });
		expect(restart).toHaveBeenCalledOnce();
	});

	it("tries a decoder reset once and does not automatically retry unsupported or denied sources", () => {
		recovery.handleError({ type: "decode" });
		vi.advanceTimersByTime(1000);
		expect(restart).toHaveBeenCalledOnce();
		expect(restart).toHaveBeenCalledWith({ type: "decode" }, false);
		recovery.handleError({ type: "decode" });
		expect(onError).toHaveBeenLastCalledWith({ type: "decode" });
		recovery.reset();
		recovery.handleError({ type: "unsupported", retryable: false });
		expect(onError).toHaveBeenLastCalledWith({ type: "unsupported", retryable: false });
		recovery.reset();
		recovery.handleError({ type: "network", retryable: false });
		vi.advanceTimersByTime(60000);
		expect(restart).toHaveBeenCalledTimes(1);
		expect(onError).toHaveBeenLastCalledWith({ type: "network", retryable: false });
	});

	it("restores position and speed, including a seek and pause received during recovery", () => {
		media.currentTime = 123.5;
		media.playbackRate = 1.5;
		recovery.play();
		recovery.handleError({ type: "network" });
		expect(recovery.getPosition()).toBe(123.5);
		media.currentTime = 0;
		media.playbackRate = 1;
		recovery.setPosition(150.25);
		recovery.setPlaybackRate(0.75);
		recovery.pause();
		expect(media.currentTime).toBe(0);
		expect(recovery.canPlay()).toBe(false);
		vi.advanceTimersByTime(1000);
		expect(recovery.canPlay()).toBe(true);
		expect(media.currentTime).toBe(150.25);
		expect(media.playbackRate).toBe(0.75);
		expect(media.play).toHaveBeenCalledTimes(1);
		expect(media.pause).toHaveBeenCalled();
		expect(recovery.isRecovering()).toBe(false);
	});

	it("keeps its retry budget after a brief success and resets it for an explicit local retry", () => {
		for (let attempt = 0; attempt < 3; attempt++) {
			recovery.handleError({ type: "network" });
			vi.advanceTimersByTime([1000, 3000, 6000][attempt]);
			recovery.canPlay();
		}
		media.currentTime = 210;
		recovery.handleError({ type: "network" });
		expect(onError).toHaveBeenCalledTimes(1);
		recovery.retry();
		expect(restart).toHaveBeenLastCalledWith({ type: "network" }, true);
		media.currentTime = 0;
		recovery.canPlay();
		expect(media.currentTime).toBe(210);
		recovery.handleError({ type: "network" });
		vi.advanceTimersByTime(1000);
		expect(restart).toHaveBeenCalledTimes(5);
		expect(onError).toHaveBeenCalledTimes(1);
	});

	it("cancels queued recovery on source changes and releases timers on disposal", () => {
		media.currentTime = 70;
		recovery.handleError({ type: "network" });
		recovery.reset();
		expect(recovery.getPosition()).toBe(0);
		vi.advanceTimersByTime(120000);
		expect(restart).not.toHaveBeenCalled();
		recovery.handleError({ type: "network" });
		recovery.dispose();
		vi.advanceTimersByTime(120000);
		expect(restart).not.toHaveBeenCalled();
		expect(onError).not.toHaveBeenCalled();
		expect(vi.getTimerCount()).toBe(0);
	});

	it("ignores an old asynchronous reload rejection after switching source", async () => {
		let rejectReload: (error: Error) => void = () => undefined;
		restart.mockReturnValue(
			new Promise<void>((_resolve, reject) => {
				rejectReload = reject;
			}),
		);
		recovery.handleError({ type: "network" });
		vi.advanceTimersByTime(1000);
		recovery.reset();
		rejectReload(new Error("old request"));
		await Promise.resolve();
		vi.advanceTimersByTime(120000);
		expect(restart).toHaveBeenCalledTimes(1);
		expect(onError).not.toHaveBeenCalled();
	});

	it("ignores media aborts from source changes and classifies native network/decoder failures", () => {
		const error = (code: number) => ({ code, message: "test" }) as MediaError;
		expect(nativeMediaError(error(1))).toBeUndefined();
		expect(nativeMediaError(null)).toBeUndefined();
		expect(nativeMediaError(error(2))).toEqual({ type: "network" });
		expect(nativeMediaError(error(3))).toEqual({ type: "decode" });
		expect(nativeMediaError(error(4))).toEqual({ type: "unsupported", retryable: false });
	});
});
