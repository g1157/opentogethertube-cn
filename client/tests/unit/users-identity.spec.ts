import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildNewStore } from "@/store";

const { API } = vi.hoisted(() => ({ API: { get: vi.fn() } }));
vi.mock("@/common-http", () => ({ API }));

describe("guest identity", () => {
	let saved: Map<string, string>;

	beforeEach(() => {
		saved = new Map();
		vi.stubGlobal("localStorage", {
			getItem: (key: string) => saved.get(key) ?? null,
			setItem: (key: string, value: string) => saved.set(key, String(value)),
			removeItem: (key: string) => saved.delete(key),
		});
		API.get.mockReset();
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("shares one grant between callers that ask at the same time", async () => {
		// Loading a room directly asks twice (the app bootstrap and the room's own wait). Two
		// grants would mint two guests for one browser, so the second name shows up next to the
		// first in the room.
		let release!: (value: { data: { token: string } }) => void;
		API.get.mockReturnValue(
			new Promise(resolve => {
				release = resolve;
			}),
		);
		const store = buildNewStore();

		const first = store.dispatch("users/getNewToken");
		const second = store.dispatch("users/getNewToken");
		release({ data: { token: "one-token" } });
		await Promise.all([first, second]);

		expect(API.get).toHaveBeenCalledOnce();
		expect(saved.get("token")).toBe("one-token");
	});

	it("grants again once the previous one has settled", async () => {
		API.get.mockResolvedValue({ data: { token: "first-token" } });
		const store = buildNewStore();

		await store.dispatch("users/getNewToken");
		API.get.mockResolvedValue({ data: { token: "second-token" } });
		await store.dispatch("users/getNewToken");

		expect(API.get).toHaveBeenCalledTimes(2);
		expect(saved.get("token")).toBe("second-token");
	});

	it("presents the stored token so a reload keeps the same identity", async () => {
		saved.set("token", "existing-token");
		API.get.mockResolvedValue({ data: { token: "existing-token" } });
		const store = buildNewStore();

		await store.dispatch("users/getNewToken");

		expect(API.get).toHaveBeenCalledWith(
			"/auth/grant",
			expect.objectContaining({
				headers: expect.objectContaining({ Authorization: "Bearer existing-token" }),
			}),
		);
	});
});
