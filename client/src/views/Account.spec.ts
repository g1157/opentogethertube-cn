import { AxiosError, type AxiosResponse } from "axios";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { flush, mountComponent } from "../../tests/unit/component-test-utils";
import Account from "./Account.vue";

const { API } = vi.hoisted(() => ({
	API: { get: vi.fn(), patch: vi.fn(), delete: vi.fn() },
}));

vi.mock("@/common-http", () => ({ API }));

function unauthorized() {
	const response = {
		status: 401,
		data: {},
		statusText: "Unauthorized",
	} as unknown as AxiosResponse;
	return new AxiosError("Unauthorized", "ERR_BAD_REQUEST", undefined, undefined, response);
}

const accountResponse = {
	data: {
		success: true,
		username: "viewer",
		email: null,
		discordLinked: false,
		hasPassword: false,
	},
};

/**
 * Loading the account page used to fail silently: a non-401 error only fired a 4 second toast and
 * the template rendered nothing, so the page looked empty and offered no way to recover. The error
 * panel is the only thing a user can act on, so it must render, be announced, and refetch.
 */
describe("account view load failure", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("renders an alert panel with a retry button that refetches", async () => {
		API.get
			.mockRejectedValueOnce(new Error("network down"))
			.mockResolvedValueOnce(accountResponse);

		const { wrapper } = mountComponent(Account);
		await flush();
		await flush();

		const panel = wrapper.find('[data-cy="account-load-error"]');
		expect(panel.exists()).toBe(true);
		expect(panel.attributes("role")).toBe("alert");
		expect(panel.text()).toContain("无法加载账户");
		expect(wrapper.find("h1").exists()).toBe(false);

		const retry = panel.find('[data-cy="account-retry"]');
		expect(retry.text()).toContain("重试");
		await retry.trigger("click");
		await flush();
		await flush();

		expect(API.get).toHaveBeenCalledTimes(2);
		expect(wrapper.find('[data-cy="account-load-error"]').exists()).toBe(false);
		expect(wrapper.text()).toContain("viewer");
	});

	it("keeps redirecting home on 401 instead of showing the panel", async () => {
		API.get.mockRejectedValueOnce(unauthorized());

		const { wrapper, router } = mountComponent(Account);
		const push = vi.spyOn(router, "push");
		await flush();
		await flush();

		expect(push).toHaveBeenCalledWith("/");
		expect(wrapper.find('[data-cy="account-load-error"]').exists()).toBe(false);
	});
});
