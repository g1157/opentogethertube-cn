import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mount } from "@vue/test-utils";
import { defineComponent, h, nextTick, ref } from "vue";
import { usePlayerControls } from "@/util/player-controls";

describe("player control visibility", () => {
	let wrapper: { unmount(): void };
	let controls: ReturnType<typeof usePlayerControls>;
	const pausedOrChatOpen = ref(false);
	beforeEach(() => {
		vi.useFakeTimers();
		pausedOrChatOpen.value = false;
		wrapper = mount(
			defineComponent({
				setup() {
					controls = usePlayerControls(() => pausedOrChatOpen.value);
					return () => h("div");
				},
			}),
		);
	});
	afterEach(() => {
		wrapper.unmount();
		vi.useRealTimers();
	});

	it("hides after three seconds and allows immediate explicit hide/show", () => {
		vi.advanceTimersByTime(2999);
		expect(controls.visible.value).toBe(true);
		vi.advanceTimersByTime(1);
		expect(controls.visible.value).toBe(false);
		controls.activity();
		expect(controls.visible.value).toBe(true);
		controls.hide();
		expect(controls.visible.value).toBe(false);
	});
	it("keeps controls while paused, in error, or reading chat", async () => {
		pausedOrChatOpen.value = true;
		await nextTick();
		vi.advanceTimersByTime(5000);
		controls.hide();
		expect(controls.visible.value).toBe(true);
		pausedOrChatOpen.value = false;
		await nextTick();
		vi.advanceTimersByTime(3000);
		expect(controls.visible.value).toBe(false);
	});
	it("does not hide during menu or slider interaction and restarts the timer on release", async () => {
		const key = Symbol("menu");
		controls.hold(key, true);
		await nextTick();
		vi.advanceTimersByTime(6000);
		expect(controls.visible.value).toBe(true);
		controls.hold(key, false);
		await nextTick();
		vi.advanceTimersByTime(2999);
		expect(controls.visible.value).toBe(true);
		vi.advanceTimersByTime(1);
		expect(controls.visible.value).toBe(false);
	});
	it("does not wake manually hidden controls on tiny mouse jitter or touch movement", () => {
		const move = (x: number, pointerType = "mouse") =>
			controls.mouseMove({
				clientX: x,
				clientY: 100,
				buttons: 0,
				pointerType,
			} as PointerEvent);
		move(100);
		controls.hide();
		move(104);
		move(130, "touch");
		expect(controls.visible.value).toBe(false);
		move(120);
		expect(controls.visible.value).toBe(true);
	});
	it("clears its timer on unmount", () => {
		wrapper.unmount();
		expect(controls.timeout.value).toBeNull();
	});
});
