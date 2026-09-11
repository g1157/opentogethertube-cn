import { afterEach, describe, expect, it, vi } from "vitest";
import { defineComponent, h, nextTick, onUnmounted, ref } from "vue";
import type { ServerMessage, ServerMessageSync } from "ott-common/models/messages";
import ServerMessageHandler from "@/components/ServerMessageHandler.vue";
import { mountComponent } from "./component-test-utils";

describe("server message handler ownership", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("keeps the new room handlers when Vue sets up its replacement before the old unmount hook", async () => {
		const room = ref("first");
		const lifecycle: string[] = [];
		const roomView = defineComponent({
			props: { name: { type: String, required: true } },
			setup(props) {
				const name = props.name;
				lifecycle.push(`setup:${name}`);
				onUnmounted(() => lifecycle.push(`unmounted:${name}`));
				return () => h(ServerMessageHandler);
			},
		});
		const harness = defineComponent({
			setup: () => () => h(roomView, { key: room.value, name: room.value }),
		});
		const { connection, store } = mountComponent(harness);
		const dispatch = vi.spyOn(store, "dispatch");
		connection.mockReceive({
			action: "sync",
			currentSource: { service: "direct", id: "https://media.example/first.mp4" },
			playbackPosition: 10,
			isPlaying: true,
		});
		expect(store.state.room.currentSource?.id).toBe("https://media.example/first.mp4");

		room.value = "second";
		await nextTick();
		expect(lifecycle).toEqual(["setup:first", "setup:second", "unmounted:first"]);
		dispatch.mockClear();
		const message: ServerMessageSync = {
			action: "sync",
			currentSource: { service: "direct", id: "https://media.example/second.mp4" },
			playbackPosition: 25,
			isPlaying: true,
		};
		connection.mockReceive(message);
		await nextTick();
		expect(store.state.room.currentSource?.id).toBe("https://media.example/second.mp4");
		expect(store.state.room.playbackPosition).toBe(25);
		expect(dispatch).toHaveBeenCalledOnce();
		expect(dispatch).toHaveBeenCalledWith("room/sync", message);
	});

	it("removes only its own subscriptions and preserves other sync and chat listeners", () => {
		const { wrapper, connection, store } = mountComponent(ServerMessageHandler);
		const dispatch = vi.spyOn(store, "dispatch").mockResolvedValue(undefined);
		const externalSync = vi.fn();
		const externalChat = vi.fn();
		connection.addMessageHandler("sync", externalSync);
		connection.addMessageHandler("chat", externalChat);
		const actions = [
			"sync",
			"chat",
			"announcement",
			"user",
			"you",
			"event",
			"eventcustom",
		] as const;
		for (const action of actions) {
			connection.mockReceive({ action } as ServerMessage);
		}
		expect(dispatch).toHaveBeenCalledTimes(actions.length);

		wrapper.unmount();
		dispatch.mockClear();
		externalSync.mockClear();
		externalChat.mockClear();
		for (const action of actions) {
			connection.mockReceive({ action } as ServerMessage);
		}
		expect(dispatch).not.toHaveBeenCalled();
		expect(externalSync).toHaveBeenCalledOnce();
		expect(externalChat).toHaveBeenCalledOnce();
	});
});
