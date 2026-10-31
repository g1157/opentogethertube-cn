import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import clientmanager, { parseWebsocketConnectionUrl } from "../../../clientmanager.js";
import { Client, ClientJoinStatus } from "../../../client.js";
import { isAllowedWebSocketOrigin, setup, wss } from "../../../websockets.js";
import { ROOM_NAME_REGEX } from "ott-common/constants.js";
import { RoomRequestType } from "ott-common/models/messages.js";
import { buildClients } from "../../../redisclient.js";

class BudgetClient extends Client {
	sendRaw = vi.fn();
	kick = vi.fn();
	get clientType() {
		return "test";
	}
}

const settle = () => new Promise<void>(resolve => setImmediate(resolve));

describe("websocket boundary", () => {
	beforeAll(async () => {
		await buildClients();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("caps a websocket frame at 256 KiB", () => {
		expect((wss as any).options.maxPayload).toBe(256 * 1024);
	});

	it("rejects a cross-site upgrade before the websocket handshake", () => {
		let upgrade: ((req: any, socket: any, head: Buffer) => void) | undefined;
		const server = {
			on: vi.fn((event: string, handler: typeof upgrade) => {
				if (event === "upgrade") {
					upgrade = handler;
				}
				return server;
			}),
		} as unknown as Parameters<typeof setup>[0];
		setup(server);
		const socket = { write: vi.fn(), destroy: vi.fn() };

		upgrade!(
			{ headers: { origin: "https://evil.example", host: "localhost:8080" } },
			socket,
			Buffer.alloc(0),
		);

		expect(socket.write).toHaveBeenCalledWith(expect.stringContaining("403"));
		expect(socket.destroy).toHaveBeenCalled();
	});

	it.each([
		["/api/room/abc", "abc"],
		["/api/room/abc?reconnect=true", "abc"],
		["/api/room/ABC-123_x", "ABC-123_x"],
		["/api/room/", ""],
		["/api/room/..%2f..%2fetc", "..%2f..%2fetc"],
	])("parses the room from %s", (url, expected) => {
		const req = { url, headers: { host: "localhost" } } as any;
		expect(parseWebsocketConnectionUrl(req)).toBe(expected);
	});

	it.each([
		[undefined, "openvideo.117911.xyz", "openvideo.117911.xyz", true],
		["https://openvideo.117911.xyz", "openvideo.117911.xyz", "openvideo.117911.xyz", true],
		["http://localhost:8080", "localhost:8080", "localhost:8080", true],
		["https://150.158.143.199:8443", "150.158.143.199:8443", "", true],
		["https://openvideo.117911.xyz", "ott:8080", "openvideo.117911.xyz", true],
		["https://evil.example", "openvideo.117911.xyz", "openvideo.117911.xyz", false],
		["null", "openvideo.117911.xyz", "openvideo.117911.xyz", false],
		["https://openvideo.117911.xyz:444", "openvideo.117911.xyz", "openvideo.117911.xyz", false],
		["ftp://openvideo.117911.xyz", "openvideo.117911.xyz", "openvideo.117911.xyz", false],
		[["https://openvideo.117911.xyz"], "openvideo.117911.xyz", "openvideo.117911.xyz", false],
	])("checks the websocket origin %s against host %s", (origin, host, configured, expected) => {
		expect(isAllowedWebSocketOrigin(origin, host, configured)).toBe(expected);
	});

	it("rejects room names outside the shared regex", () => {
		for (const name of ["", "a b", "a/b", "a.b", "房间", "a:b"]) {
			expect(ROOM_NAME_REGEX.test(name), name).toBe(false);
		}
		for (const name of ["a", "A-1_x", "-", "_", "0"]) {
			expect(ROOM_NAME_REGEX.test(name), name).toBe(true);
		}
	});

	it("does not let a burst bypass the per-connection message budget", async () => {
		const client = new BudgetClient("budget-room");
		client.joinStatus = ClientJoinStatus.WaitingForAuth;
		clientmanager.addClient(client);
		try {
			for (let index = 0; index < 41; index++) {
				client.emit("message", client, { action: "ping", t0: index });
			}
			await settle();

			const responses = (client.sendRaw.mock.calls as unknown as [string][]).map(call =>
				JSON.parse(call[0]),
			);
			const pongs = responses.filter(message => message.action === "pong");
			const errors = responses.filter(message => message.action === "error");
			expect(pongs.length).toBe(40);
			expect(errors.length).toBeGreaterThan(0);
			expect(errors[0].name).toBe("TooManyRequests");
			expect(client.kick).not.toHaveBeenCalled();
		} finally {
			client.emit("disconnect", client);
			await settle();
		}
	});

	it.each([
		RoomRequestType.UpdateUser,
		RoomRequestType.JoinRequest,
		RoomRequestType.LeaveRequest,
	])("kicks a client that asks for the internal room request type %s", async type => {
		const client = new BudgetClient("budget-room");
		client.joinStatus = ClientJoinStatus.WaitingForAuth;
		clientmanager.addClient(client);
		try {
			client.emit("message", client, { action: "req", request: { type } } as any);
			await settle();
			expect(client.kick).toHaveBeenCalled();
		} finally {
			client.emit("disconnect", client);
			await settle();
		}
	});
});
