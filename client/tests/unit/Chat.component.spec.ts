import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nextTick } from "vue";
import {
	RoomRequestType,
	type ClientMessageRoomRequest,
	type ServerMessage,
} from "ott-common/models/messages";
import { PlayerStatus, Role } from "ott-common/models/types";
import Chat from "@/components/Chat.vue";
import { mountComponent } from "./component-test-utils";

function chatActions(wrapper: ReturnType<typeof mountComponent>["wrapper"]) {
	// This VTU version keeps script-setup's public methods on the exposed instance.
	return wrapper.vm.$.exposed as {
		activateAndFocus(): void;
		setActivated(value: boolean): void;
	};
}

describe("Chat component", () => {
	it("opens without focus, permits deliberate input focus, and preserves a closed draft", async () => {
		const { wrapper } = mountComponent(Chat);
		await wrapper.get('[data-cy="chat-activate"]').trigger("click");
		await nextTick();
		const input = wrapper.get('[data-cy="chat-input"] input');
		expect(document.activeElement).not.toBe(input.element);
		(input.element as HTMLInputElement).focus();
		expect(document.activeElement).toBe(input.element);
		await input.setValue("未发送的草稿");
		await wrapper.get('[data-cy="chat-deactivate"]').trigger("click");
		expect(document.activeElement).not.toBe(input.element);
		await wrapper.get('[data-cy="chat-activate"]').trigger("click");
		expect(
			(wrapper.get('[data-cy="chat-input"] input').element as HTMLInputElement).value,
		).toBe("未发送的草稿");
		expect(document.activeElement).not.toBe(
			wrapper.get('[data-cy="chat-input"] input').element,
		);
	});

	it("focuses an already open chat only when typing is explicitly requested", async () => {
		const { wrapper, connection } = mountComponent(Chat);
		await wrapper.get('[data-cy="chat-activate"]').trigger("click");
		const input = wrapper.get('[data-cy="chat-input"] input');
		expect(document.activeElement).not.toBe(input.element);
		await input.setValue("继续编辑草稿");
		chatActions(wrapper).activateAndFocus();
		await nextTick();
		expect(document.activeElement).toBe(input.element);
		expect((input.element as HTMLInputElement).value).toBe("继续编辑草稿");
		expect(connection.sent).toEqual([]);
	});

	it("cancels pending focus when chat is closed and reopened for reading", async () => {
		const { wrapper } = mountComponent(Chat);
		chatActions(wrapper).activateAndFocus();
		chatActions(wrapper).setActivated(false);
		chatActions(wrapper).setActivated(true);
		await nextTick();
		const input = wrapper.get('[data-cy="chat-input"] input');
		expect(document.activeElement).not.toBe(input.element);
	});

	it("does not apply a pending focus request after unmount", async () => {
		const { wrapper } = mountComponent(Chat);
		const focus = vi.spyOn(HTMLElement.prototype, "focus");
		try {
			chatActions(wrapper).activateAndFocus();
			wrapper.unmount();
			await nextTick();
			expect(focus).not.toHaveBeenCalled();
		} finally {
			focus.mockRestore();
		}
	});

	it.each([
		"Enter",
		"NumpadEnter",
	])("ignores held %s events before sending once on a fresh press", async code => {
		const { wrapper, connection } = mountComponent(Chat);
		chatActions(wrapper).activateAndFocus();
		await nextTick();
		const input = wrapper.get('[data-cy="chat-input"] input');
		await input.setValue("长按不要发送");
		await input.trigger("keydown", { key: "Enter", code, repeat: true });
		expect(connection.sent).toEqual([]);
		expect(wrapper.find('[data-cy="chat-input"]').exists()).toBe(true);
		expect((input.element as HTMLInputElement).value).toBe("长按不要发送");
		await input.trigger("keydown", { key: "Enter", code });
		expect(connection.sent).toEqual([
			{
				action: "req",
				request: { type: RoomRequestType.ChatRequest, text: "长按不要发送" },
			},
		]);
		expect(wrapper.find('[data-cy="chat-input"]').exists()).toBe(false);
		expect(document.activeElement).not.toBe(input.element);
	});

	it.each([
		{ ctrlKey: true },
		{ altKey: true },
		{ metaKey: true },
		{ shiftKey: true },
	])("preserves the draft for a modified Enter %s", async modifiers => {
		const { wrapper, connection } = mountComponent(Chat);
		chatActions(wrapper).activateAndFocus();
		await nextTick();
		const input = wrapper.get('[data-cy="chat-input"] input');
		await input.setValue("保留组合键草稿");
		await input.trigger("keydown", { key: "Enter", ...modifiers });
		expect(connection.sent).toEqual([]);
		expect(wrapper.find('[data-cy="chat-input"]').exists()).toBe(true);
		expect((input.element as HTMLInputElement).value).toBe("保留组合键草稿");
	});

	it("lets Chinese IME confirm a candidate before Enter sends", async () => {
		const { wrapper, connection } = mountComponent(Chat);
		await wrapper.get('[data-cy="chat-activate"]').trigger("click");
		const input = wrapper.get('[data-cy="chat-input"] input');
		await input.setValue("中文消息");
		await input.trigger("compositionstart");
		await input.trigger("keydown", { key: "Enter" });
		expect(connection.sent).toEqual([]);
		await input.trigger("compositionend");
		await input.trigger("keydown", { key: "Enter", isComposing: true });
		await input.trigger("keydown", { key: "Enter", keyCode: 229 });
		expect(connection.sent).toEqual([]);
		await input.trigger("keydown", { key: "Enter" });
		expect(connection.sent).toEqual([
			{ action: "req", request: { type: RoomRequestType.ChatRequest, text: "中文消息" } },
		]);
	});
	it("opens and closes from the buttons", async () => {
		const { wrapper } = mountComponent(Chat);

		await wrapper.get('[data-cy="chat-activate"]').trigger("click");
		expect(wrapper.find('[data-cy="chat-activate"]').exists()).toBe(false);
		expect(wrapper.find('[data-cy="chat-deactivate"]').exists()).toBe(true);
		expect(wrapper.find('[data-cy="chat-input"]').exists()).toBe(true);

		await wrapper.get('[data-cy="chat-deactivate"]').trigger("click");
		expect(wrapper.find('[data-cy="chat-activate"]').exists()).toBe(true);
		expect(wrapper.find('[data-cy="chat-input"]').exists()).toBe(false);
	});

	it("sends the message when enter is pressed", async () => {
		const { wrapper, connection } = mountComponent(Chat);
		await wrapper.get('[data-cy="chat-activate"]').trigger("click");
		await wrapper.get('[data-cy="chat-input"] input').setValue("foo");
		await wrapper.get('[data-cy="chat-input"]').trigger("keydown", { key: "Enter" });

		const expected: ClientMessageRoomRequest = {
			action: "req",
			request: { type: RoomRequestType.ChatRequest, text: "foo" },
		};
		expect(connection.sent).toEqual([expected]);
	});

	it("does not send empty or escaped messages", async () => {
		const { wrapper, connection } = mountComponent(Chat);
		await wrapper.get('[data-cy="chat-activate"]').trigger("click");
		await wrapper.get('[data-cy="chat-input"]').trigger("keydown", { key: "Enter" });
		await wrapper.get('[data-cy="chat-activate"]').trigger("click");
		await wrapper.get('[data-cy="chat-input"] input').setValue("foo");
		await wrapper.get('[data-cy="chat-input"]').trigger("keydown", { key: "Escape" });

		expect(connection.sent).toEqual([]);
	});

	it("displays received messages", async () => {
		const { wrapper, connection } = mountComponent(Chat);
		await wrapper.get('[data-cy="chat-activate"]').trigger("click");
		const message: ServerMessage = {
			action: "chat",
			from: {
				id: "1",
				name: "goober",
				isLoggedIn: false,
				status: PlayerStatus.ready,
				role: Role.UnregisteredUser,
			},
			text: "foo",
		};

		connection.mockReceive(message);
		await wrapper.vm.$nextTick();

		expect(wrapper.findAll(".message")).toHaveLength(1);
		expect(wrapper.get(".from").text()).toContain("goober");
		expect(wrapper.get(".text").text()).toContain("foo");
	});

	it("keeps the message list scrolled to the bottom when receiving messages", async () => {
		const { wrapper, connection } = mountComponent(Chat);
		await wrapper.get('[data-cy="chat-activate"]').trigger("click");
		const messages = wrapper.get(".messages").element as HTMLDivElement;
		Object.defineProperty(messages, "clientHeight", { configurable: true, value: 100 });
		Object.defineProperty(messages, "scrollHeight", { configurable: true, value: 300 });

		connection.mockReceive({
			action: "chat",
			from: {
				id: "1",
				name: "goober",
				isLoggedIn: false,
				status: PlayerStatus.ready,
				role: Role.UnregisteredUser,
			},
			text: "foo",
		});
		await wrapper.vm.$nextTick();
		await wrapper.vm.$nextTick();

		expect(messages.scrollTop).toBe(300);
	});
});

describe("chat overlay duration", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	function message(text: string): ServerMessage {
		return {
			action: "chat",
			from: {
				id: "1",
				name: "goober",
				isLoggedIn: false,
				status: PlayerStatus.ready,
				role: Role.UnregisteredUser,
			},
			text,
		};
	}

	it("expires each message five seconds after receipt and keeps the history", async () => {
		const { wrapper, connection } = mountComponent(Chat);
		connection.mockReceive(message("first"));
		await vi.advanceTimersByTimeAsync(2000);
		connection.mockReceive(message("second"));
		await nextTick();
		expect(wrapper.findAll(".message.recent")).toHaveLength(2);

		await vi.advanceTimersByTimeAsync(3000);
		expect(wrapper.findAll(".message.recent .text").map(item => item.text())).toEqual([
			"second",
		]);
		await vi.advanceTimersByTimeAsync(2000);
		expect(wrapper.findAll(".message.recent")).toHaveLength(0);
		await wrapper.get('[data-cy="chat-activate"]').trigger("click");
		expect(wrapper.findAll(".message .text").map(item => item.text())).toEqual([
			"first",
			"second",
		]);
	});

	it("applies shorter and longer durations using original receipt times", async () => {
		const { wrapper, connection, store } = mountComponent(Chat);
		connection.mockReceive(message("first"));
		await vi.advanceTimersByTimeAsync(4000);
		connection.mockReceive(message("second"));
		store.commit("settings/UPDATE", { chatOverlaySeconds: 3 });
		await nextTick();
		expect(wrapper.findAll(".message.recent .text").map(item => item.text())).toEqual([
			"second",
		]);

		store.commit("settings/UPDATE", { chatOverlaySeconds: 10 });
		await nextTick();
		expect(wrapper.findAll(".message.recent")).toHaveLength(2);
		await vi.advanceTimersByTimeAsync(6000);
		expect(wrapper.findAll(".message.recent .text").map(item => item.text())).toEqual([
			"second",
		]);
		await vi.advanceTimersByTimeAsync(4000);
		expect(wrapper.findAll(".message.recent")).toHaveLength(0);
	});

	it("turns overlays off immediately without dropping current or subsequent messages", async () => {
		const { wrapper, connection, store } = mountComponent(Chat);
		connection.mockReceive(message("before"));
		await nextTick();
		expect(wrapper.findAll(".message.recent")).toHaveLength(1);
		store.commit("settings/UPDATE", { chatOverlaySeconds: 0 });
		await nextTick();
		connection.mockReceive(message("after"));
		await nextTick();
		expect(wrapper.findAll(".message.recent")).toHaveLength(0);
		await vi.advanceTimersByTimeAsync(20000);
		await wrapper.get('[data-cy="chat-activate"]').trigger("click");
		expect(wrapper.findAll(".message .text").map(item => item.text())).toEqual([
			"before",
			"after",
		]);
	});

	it("clears its pending expiry when chat unmounts", async () => {
		const { wrapper, connection } = mountComponent(Chat);
		await nextTick();
		const baselineTimerCount = vi.getTimerCount();
		connection.mockReceive(message("pending"));
		await nextTick();
		expect(vi.getTimerCount()).toBe(baselineTimerCount + 1);
		wrapper.unmount();
		expect(vi.getTimerCount()).toBeLessThanOrEqual(baselineTimerCount);
		await vi.advanceTimersByTimeAsync(20000);
	});
});
