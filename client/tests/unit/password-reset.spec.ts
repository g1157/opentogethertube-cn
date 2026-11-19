import { beforeEach, describe, expect, it, vi } from "vitest";
import PasswordReset from "@/views/PasswordReset.vue";
import { flush, mountComponent } from "./component-test-utils";

const { API } = vi.hoisted(() => ({
	API: { get: vi.fn(), post: vi.fn() },
}));

vi.mock("@/common-http", () => ({ API }));

/**
 * The reset flow re-declared `const resp` for the /user lookup, which shadowed the
 * verification response: the rotated token was never adopted, so the login that followed
 * used the old identity. It shipped because no tool checks a .vue `<script>` and the
 * client eslint config turns `no-redeclare` off. This pins the order the server relies on.
 */
describe("password reset", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("adopts the rotated token before asking for the user", async () => {
		API.post.mockResolvedValue({ data: { success: true, token: "NEW_TOKEN" } });
		API.get.mockResolvedValue({ data: { loggedIn: true, username: "viewer" } });

		const { wrapper, store } = mountComponent(PasswordReset);
		const commit = vi.spyOn(store, "commit");
		const inputs = wrapper.findAll("input");
		await inputs[0].setValue("new-password");
		await inputs[1].setValue("new-password");
		await wrapper.find("form").trigger("submit");
		await flush();

		const tokenCommit = commit.mock.calls.findIndex(
			call => String(call[0]) === "users/SET_AUTH_TOKEN",
		);
		expect(tokenCommit).toBeGreaterThanOrEqual(0);
		expect(commit.mock.calls[tokenCommit][1]).toBe("NEW_TOKEN");
		expect(API.get).toHaveBeenCalledWith("/user");
		// The token commit must happen before the user lookup resolves, otherwise the
		// request carries the session the reset was supposed to replace.
		expect(commit.mock.invocationCallOrder[tokenCommit]).toBeLessThan(
			API.get.mock.invocationCallOrder[0],
		);
	});
});
