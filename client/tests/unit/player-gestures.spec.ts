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
	});
	afterEach(() => {
		controls.cancel();
		target.remove();
		vi.useRealTimers();
	});

	it("taps on mobile toggle controls immediately without changing playback", () => {
		pointer("pointerdown");
		pointer("pointerup");
		expect(options.onTap).toHaveBeenCalledOnce();
		expect(options.onHoldStart).not.toHaveBeenCalled();
		expect(options.onSeek).not.toHaveBeenCalled();
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

	it("separates desktop double-click fullscreen from delayed single-click toggling", () => {
		pointer("pointerdown", 200, 150, "mouse");
		pointer("pointerup", 200, 150, "mouse");
		pointer("lostpointercapture", 200, 150, "mouse");
		vi.advanceTimersByTime(100);
		pointer("pointerdown", 200, 150, "mouse");
		pointer("pointerup", 200, 150, "mouse");
		vi.advanceTimersByTime(300);
		expect(options.onDoubleClick).toHaveBeenCalledOnce();
		expect(options.onTap).not.toHaveBeenCalled();
		pointer("pointerdown", 200, 150, "mouse");
		pointer("pointerup", 200, 150, "mouse");
		vi.advanceTimersByTime(300);
		expect(options.onTap).toHaveBeenCalledOnce();
	});
});
