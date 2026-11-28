import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mount } from "@vue/test-utils";
import { defineComponent, h } from "vue";
import { useRoomClock, ROOM_CLOCK_INTERVAL_MS } from "@/components/composables/room-clock";

describe("room position clock", () => {
	let wrapper: { unmount(): void } | null = null;
	let clock: ReturnType<typeof useRoomClock>;
	let position = 0;
	let pendingSeekTarget: number | null = null;
	let length: number | null = 600;
	let onTick: ReturnType<typeof vi.fn<[], boolean>>;
	let order: string[] = [];

	beforeEach(() => {
		vi.useFakeTimers();
		position = 100;
		pendingSeekTarget = null;
		length = 600;
		order = [];
		onTick = vi.fn<[], boolean>(() => false);
		wrapper = mount(
			defineComponent({
				setup() {
					clock = useRoomClock({
						beforeTick: () => order.push("before"),
						roomPosition: () => {
							order.push("position");
							return position;
						},
						getLength: () => length,
						getPendingSeekTarget: () => pendingSeekTarget,
						onTick,
					});
					return () => h("div");
				},
			}),
		);
	});
	afterEach(() => {
		wrapper?.unmount();
		wrapper = null;
		vi.useRealTimers();
	});

	it("updates both positions on every 250 ms tick", () => {
		expect(onTick).not.toHaveBeenCalled();
		vi.advanceTimersByTime(ROOM_CLOCK_INTERVAL_MS - 1);
		expect(onTick).not.toHaveBeenCalled();
		vi.advanceTimersByTime(1);
		expect(onTick).toHaveBeenCalledTimes(1);
		expect(clock.truePosition.value).toBe(100);
		expect(clock.sliderPosition.value).toBe(100);

		position = 100.25;
		vi.advanceTimersByTime(ROOM_CLOCK_INTERVAL_MS);
		expect(clock.truePosition.value).toBe(100.25);
		expect(clock.sliderPosition.value).toBe(100.25);
	});

	it("shows the pending seek target on the slider and clamps it to the length", () => {
		pendingSeekTarget = 900;
		clock.tick();
		expect(clock.sliderPosition.value).toBe(600);

		pendingSeekTarget = -10;
		clock.tick();
		expect(clock.sliderPosition.value).toBe(0);

		pendingSeekTarget = 300;
		clock.tick();
		expect(clock.truePosition.value).toBe(100);
		expect(clock.sliderPosition.value).toBe(300);
	});

	it("clamps to zero while the length is unknown", () => {
		length = null;
		clock.tick();
		expect(clock.truePosition.value).toBe(100);
		expect(clock.sliderPosition.value).toBe(0);
	});

	it("runs the server clock guard before the position is read", () => {
		clock.tick();
		expect(order).toEqual(["before", "position"]);
	});

	it("returns whether the rest of the tick already applied room playback", () => {
		onTick.mockReturnValue(true);
		expect(clock.tick()).toBe(true);
		onTick.mockReturnValue(false);
		expect(clock.tick()).toBe(false);
	});

	it("stops ticking when the view unmounts", () => {
		vi.advanceTimersByTime(ROOM_CLOCK_INTERVAL_MS);
		expect(onTick).toHaveBeenCalledTimes(1);

		wrapper?.unmount();
		wrapper = null;
		vi.advanceTimersByTime(ROOM_CLOCK_INTERVAL_MS * 4);
		expect(onTick).toHaveBeenCalledTimes(1);
	});
});
