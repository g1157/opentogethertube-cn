import EventEmitter from "node:events";
import WebSocket from "ws";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OttWebsocketError } from "ott-common/models/types.js";
import { ClientJoinStatus, DirectClient } from "../../client.js";
import * as tokens from "../../auth/tokens.js";

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>(_resolve => {
		resolve = _resolve;
	});
	return { promise, resolve };
}

describe("direct client identity and transport lifecycle", () => {
	let client: DirectClient;
	let socket: ReturnType<typeof createSocket>;
	function createSocket() {
		return Object.assign(new EventEmitter(), {
			readyState: WebSocket.OPEN as number,
			bufferedAmount: 0,
			close: vi.fn(),
			terminate: vi.fn(),
			send: vi.fn<[string, (error?: Error) => void], void>(),
			ping: vi.fn(),
			pong: vi.fn(),
		});
	}
	beforeEach(() => {
		socket = createSocket();
		client = new DirectClient("transport-review", socket as unknown as WebSocket);
	});
	afterEach(() => {
		client.onClose();
		vi.restoreAllMocks();
	});
	function join() {
		client.token = "guest-token";
		client.session = { isLoggedIn: false, username: "guest" };
		client.joinStatus = ClientJoinStatus.Joined;
	}

	it("rejects re-authentication before initial authentication without querying storage", () => {
		const lookup = vi.spyOn(tokens, "getSessionInfo");
		socket.emit("message", Buffer.from('{"action":"reauthenticate","token":"new-token"}'));
		expect(socket.close).toHaveBeenCalledWith(OttWebsocketError.MISSING_TOKEN);
		expect(lookup).not.toHaveBeenCalled();
	});

	it("routes re-authentication through the same message budget as room commands", () => {
		join();
		const lookup = vi.spyOn(tokens, "getSessionInfo");
		const message = vi.fn();
		client.on("message", message);
		socket.emit("message", Buffer.from('{"action":"reauthenticate","token":"new-token"}'));
		expect(message).toHaveBeenCalledWith(client, {
			action: "reauthenticate",
			token: "new-token",
		});
		expect(lookup).not.toHaveBeenCalled();
	});

	it("allows only one identity lookup in flight", async () => {
		join();
		const lookup = deferred<{ isLoggedIn: false; username: string }>();
		const getSession = vi.spyOn(tokens, "getSessionInfo").mockReturnValue(lookup.promise);
		const first = client.reauthenticate("first-token");
		expect(await client.reauthenticate("second-token")).toBe(false);
		expect(getSession).toHaveBeenCalledTimes(1);
		lookup.resolve({ isLoggedIn: false, username: "first" });
		expect(await first).toBe(true);
		expect(client.token).toBe("first-token");
	});

	it("discards an identity lookup that finishes after disconnection", async () => {
		join();
		const lookup = deferred<{ isLoggedIn: false; username: string }>();
		vi.spyOn(tokens, "getSessionInfo").mockReturnValue(lookup.promise);
		const reauth = vi.fn();
		client.on("reauth", reauth);
		const pending = client.reauthenticate("new-token");
		client.onClose();
		lookup.resolve({ isLoggedIn: false, username: "new" });
		expect(await pending).toBe(false);
		expect(client.token).toBe("guest-token");
		expect(reauth).not.toHaveBeenCalled();
	});

	it("does not finish authentication after the socket is kicked", async () => {
		const lookup = deferred<{ isLoggedIn: false; username: string }>();
		vi.spyOn(tokens, "getSessionInfo").mockReturnValue(lookup.promise);
		const auth = vi.fn();
		client.on("auth", auth);
		const pending = client.auth("guest-token");
		client.kick(OttWebsocketError.MISSING_TOKEN);
		lookup.resolve({ isLoggedIn: false, username: "guest" });
		await pending;
		expect(auth).not.toHaveBeenCalled();
		expect(client.joinStatus).toBe(ClientJoinStatus.WaitingForAuth);
	});

	it("awaits the room identity change and keeps the old identity on failure", async () => {
		join();
		vi.spyOn(tokens, "getSessionInfo").mockResolvedValue({
			isLoggedIn: false,
			username: "new",
		});
		client.on("reauth", async () => {
			await Promise.resolve();
			throw new Error("Identity lookup failed");
		});
		expect(await client.reauthenticate("new-token")).toBe(false);
		expect(client.token).toBe("guest-token");
		expect(client.session).toEqual({ isLoggedIn: false, username: "guest" });
	});

	it("drops a slow socket before queuing another message, accounting for UTF-8 bytes", () => {
		socket.bufferedAmount = 8 * 1024 * 1024 - 2;
		client.sendRaw("字");
		expect(socket.send).not.toHaveBeenCalled();
		expect(socket.terminate).toHaveBeenCalledOnce();
		client.sendRaw("more");
		expect(socket.terminate).toHaveBeenCalledOnce();
	});

	it("skips closed sockets without affecting another viewer", () => {
		socket.readyState = WebSocket.CLOSED;
		client.sendRaw("closed");
		expect(socket.send).not.toHaveBeenCalled();
		const healthySocket = createSocket();
		const healthy = new DirectClient("transport-review", healthySocket as unknown as WebSocket);
		try {
			healthy.sendRaw("healthy");
			expect(healthySocket.send).toHaveBeenCalledOnce();
		} finally {
			healthy.onClose();
		}
	});

	it("contains asynchronous write errors and terminates only that socket", () => {
		socket.send.mockImplementation((_data: string, callback: (error?: Error) => void) => {
			callback(new Error("Write failed"));
		});
		expect(() => client.sendRaw("message")).not.toThrow();
		expect(socket.terminate).toHaveBeenCalledOnce();
	});

	it("contains a heartbeat write failure instead of interrupting the sweep", () => {
		socket.ping.mockImplementation(() => {
			throw new Error("Socket closed during heartbeat");
		});
		expect(() => client.ping()).not.toThrow();
		expect(socket.terminate).toHaveBeenCalledOnce();
	});
});
