import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mount } from "@vue/test-utils";
import { defineComponent, h, nextTick, ref } from "vue";
import { useTemporaryPlaybackSpeed } from "@/util/temporary-playback-speed";
import type { TemporaryPlaybackSpeed } from "ott-common/models/messages";
import type { VideoId } from "ott-common/models/video";

describe("client temporary speed lifetime", () => {
	let wrapper: { unmount(): void };
	let controller: ReturnType<typeof useTemporaryPlaybackSpeed>;
	const connected = ref(true);
	const video = ref<VideoId | null>(null);
	const roomGesture = ref<TemporaryPlaybackSpeed | null>(null);
	let send: ReturnType<typeof vi.fn>;
	let rejected: ReturnType<typeof vi.fn>;
	beforeEach(() => {
		vi.useFakeTimers();
		connected.value = true;
		video.value = { service: "direct", id: "test.mp4" };
		roomGesture.value = null;
		send = vi.fn();
		rejected = vi.fn();
		wrapper = mount(
			defineComponent({
				setup() {
					controller = useTemporaryPlaybackSpeed({
						connected: () => connected.value,
						clientId: () => "alice",
						currentVideo: () => video.value,
						roomGesture: () => roomGesture.value,
						canStart: () => true,
						send,
						onRejected: rejected,
					});
					return () => h("div");
				},
			}),
		);
	});
	afterEach(() => {
		wrapper.unmount();
		vi.useRealTimers();
	});
	function acknowledge() {
		roomGesture.value = { clientId: "alice", gestureId: controller.gestureId.value!, speed: 2 };
	}

	it("renews the same gesture and releases without guessing the previous speed", () => {
		expect(controller.start()).toBe(true);
		const id = controller.gestureId.value;
		acknowledge();
		vi.advanceTimersByTime(2000);
		expect(send).toHaveBeenCalledWith("renew", id, video.value);
		controller.stop();
		vi.advanceTimersByTime(6000);
		expect(send).toHaveBeenLastCalledWith("stop", id, video.value);
		expect(controller.gestureId.value).toBeNull();
		expect(rejected).not.toHaveBeenCalled();
	});
	it("stops sending heartbeats when another viewer overrides the speed", () => {
		controller.start();
		acknowledge();
		roomGesture.value = null;
		send.mockClear();
		vi.advanceTimersByTime(5000);
		controller.stop();
		expect(send).not.toHaveBeenCalled();
		expect(controller.gestureId.value).toBeNull();
	});
	it("cancels a request that is never acknowledged", () => {
		controller.start();
		vi.advanceTimersByTime(2500);
		expect(rejected).toHaveBeenCalledOnce();
		expect(send.mock.calls.at(-1)?.[0]).toBe("stop");
		expect(controller.gestureId.value).toBeNull();
	});
	it("does not send through a disconnected socket", async () => {
		controller.start();
		acknowledge();
		connected.value = false;
		await nextTick();
		send.mockClear();
		vi.advanceTimersByTime(5000);
		expect(send).not.toHaveBeenCalled();
		expect(controller.start()).toBe(false);
	});
	it("cleans up if the socket closes between a connection check and sending", () => {
		send.mockImplementation(() => {
			throw new Error("socket closed");
		});
		expect(controller.start()).toBe(false);
		expect(controller.gestureId.value).toBeNull();
		expect(rejected).toHaveBeenCalledOnce();
	});
	it("releases the original video on a source change or unmount", async () => {
		controller.start();
		acknowledge();
		const id = controller.gestureId.value;
		video.value = { service: "direct", id: "next.mp4" };
		await nextTick();
		expect(send).toHaveBeenLastCalledWith("stop", id, { service: "direct", id: "test.mp4" });
		roomGesture.value = null;
		controller.start();
		acknowledge();
		const nextId = controller.gestureId.value;
		wrapper.unmount();
		expect(send).toHaveBeenLastCalledWith("stop", nextId, video.value);
	});
});
