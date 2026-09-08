import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nextTick } from "vue";
import Room from "@/views/Room.vue";
import { OttSfx } from "@/plugins/sfx";
import { flush, mountComponent } from "./component-test-utils";

describe("room connection lifecycle", () => {
	let page: ReturnType<typeof mountComponent> | undefined;

	beforeEach(() => {
		vi.useFakeTimers();
		const saved = new Map<string, string>();
		vi.stubGlobal("localStorage", {
			getItem: (key: string) => saved.get(key) ?? null,
			setItem: (key: string, value: string) => saved.set(key, String(value)),
			removeItem: (key: string) => saved.delete(key),
			clear: () => saved.clear(),
		});
		vi.stubGlobal("matchMedia", () => ({
			matches: false,
			addEventListener: vi.fn(),
			removeEventListener: vi.fn(),
			addListener: vi.fn(),
			removeListener: vi.fn(),
		}));
		vi.spyOn(window, "scrollTo").mockImplementation(() => undefined);
		vi.spyOn(OttSfx.prototype, "loadSfx").mockResolvedValue(undefined);
	});

	afterEach(() => {
		page?.wrapper.unmount();
		page = undefined;
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
		vi.useRealTimers();
	});

	async function mountRoom() {
		const mounted = mountComponent(Room, {
			global: {
				stubs: {
					OmniPlayer: true,
					VideoControls: true,
					Chat: true,
					VideoQueue: true,
					AddPreview: true,
					UserList: true,
					RoomSettingsForm: true,
					ShareInvite: true,
					ClientSettingsDialog: true,
					RoomDisconnected: true,
					ServerMessageHandler: true,
					WorkaroundPlaybackStatusUpdater: true,
					WorkaroundUserStateNotifier: true,
					RestoreQueue: true,
					VoteSkip: true,
				},
			},
		});
		page = mounted;
		const connect = vi.spyOn(mounted.connection, "connect").mockImplementation(() => {
			mounted.connection.active.value = true;
		});
		const disconnect = vi.spyOn(mounted.connection, "disconnect").mockImplementation(() => {
			mounted.connection.active.value = false;
			mounted.connection.connected.value = false;
		});
		const addMessageHandler = vi.spyOn(mounted.connection, "addMessageHandler");
		mounted.router.currentRoute.value = mounted.router.resolve({
			name: "room",
			params: { roomId: "lifecycle-room" },
		});
		await nextTick();
		return { ...mounted, connect, disconnect, addMessageHandler };
	}

	it("does not connect or register a sync handler when a token arrives after leaving", async () => {
		const { wrapper, store, connection, connect, addMessageHandler } = await mountRoom();
		expect(connect).not.toHaveBeenCalled();
		wrapper.unmount();

		store.commit("users/SET_AUTH_TOKEN", "late-token");
		await flush();
		await nextTick();
		store.commit("misc/ROOM_CREATED", { name: "another-room" });
		await vi.advanceTimersByTimeAsync(1000);

		expect(connect).not.toHaveBeenCalled();
		expect(addMessageHandler).not.toHaveBeenCalledWith("sync", expect.any(Function));
		expect(connection.active.value).toBe(false);
	});

	it("cancels a pending room-created reconnect when the room unmounts", async () => {
		const { wrapper, store, connection, connect, disconnect } = await mountRoom();
		store.commit("users/SET_AUTH_TOKEN", "available-token");
		await flush();
		await nextTick();
		expect(connect).toHaveBeenCalledOnce();
		expect(connect).toHaveBeenCalledWith("lifecycle-room");

		store.commit("misc/ROOM_CREATED", { name: "another-room" });
		expect(disconnect).toHaveBeenCalledOnce();
		wrapper.unmount();
		await vi.advanceTimersByTimeAsync(1000);

		expect(connect).toHaveBeenCalledOnce();
		expect(connection.active.value).toBe(false);
	});
});
