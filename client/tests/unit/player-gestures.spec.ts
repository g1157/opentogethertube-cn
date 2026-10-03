import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPlayerGestures } from "@/util/player-gestures";

describe("player touch and mouse gestures", () => {
	let target: HTMLElement;
	let controls: ReturnType<typeof createPlayerGestures>;
	let options: Parameters<typeof createPlayerGestures>[0];

	function pointer(
		type: string,
		x = 200,
		y = 150,
		pointerType = "touch",
		id = 1,
		primary = true,
	) {
		const event = new MouseEvent(type, {
			clientX: x,
			clientY: y,
			button: 0,
			bubbles: true,
			cancelable: true,
		});
		Object.assign(event, { pointerId: id, pointerType, isPrimary: primary });
		target.dispatchEvent(event);
		return event;
	}

	beforeEach(() => {
		vi.useFakeTimers();
		target = document.createElement("div");
		document.body.append(target);
		target.getBoundingClientRect = () =>
			({ left: 0, top: 0, right: 800, bottom: 450, width: 800, height: 450 }) as DOMRect;
		options = {
			getPosition: () => 100,
			getBounds: () => ({ start: 0, end: 600 }),
			getSeekStep: () => 10,
			canSeek: () => true,
			isPlaying: () => true,
			onTap: vi.fn(),
			onDoubleTap: vi.fn(),
			onDoubleClick: vi.fn(),
			onSeek: vi.fn(),
			onSeekDenied: vi.fn(),
			onHoldStart: vi.fn(() => true),
			onHoldEnd: vi.fn(),
		};
		controls = createPlayerGestures(options);
		target.addEventListener("pointerdown", controls.pointerDown);
		target.addEventListener("pointermove", controls.pointerMove);
		target.addEventListener("pointerup", controls.pointerUp);
		target.addEventListener("pointercancel", controls.pointerCancel);
		target.addEventListener("lostpointercapture", controls.pointerCancel);
		target.addEventListener("pointerleave", controls.pointerLeave);
	});
	afterEach(() => {
		controls.cancel();
		target.remove();
		vi.useRealTimers();
	});

	it("toggles controls immediately on a single tap", () => {
		pointer("pointerdown");
		pointer("pointerup");
		expect(options.onTap).toHaveBeenCalledOnce();
		vi.advanceTimersByTime(279);
		expect(options.onTap).toHaveBeenCalledOnce();
		vi.advanceTimersByTime(1);
		expect(options.onTap).toHaveBeenCalledOnce();
		expect(options.onDoubleTap).not.toHaveBeenCalled();
		expect(options.onHoldStart).not.toHaveBeenCalled();
		expect(options.onSeek).not.toHaveBeenCalled();
	});

	it.each([
		true,
		false,
	])("double-taps change playback once, including while playing=%s", playing => {
		options.isPlaying = () => playing;
		pointer("pointerdown");
		pointer("pointerup");
		pointer("lostpointercapture");
		vi.advanceTimersByTime(150);
		pointer("pointerdown", 220);
		pointer("pointerup", 220);
		vi.advanceTimersByTime(500);
		expect(options.onDoubleTap).toHaveBeenCalledOnce();
		expect(options.onDoubleClick).not.toHaveBeenCalled();
		// The first tap toggled immediately; the second press rolls the toggle back.
		expect(options.onTap).toHaveBeenCalledTimes(2);
		expect(options.onHoldStart).not.toHaveBeenCalled();
		expect(options.onSeek).not.toHaveBeenCalled();
	});

	it("keeps taps separated by time, distance or input type as single taps", () => {
		pointer("pointerdown");
		pointer("pointerup");
		vi.advanceTimersByTime(300);
		pointer("pointerdown");
		pointer("pointerup");
		vi.advanceTimersByTime(100);
		pointer("pointerdown", 350);
		pointer("pointerup", 350);
		vi.advanceTimersByTime(100);
		pointer("pointerdown", 350, 150, "mouse");
		pointer("pointerup", 350, 150, "mouse");
		vi.advanceTimersByTime(300);
		expect(options.onTap).toHaveBeenCalledTimes(4);
		expect(options.onDoubleTap).not.toHaveBeenCalled();
		expect(options.onDoubleClick).not.toHaveBeenCalled();
	});

	it("rolls back the first tap when the second press becomes a hold", () => {
		pointer("pointerdown");
		pointer("pointerup");
		vi.advanceTimersByTime(100);
		pointer("pointerdown");
		vi.advanceTimersByTime(500);
		pointer("pointerup");
		vi.advanceTimersByTime(300);
		expect(options.onHoldStart).toHaveBeenCalledOnce();
		expect(options.onHoldEnd).toHaveBeenCalledOnce();
		expect(options.onTap).toHaveBeenCalledTimes(2);
		expect(options.onDoubleTap).not.toHaveBeenCalled();
	});

	it("rolls back the first tap when the second press becomes a swipe", () => {
		pointer("pointerdown");
		pointer("pointerup");
		vi.advanceTimersByTime(100);
		pointer("pointerdown");
		pointer("pointermove", 260);
		pointer("pointerup", 260);
		vi.advanceTimersByTime(500);
		expect(options.onSeek).toHaveBeenCalledOnce();
		expect(options.onTap).toHaveBeenCalledTimes(2);
		expect(options.onDoubleTap).not.toHaveBeenCalled();
		expect(options.onHoldStart).not.toHaveBeenCalled();
	});

	it("does not turn a long press while paused into double-tap playback", () => {
		options.isPlaying = () => false;
		pointer("pointerdown");
		pointer("pointerup");
		vi.advanceTimersByTime(100);
		pointer("pointerdown");
		vi.advanceTimersByTime(600);
		pointer("pointerup");
		vi.advanceTimersByTime(300);
		expect(options.onTap).toHaveBeenCalledTimes(2);
		expect(options.onDoubleTap).not.toHaveBeenCalled();
	});

	it("keeps a completed tap after cancellation", () => {
		pointer("pointerdown");
		pointer("pointerup");
		expect(options.onTap).toHaveBeenCalledOnce();
		controls.cancel();
		vi.advanceTimersByTime(500);
		expect(options.onTap).toHaveBeenCalledOnce();
		expect(options.onDoubleTap).not.toHaveBeenCalled();
	});

	it("adjusts the levels on a vertical drag once fullscreen says it may", () => {
		const levels = {
			canAdjustLevels: () => true,
			onLevelStart: vi.fn(),
			onLevelMove: vi.fn(),
			onLevelEnd: vi.fn(),
		};
		Object.assign(options, levels);

		// Right half: the surface is 450px tall, so a 45px pull down is a tenth of the range.
		pointer("pointerdown", 600, 100);
		pointer("pointermove", 600, 145);
		expect(levels.onLevelStart).toHaveBeenCalledWith("right");
		expect(levels.onLevelMove).toHaveBeenCalledWith("right", -45 / 450);
		pointer("pointerup", 600, 145);
		expect(levels.onLevelEnd).toHaveBeenCalledWith("right");
		expect(options.onSeek).not.toHaveBeenCalled();
		expect(options.onTap).not.toHaveBeenCalled();

		// Left half, dragging up. Reports are incremental, so a second move carries on from
		// the previous position rather than from where the gesture started — that is what
		// lets the finger keep pulling (or come back) without the screen edge being a limit.
		pointer("pointerdown", 100, 300);
		pointer("pointermove", 100, 250);
		expect(levels.onLevelStart).toHaveBeenLastCalledWith("left");
		expect(levels.onLevelMove).toHaveBeenLastCalledWith("left", 50 / 450);
		pointer("pointermove", 100, 200);
		expect(levels.onLevelMove).toHaveBeenLastCalledWith("left", 50 / 450);
		pointer("pointerup", 100, 200);
		expect(levels.onLevelEnd).toHaveBeenLastCalledWith("left");
	});

	it("keeps a level drag alive when the pointer leaves the surface", () => {
		const levels = {
			canAdjustLevels: () => true,
			onLevelStart: vi.fn(),
			onLevelMove: vi.fn(),
			onLevelEnd: vi.fn(),
		};
		Object.assign(options, levels);

		pointer("pointerdown", 100, 300);
		pointer("pointermove", 100, 250);
		expect(levels.onLevelMove).toHaveBeenLastCalledWith("left", 50 / 450);
		// The finger may roam past the element (and past the surface's own edge) while the
		// viewer is still dragging: that used to end the gesture halfway through.
		pointer("pointerleave", 100, 250);
		pointer("pointermove", 100, 200);
		expect(levels.onLevelMove).toHaveBeenLastCalledWith("left", 50 / 450);
		pointer("pointerup", 100, 200);
		expect(levels.onLevelEnd).toHaveBeenCalledOnce();
	});

	it("leaves a vertical drag to the page when the levels are unavailable", () => {
		const onLevelMove = vi.fn();
		options.canAdjustLevels = () => false;
		options.onLevelMove = onLevelMove;
		pointer("pointerdown", 600, 100);
		pointer("pointermove", 600, 200);
		pointer("pointerup", 600, 200);
		expect(onLevelMove).not.toHaveBeenCalled();
		expect(options.onSeek).not.toHaveBeenCalled();
		expect(options.onTap).not.toHaveBeenCalled();
	});

	it.each([5, 10, 30])("previews a %s second jump locally and seeks once on release", step => {
		options.getSeekStep = () => step;
		pointer("pointerdown");
		pointer("pointermove", 250);
		expect(controls.preview.value?.position).toBe(100 + step);
		expect(options.onSeek).not.toHaveBeenCalled();
		pointer("pointermove", 350);
		pointer("pointerup", 350);
		pointer("pointerup", 350);
		expect(options.onSeek).toHaveBeenCalledOnce();
		expect(options.onSeek).toHaveBeenCalledWith(100 + step);
		expect(options.onTap).not.toHaveBeenCalled();
		expect(controls.preview.value).toBeNull();
	});

	it("swipes left to rewind and clamps the target to the video boundaries", () => {
		options.getPosition = () => 3;
		pointer("pointerdown");
		pointer("pointermove", 150);
		pointer("pointerup", 150);
		expect(options.onSeek).toHaveBeenLastCalledWith(0);
		options.getPosition = () => 596;
		pointer("pointerdown");
		pointer("pointermove", 250);
		pointer("pointerup", 250);
		expect(options.onSeek).toHaveBeenLastCalledWith(600);
	});

	it("cancels the long-press timer once a swipe starts", () => {
		pointer("pointerdown");
		pointer("pointermove", 250);
		vi.advanceTimersByTime(1000);
		pointer("pointerup", 250);
		expect(options.onHoldStart).not.toHaveBeenCalled();
		expect(options.onSeek).toHaveBeenCalledOnce();
	});

	it("preserves vertical scrolling and never interprets it as a tap or a long press", () => {
		pointer("pointerdown");
		const move = pointer("pointermove", 210, 220);
		vi.advanceTimersByTime(700);
		pointer("pointerup", 270, 225);
		expect(move.defaultPrevented).toBe(false);
		expect(options.onTap).not.toHaveBeenCalled();
		expect(options.onSeek).not.toHaveBeenCalled();
		expect(options.onHoldStart).not.toHaveBeenCalled();
	});

	it("holds after 500 ms and releases without an extra tap or swipe", () => {
		pointer("pointerdown");
		vi.advanceTimersByTime(499);
		expect(options.onHoldStart).not.toHaveBeenCalled();
		vi.advanceTimersByTime(1);
		pointer("pointermove", 270);
		pointer("pointerup", 270);
		expect(options.onHoldStart).toHaveBeenCalledOnce();
		expect(options.onHoldEnd).toHaveBeenCalledOnce();
		expect(options.onTap).not.toHaveBeenCalled();
		expect(options.onSeek).not.toHaveBeenCalled();
	});

	it.each(["pointercancel", "lostpointercapture"])("ends an active hold on %s", event => {
		pointer("pointerdown");
		vi.advanceTimersByTime(500);
		pointer(event);
		pointer("pointerup");
		expect(options.onHoldEnd).toHaveBeenCalledOnce();
		expect(options.onTap).not.toHaveBeenCalled();
	});

	it("ends a hold when the pointer leaves the picture", () => {
		pointer("pointerdown");
		vi.advanceTimersByTime(500);
		pointer("pointermove", 850);
		pointer("pointerup", 850);
		expect(options.onHoldEnd).toHaveBeenCalledOnce();
		expect(options.onSeek).not.toHaveBeenCalled();
	});

	it("does not treat a denied long press as a tap", () => {
		vi.spyOn(options, "onHoldStart").mockReturnValue(false);
		pointer("pointerdown");
		vi.advanceTimersByTime(500);
		pointer("pointerup");
		expect(options.onTap).not.toHaveBeenCalled();
	});

	it("preserves edge navigation and cancels multi-touch", () => {
		pointer("pointerdown", 10);
		pointer("pointermove", 80);
		pointer("pointerup", 80);
		pointer("pointerdown");
		pointer("pointerdown", 250, 150, "touch", 2, false);
		vi.advanceTimersByTime(700);
		pointer("pointerup");
		expect(options.onTap).not.toHaveBeenCalled();
		expect(options.onHoldStart).not.toHaveBeenCalled();
		expect(options.onSeek).not.toHaveBeenCalled();
	});

	it("checks seek permission and disables swipes for unseekable live streams", () => {
		options.canSeek = () => false;
		pointer("pointerdown");
		pointer("pointermove", 260);
		pointer("pointerup", 260);
		expect(options.onSeekDenied).toHaveBeenCalledOnce();
		options.canSeek = () => true;
		options.getBounds = () => null;
		pointer("pointerdown");
		pointer("pointermove", 260);
		pointer("pointerup", 260);
		expect(options.onSeek).not.toHaveBeenCalled();
	});

	it("separates desktop double-click fullscreen from instant single-click toggling", () => {
		pointer("pointerdown", 200, 150, "mouse");
		pointer("pointerup", 200, 150, "mouse");
		pointer("lostpointercapture", 200, 150, "mouse");
		vi.advanceTimersByTime(100);
		pointer("pointerdown", 200, 150, "mouse");
		pointer("pointerup", 200, 150, "mouse");
		vi.advanceTimersByTime(300);
		expect(options.onDoubleClick).toHaveBeenCalledOnce();
		// The toggle from the first click and its rollback cancel out.
		expect(options.onTap).toHaveBeenCalledTimes(2);
		pointer("pointerdown", 200, 150, "mouse");
		pointer("pointerup", 200, 150, "mouse");
		vi.advanceTimersByTime(300);
		expect(options.onTap).toHaveBeenCalledTimes(3);
	});
});
