import { flushPromises } from "@vue/test-utils";
import { PlayerStatus, Role, type RoomUserInfo } from "ott-common/models/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "@/App.vue";
import UserList from "@/components/UserList.vue";
import LocaleSelector from "@/components/navbar/LocaleSelector.vue";
import NavUser from "@/components/navbar/NavUser.vue";
import vuetify from "@/plugins/vuetify";
import { mountComponent } from "./component-test-utils";

const { API } = vi.hoisted(() => ({
	API: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
}));
vi.mock("@/common-http", () => ({ API }));

const account = { username: "观影用户", loggedIn: true, discordLinked: true };

function viewer(id: string): RoomUserInfo {
	return {
		id,
		name: id,
		role: Role.RegisteredUser,
		status: PlayerStatus.ready,
		isLoggedIn: true,
	};
}

describe("Navigation and user menus", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.stubGlobal("localStorage", {
			getItem: () => null,
			setItem: () => undefined,
			removeItem: () => undefined,
		});
		API.get.mockImplementation(async (path: string) => ({
			data: path === "/auth/grant" ? { token: "test-token" } : { loggedIn: false },
		}));
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		vuetify.display.update();
	});

	it("closes the account menu when entering fullscreen and keeps it closed on return", async () => {
		const { wrapper, store, router } = mountComponent(NavUser);
		await router.isReady();
		store.commit("LOGIN", account);
		await flushPromises();
		const button = wrapper.get("button.nav-user");
		await button.trigger("click");
		await flushPromises();

		expect(button.attributes("aria-expanded")).toBe("true");
		const menu = document.getElementById(button.attributes("aria-controls") ?? "");
		expect(menu).not.toBeNull();
		expect(menu?.querySelector('a[href="/account"]')).not.toBeNull();
		store.commit("SET_FULLSCREEN", true);
		await flushPromises();
		expect(button.attributes("aria-expanded")).toBe("false");
		store.commit("SET_FULLSCREEN", false);
		await flushPromises();
		expect(button.attributes("aria-expanded")).toBe("false");
	});

	it("closes a language menu when navigating away from its anchor", async () => {
		const { wrapper, router } = mountComponent(LocaleSelector);
		await router.isReady();
		const field = wrapper.get(".v-field");
		await field.trigger("mousedown", { button: 0 });
		await flushPromises();
		expect(wrapper.get('[role="combobox"]').attributes("aria-expanded")).toBe("true");

		await router.push("/rooms");
		await flushPromises();
		expect(wrapper.get('[role="combobox"]').attributes("aria-expanded")).toBe("false");
	});

	it("removes an open drawer menu when the mobile drawer closes", async () => {
		vi.stubGlobal("innerWidth", 375);
		vuetify.display.update();
		const { wrapper, store, router } = mountComponent(App, {
			global: {
				stubs: { RouterView: true, Notifier: true, LogInForm: true, CreateRoomForm: true },
			},
		});
		await router.isReady();
		await flushPromises();
		store.commit("LOGIN", account);
		await flushPromises();
		await wrapper.get(".nav-shell > button").trigger("click");
		await flushPromises();
		const anchor = wrapper.get(".drawer-account .nav-user");
		await anchor.trigger("click");
		await flushPromises();
		const menuId = anchor.attributes("aria-controls") ?? "";
		expect(anchor.attributes("aria-expanded")).toBe("true");
		expect(document.getElementById(menuId)).not.toBeNull();

		await wrapper.get(".drawer-heading button").trigger("click");
		await flushPromises();
		expect(wrapper.find(".drawer-account").exists()).toBe(false);
		expect(document.getElementById(menuId)).toBeNull();
	});

	it("does not transfer an open user menu to another person when someone leaves", async () => {
		const { wrapper, router } = mountComponent(UserList, {
			props: { users: [viewer("alice"), viewer("bob")] },
		});
		await router.isReady();
		const alice = wrapper.findAll(".user-actions")[0];
		await alice.trigger("click");
		await flushPromises();
		const menuId = alice.attributes("aria-controls") ?? "";
		expect(alice.attributes("aria-expanded")).toBe("true");

		await wrapper.setProps({ users: [viewer("bob")] });
		await flushPromises();
		expect(wrapper.get(".user .name").text()).toBe("bob");
		expect(wrapper.get(".user-actions").attributes("aria-expanded")).toBe("false");
		expect(document.getElementById(menuId)).toBeNull();
	});
});
