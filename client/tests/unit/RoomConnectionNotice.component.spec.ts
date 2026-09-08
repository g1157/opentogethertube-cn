import { describe, expect, it, vi } from "vitest";
import { nextTick } from "vue";
import RoomConnectionNotice from "@/components/RoomConnectionNotice.vue";
import { mountComponent } from "./component-test-utils";

describe("room connection notice", () => {
	it("offers retry after a timeout and disappears when the room reconnects", async () => {
		const { wrapper, connection } = mountComponent(RoomConnectionNotice);
		expect(wrapper.find('[data-cy="connection-notice"]').exists()).toBe(false);
		connection.active.value = true;
		connection.issue.value = "timeout";
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
