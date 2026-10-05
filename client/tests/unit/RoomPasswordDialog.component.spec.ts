import { beforeEach, describe, expect, it, vi } from "vitest";
import RoomPasswordDialog from "@/components/RoomPasswordDialog.vue";
import { flush, mountComponent } from "./component-test-utils";

const { API } = vi.hoisted(() => ({
	API: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
}));

vi.mock("@/common-http", () => ({ API }));

function findInput() {
	return document.querySelector<HTMLInputElement>('[data-cy="input-join-room-password"] input')!;
}

function findSubmit() {
	return document.querySelector<HTMLElement>('[data-cy="btn-submit-join-room-password"]')!;
}

describe("RoomPasswordDialog component", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("submits the password and emits verified", async () => {
		API.post.mockResolvedValue({ data: { success: true } });
		const { wrapper } = mountComponent(RoomPasswordDialog, {
			props: { modelValue: true, roomName: "foo" },
		});
		await flush();

		const input = findInput();
		input.value = "hunter22";
		input.dispatchEvent(new Event("input"));
		await flush();
		findSubmit().click();
		await flush();
		await flush();

		expect(API.post).toHaveBeenCalledWith("/room/foo/password", { password: "hunter22" });
		expect(wrapper.emitted("verified")).toBeTruthy();
	});

	it("shows the server error for a wrong password", async () => {
		API.post.mockRejectedValue({
			response: { data: { error: { name: "InvalidRoomPassword" } } },
		});
		mountComponent(RoomPasswordDialog, { props: { modelValue: true, roomName: "foo" } });
		await flush();

		const input = findInput();
		input.value = "nope";
		input.dispatchEvent(new Event("input"));
		await flush();
		findSubmit().click();
		await flush();
		await flush();

		expect(document.body.textContent).toContain("房间密码不正确。");
	});
});
