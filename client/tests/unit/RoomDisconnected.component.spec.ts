import { describe, expect, it, vi } from "vitest";
import RoomDisconnected from "@/components/RoomDisconnected.vue";
import { OttWebsocketError } from "ott-common/models/types";
import { mountComponent } from "./component-test-utils";

describe("disconnected overlay", () => {
	it("explains a generic close and offers a reconnect that reuses the room name", async () => {
		const { wrapper, connection, router } = mountComponent(RoomDisconnected);
		await router.push("/room/test-room");
		connection.kickReason.value = OttWebsocketError.UNKNOWN;
		await wrapper.vm.$nextTick();

		expect(wrapper.text()).toContain("连接被中断");
		expect(wrapper.text()).not.toContain("报告");
		const connect = vi.spyOn(connection, "connect");
		const reconnect = wrapper.findAll("button").find(b => b.text().includes("重新连接"));
		expect(reconnect).toBeDefined();
		await reconnect!.trigger("click");
		expect(connect).toHaveBeenCalledWith("test-room");
	});

	it("gives an explicit kick a readable reason without a reconnect action", async () => {
		const { wrapper, connection } = mountComponent(RoomDisconnected);
		connection.kickReason.value = OttWebsocketError.KICKED;
		await wrapper.vm.$nextTick();

		expect(wrapper.text()).toContain("你被房主或管理员踢出了房间");
		expect(wrapper.text()).not.toContain("重新连接");
	});
});
