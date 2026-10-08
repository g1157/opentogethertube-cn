import { afterEach, describe, expect, it, vi } from "vitest";
import { nextTick } from "vue";
import RoomConnectionNotice from "@/components/RoomConnectionNotice.vue";
import { mountComponent } from "./component-test-utils";

const GRACE_MS = 10_000;

describe("room connection notice", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("stays quiet through a short interruption and only appears once the retries keep failing", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		const { wrapper, connection } = mountComponent(RoomConnectionNotice);
		expect(wrapper.find('[data-cy="connection-notice"]').exists()).toBe(false);

		// The socket dropped and the client is already auto-reconnecting: no alert yet.
		connection.active.value = true;
		connection.issue.value = "network";
		await nextTick();
		vi.advanceTimersByTime(GRACE_MS - 1);
		await nextTick();
		expect(wrapper.find('[data-cy="connection-notice"]').exists()).toBe(false);

		vi.advanceTimersByTime(1);
		await nextTick();
		expect(wrapper.find('[data-cy="connection-notice"]').exists()).toBe(true);
		expect(wrapper.text()).toContain("连接中断");
	});

	it("recovers silently when the reconnect succeeds inside the grace window", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		const { wrapper, connection } = mountComponent(RoomConnectionNotice);
		connection.active.value = true;
		connection.issue.value = "network";
		await nextTick();

		connection.connected.value = true;
		connection.issue.value = null;
		await nextTick();
		vi.advanceTimersByTime(60_000);
		await nextTick();
		expect(wrapper.find('[data-cy="connection-notice"]').exists()).toBe(false);

		// A fresh interruption gets its own full grace window; the old timer must not leak.
		connection.connected.value = false;
		connection.issue.value = "network";
		await nextTick();
		vi.advanceTimersByTime(GRACE_MS - 1);
		await nextTick();
		expect(wrapper.find('[data-cy="connection-notice"]').exists()).toBe(false);
	});

	it("offers retry after a timeout and disappears when the room reconnects", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		const { wrapper, connection } = mountComponent(RoomConnectionNotice);
		connection.active.value = true;
		connection.issue.value = "timeout";
		await nextTick();
		vi.advanceTimersByTime(GRACE_MS);
		await nextTick();
		expect(wrapper.text()).toContain("连接超时");
		expect(wrapper.text()).toContain("WebSocket");
		const retry = vi.spyOn(connection, "reconnect");
		await wrapper.get("button").trigger("click");
		expect(retry).toHaveBeenCalledOnce();
		connection.connected.value = true;
		await nextTick();
		expect(wrapper.find('[data-cy="connection-notice"]').exists()).toBe(false);
	});
});
