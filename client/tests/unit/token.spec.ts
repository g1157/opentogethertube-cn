import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildNewStore } from "@/store";
import { waitForToken } from "@/util/token";

describe("waiting for the current stored auth token", () => {
	beforeEach(() => {
		const saved = new Map<string, string>();
		vi.stubGlobal("localStorage", {
			getItem: (key: string) => saved.get(key) ?? null,
			setItem: (key: string, value: string) => saved.set(key, String(value)),
			removeItem: (key: string) => saved.delete(key),
		});
	});

	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
	});

	it("waits for the first token, then returns on a second visit without another token mutation", async () => {
		const store = buildNewStore();
		const subscribe = vi.spyOn(store, "subscribe");
		const firstResolved = vi.fn();
		const firstVisit = waitForToken(store).then(firstResolved);
		await Promise.resolve();
		expect(firstResolved).not.toHaveBeenCalled();
		store.commit("users/SET_AUTH_TOKEN", "first-visit-token");
		await firstVisit;
		expect(firstResolved).toHaveBeenCalledOnce();
		expect(localStorage.getItem("token")).toBe("first-visit-token");

		const secondResolved = vi.fn();
		void waitForToken(store).then(secondResolved);
		await Promise.resolve();
		await Promise.resolve();
		expect(secondResolved).toHaveBeenCalledOnce();
		expect(subscribe).toHaveBeenCalledOnce();
	});

	it("waits again if a previously available token has been removed", async () => {
		const store = buildNewStore();
		localStorage.setItem("token", "previous-token");
		await waitForToken(store);
		localStorage.removeItem("token");
		const resolved = vi.fn();
		const waiting = waitForToken(store).then(resolved);
		await Promise.resolve();
		await Promise.resolve();
		expect(resolved).not.toHaveBeenCalled();
		store.commit("users/SET_AUTH_TOKEN", "replacement-token");
		await waiting;
		expect(resolved).toHaveBeenCalledOnce();
	});

	it.each([
		"",
		"   ",
	])("keeps waiting when a token mutation still leaves blank storage: %j", async token => {
		const store = buildNewStore();
		localStorage.setItem("token", token);
		const resolved = vi.fn();
		const waiting = waitForToken(store).then(resolved);
		await Promise.resolve();
		expect(resolved).not.toHaveBeenCalled();
		store.commit("users/SET_AUTH_TOKEN", token);
		await Promise.resolve();
		await Promise.resolve();
		expect(resolved).not.toHaveBeenCalled();
		store.commit("users/SET_AUTH_TOKEN", "usable-token");
		await waiting;
		expect(resolved).toHaveBeenCalledOnce();
	});
});
