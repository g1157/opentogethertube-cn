/**
 * Regression tests for the API 401 handling: only a token-level 401 may refresh and
 * replay, and the refresh must present the current token so a logged-in visitor is not
 * silently replaced by a fresh guest session.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import axios, { AxiosError, type AxiosAdapter, type InternalAxiosRequestConfig } from "axios";
import { API } from "@/common-http";

interface RecordedCall {
	method: string;
	url: string;
	authorization?: string;
}

function authorizationOf(config: InternalAxiosRequestConfig): string | undefined {
	const headers = config.headers as unknown as {
		get?: (name: string) => unknown;
		Authorization?: unknown;
	};
	const value = headers?.get?.("Authorization") ?? headers?.Authorization;
	if (value === undefined || value === null) {
		return undefined;
	}
	return String(value);
}

function makeAdapter(
	handler: (config: InternalAxiosRequestConfig) => Promise<unknown> | unknown,
	calls: RecordedCall[],
): AxiosAdapter {
	return async config => {
		const internal = config;
		calls.push({
			method: internal.method ?? "",
			url: internal.url ?? "",
			authorization: authorizationOf(internal),
		});
		return (await handler(internal)) as never;
	};
}

function ok(config: InternalAxiosRequestConfig, data: unknown) {
	return { status: 200, statusText: "OK", data, headers: {}, config };
}

function reject401(config: InternalAxiosRequestConfig, name: string) {
	const response = {
		status: 401,
		statusText: "Unauthorized",
		data: { success: false, error: { name } },
		headers: {},
		config,
	};
	return Promise.reject(
		new AxiosError(
			"Request failed",
			AxiosError.ERR_BAD_REQUEST,
			config,
			null,
			response as never,
		),
	);
}

describe("API 401 handling", () => {
	let saved: Map<string, string>;

	beforeEach(() => {
		saved = new Map();
		vi.stubGlobal("localStorage", {
			getItem: vi.fn((key: string) => saved.get(key) ?? null),
			setItem: vi.fn((key: string, value: string) => saved.set(key, String(value))),
			removeItem: vi.fn((key: string) => saved.delete(key)),
		});
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		API.defaults.adapter = undefined as never;
		axios.defaults.adapter = undefined as never;
		vi.restoreAllMocks();
	});

	it("does not refresh or replay a business 401 such as a wrong room password", async () => {
		const calls: RecordedCall[] = [];
		const adapter = makeAdapter(config => reject401(config, "RoomPasswordRequired"), calls);
		API.defaults.adapter = adapter;
		axios.defaults.adapter = adapter;
		saved.set("token", "logged-in-token");

		await expect(API.post("/room/example/password", { password: "wrong" })).rejects.toThrow();

		expect(calls.map(call => call.url)).toEqual(["/room/example/password"]);
		expect(saved.get("token")).toBe("logged-in-token");
	});

	it("refreshes with the current token and replays once on a session 401", async () => {
		const calls: RecordedCall[] = [];
		let roomCalls = 0;
		const adapter = makeAdapter(config => {
			if ((config.url ?? "").endsWith("/auth/grant")) {
				return Promise.resolve(ok(config, { token: "rotated-token" }));
			}
			roomCalls++;
			if (roomCalls === 1) {
				return reject401(config, "MissingToken");
			}
			return Promise.resolve(ok(config, { success: true }));
		}, calls);
		API.defaults.adapter = adapter;
		axios.defaults.adapter = adapter;
		saved.set("token", "expired-token");

		const response = await API.get("/room/example");

		expect(response.status).toBe(200);
		expect(roomCalls).toBe(2);
		const grant = calls.find(call => call.url.endsWith("/auth/grant"));
		expect(grant?.authorization).toBe("Bearer expired-token");
		expect(saved.get("token")).toBe("rotated-token");
		const replays = calls.filter(call => call.url === "/room/example");
		expect(replays).toHaveLength(2);
		expect(replays[1].authorization).toBe("Bearer rotated-token");
	});
});
