import { flushPromises } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PlayerStatus, Role } from "ott-common/models/types";
import { Grants, parseIntoGrantMask } from "ott-common/permissions";
import App from "@/App.vue";
import RoomSettingsForm from "@/components/RoomSettingsForm.vue";
import PermissionsEditor from "@/components/PermissionsEditor.vue";
import vuetify from "@/plugins/vuetify";
import { mountComponent } from "./component-test-utils";

const { API } = vi.hoisted(() => ({
	API: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
}));
vi.mock("@/common-http", () => ({ API }));
vi.mock("@/edge-preview", () => ({ isEdgePreview: true }));

function mountEdgeApp() {
	return mountComponent(App, {
		global: {
			stubs: {
				RouterView: { template: '<div data-testid="room-route" />' },
				Notifier: true,
				LogInForm: true,
				CreateRoomForm: true,
			},
		},
	});
}

describe("Cloudflare guest identity and room ownership", () => {
	beforeEach(() => {
		vi.resetAllMocks();
		const storage = new Map<string, string>();
		vi.stubGlobal("localStorage", {
			getItem: (key: string) => storage.get(key) ?? null,
			setItem: (key: string, value: string) => storage.set(key, value),
			removeItem: (key: string) => storage.delete(key),
		});
		vi.stubGlobal("innerWidth", 1280);
		vuetify.display.update();
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		vuetify.display.update();
	});

	it("waits for the guest token before mounting room routes or enabling creation", async () => {
		let grantToken!: (value: { data: { token: string } }) => void;
		API.get.mockReturnValue(
			new Promise(resolve => {
				grantToken = resolve;
			}),
		);
		const { wrapper, router } = mountEdgeApp();
		await router.isReady();
		await flushPromises();

		expect(API.get).toHaveBeenCalledTimes(1);
		expect(API.get).toHaveBeenCalledWith("/auth/grant");
		expect(wrapper.find('[data-testid="room-route"]').exists()).toBe(false);
		expect((wrapper.get(".nav-create").element as HTMLButtonElement).disabled).toBe(true);

		grantToken({ data: { token: "edge-test-token" } });
		await flushPromises();
		expect(localStorage.getItem("token")).toBe("edge-test-token");
		expect(wrapper.find('[data-testid="room-route"]').exists()).toBe(true);
		expect((wrapper.get(".nav-create").element as HTMLButtonElement).disabled).toBe(false);
		expect(API.get).toHaveBeenCalledTimes(1);
	});

	it("recovers a failed identity request without starting unauthenticated room requests", async () => {
		API.get.mockRejectedValueOnce(new Error("Network unavailable"));
		API.get.mockResolvedValueOnce({ data: { token: "retried-edge-token" } });
		const { wrapper, router } = mountEdgeApp();
		await router.isReady();
		await flushPromises();

		expect(wrapper.find('[data-testid="room-route"]').exists()).toBe(false);
		expect(wrapper.get('[role="status"]').text()).toContain("重试");
		expect(API.get).toHaveBeenCalledTimes(1);
		await wrapper.get('[role="status"] button').trigger("click");
		await flushPromises();

		expect(wrapper.find('[data-testid="room-route"]').exists()).toBe(true);
		expect(localStorage.getItem("token")).toBe("retried-edge-token");
		expect(API.get.mock.calls).toEqual([["/auth/grant"], ["/auth/grant"]]);
	});

	it("lets the browser's guest owner save grants and hides the editor from other guests", async () => {
		const grants = new Grants();
		API.get.mockResolvedValue({
			data: {
				name: "edge-room",
				title: "Edge room",
				description: "",
				isTemporary: false,
				visibility: "unlisted",
				queueMode: "manual",
				queue: [],
				users: [],
				grants: JSON.parse(JSON.stringify(grants)),
				autoSkipSegmentCategories: [],
				restoreQueueBehavior: "always",
				enableVoteSkip: false,
				hasOwner: true,
			},
		});
		API.patch.mockResolvedValue({ data: { success: true } });
		const { wrapper, store } = mountComponent(RoomSettingsForm);
		store.state.room.name = "edge-room";
		store.state.room.hasOwner = true;
		store.state.users.users = new Map([
			[
				"owner",
				{
					id: "owner",
					name: "访客房主",
					isLoggedIn: false,
					role: Role.Owner,
					status: PlayerStatus.ready,
				},
			],
		]);
		store.state.users.you = { id: "owner" };
		await flushPromises();
		await new Promise(resolve => setTimeout(resolve, 0));

		expect(store.state.user).toBeNull();
		expect(wrapper.findComponent(PermissionsEditor).exists()).toBe(true);
		const play = wrapper.get('[data-cy="perm-chk-playback.play-pause-0"] input');
		const before = (play.element as HTMLInputElement).checked;
		expect((play.element as HTMLInputElement).disabled).toBe(false);
		await play.trigger("click");
		expect((play.element as HTMLInputElement).checked).toBe(!before);
		expect((wrapper.get('[data-cy="save"]').element as HTMLButtonElement).disabled).toBe(false);
		await wrapper.get('[data-cy="save"]').trigger("click");
		await flushPromises();

		expect(API.patch).toHaveBeenCalled();
		const [route, settings] = API.patch.mock.calls.at(-1)!;
		expect(route).toBe("/room/edge-room");
		const submitted = JSON.parse(JSON.stringify(settings));
		const savedGrants = new Grants(submitted.grants);
		expect(
			Boolean(
				savedGrants.getMask(Role.UnregisteredUser) &
					parseIntoGrantMask(["playback.play-pause"]),
			),
		).toBe(!before);
		expect(wrapper.find('[data-cy="select-restore-queue"]').exists()).toBe(false);
		expect(wrapper.find('[data-cy="input-auto-skip"]').exists()).toBe(false);

		store.state.users.users.get("owner")!.role = Role.UnregisteredUser;
		await flushPromises();
		expect(wrapper.findComponent(PermissionsEditor).exists()).toBe(false);
	});
});
