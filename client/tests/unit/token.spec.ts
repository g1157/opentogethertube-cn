import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildNewStore } from "@/store";
import { waitForToken } from "@/util/token";

const { API } = vi.hoisted(() => ({
	API: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
}));
vi.mock("@/common-http", () => ({ API }));

const TOKEN_TIMEOUT_MESSAGE = /Timed out waiting for an auth token/;

describe("waiting for the current stored auth token", () => {
	beforeEach(() => {
		vi.resetAllMocks();
		const saved = new Map<string, string>();
		vi.stubGlobal("localStorage", {
			getItem: (key: string) => saved.get(key) ?? null,
			setItem: (key: string, value: string) => saved.set(key, String(value)),
			removeItem: (key: string) => saved.delete(key),
		});
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
	});

	it("returns immediately when a token is already stored", async () => {
		localStorage.setItem("token", "stored-token");
		await waitForToken(buildNewStore());
		expect(API.get).not.toHaveBeenCalled();
	});

	it("requests a token and resolves once the grant stores one", async () => {
		API.get.mockResolvedValueOnce({ data: { token: "fresh-token" } });
		await waitForToken(buildNewStore());
		expect(API.get).toHaveBeenCalledWith("/auth/grant", expect.anything());
		expect(localStorage.getItem("token")).toBe("fresh-token");
	});

	it("keeps waiting when a blank token is already stored and asks for a usable one", async () => {
		vi.useFakeTimers();
		localStorage.setItem("token", "   ");
		API.get.mockResolvedValueOnce({ data: { token: "usable-token" } });
		const waiting = waitForToken(buildNewStore(), 60_000);
		await vi.advanceTimersByTimeAsync(20_000);
		await expect(waiting).resolves.toBeUndefined();
		expect(API.get).toHaveBeenCalledTimes(1);
		expect(localStorage.getItem("token")).toBe("usable-token");
	});

	it("keeps retrying after failed grants and resolves after a later success", async () => {
		vi.useFakeTimers();
		API.get
			.mockRejectedValueOnce(new Error("rate limited"))
			.mockRejectedValueOnce(new Error("tunnel blip"))
			.mockResolvedValueOnce({ data: { token: "eventual-token" } });
		const waiting = waitForToken(buildNewStore(), 60_000);
		await vi.advanceTimersByTimeAsync(20_000);
		await expect(waiting).resolves.toBeUndefined();
		expect(API.get).toHaveBeenCalledTimes(3);
		expect(localStorage.getItem("token")).toBe("eventual-token");
	});

	it("rejects with a timeout instead of waiting forever when every grant fails", async () => {
		vi.useFakeTimers();
		API.get.mockRejectedValue(new Error("no network"));
		const waiting = waitForToken(buildNewStore(), 8_000);
		const rejection = expect(waiting).rejects.toThrow(TOKEN_TIMEOUT_MESSAGE);
		await vi.advanceTimersByTimeAsync(60_000);
		await rejection;
		expect(API.get.mock.calls.length).toBeGreaterThan(1);
		expect(localStorage.getItem("token")).toBeNull();
	});
});
