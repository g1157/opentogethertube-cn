import EventEmitter from "node:events";
import WebSocket from "ws";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { OttWebsocketError } from "ott-common/models/types.js";
import { ok } from "ott-common/result.js";
import { ClientJoinStatus, DirectClient } from "../../client.js";
import clientmanager, { sweepDeadClients } from "../../clientmanager.js";
import roommanager from "../../roommanager.js";
import { Room } from "../../room.js";
import { buildClients } from "../../redisclient.js";
import tokens from "../../auth/tokens.js";
import { UnloadReason } from "../../generated.js";

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

describe("client iteration during synchronous transport teardown", () => {
	let room: Room;
	const clients: { client: DirectClient; socket: ReturnType<typeof createSocket> }[] = [];
	const settle = () => new Promise<void>(resolve => setImmediate(resolve));

	beforeAll(async () => {
		await buildClients();
		await clientmanager.setup();
	});
	beforeEach(() => {
		room = new Room({ name: "broadcast-lifecycle", isTemporary: true });
		roommanager.rooms.push(room);
		vi.spyOn(room, "publish").mockResolvedValue();
		vi.spyOn(room, "onBeforeUnload").mockResolvedValue();
		vi.spyOn(roommanager, "getRoom").mockResolvedValue(ok(room));
		vi.spyOn(tokens, "getSessionInfo").mockImplementation(async token => ({
			isLoggedIn: false,
			username: token,
		}));
	});
	afterEach(async () => {
		for (const { client } of clients.splice(0)) {
			client.onClose();
		}
		await settle();
		room.throttledSync.cancel();
		room.saveStateToRedisDebounced.cancel();
		roommanager.clearRooms();
		vi.restoreAllMocks();
	});

	async function joinFour() {
		for (let index = 0; index < 4; index++) {
			const socket = createSocket();
			const client = new DirectClient(room.name, socket as unknown as WebSocket);
			client.token = "guest-" + index;
			client.session = { isLoggedIn: false, username: client.token };
			client.joinStatus = ClientJoinStatus.Joined;
			clients.push({ client, socket });
			clientmanager.addClient(client);
			client.emit("auth", client, client.token, client.session);
		}
		await vi.waitFor(() => expect(room.users).toHaveLength(4));
		for (const { socket } of clients) {
			socket.send.mockClear();
		}
	}

	it("closes every connection when shutting down, including adjacent clients", async () => {
		await joinFour();
		clientmanager.shutdown();
		for (const { client, socket } of clients) {
			expect(socket.close).toHaveBeenCalledWith(OttWebsocketError.AWAY);
			expect(clientmanager.getClient(client.id)).toBeUndefined();
		}
	});

	it("closes every room member when unloading a room", async () => {
		await joinFour();
		await roommanager.unloadRoom(room, UnloadReason.Admin);
		for (const { client, socket } of clients) {
			expect(socket.close).toHaveBeenCalledWith(OttWebsocketError.ROOM_UNLOADED);
			expect(clientmanager.getClient(client.id)).toBeUndefined();
		}
	});

	it("delivers the same sync to all healthy peers after dropping the first slow peer", async () => {
		await joinFour();
		clients[0].socket.bufferedAmount = 8 * 1024 * 1024 + 1;
		roommanager.publish(room.name, { action: "sync", isPlaying: false });
		expect(clients[0].socket.terminate).toHaveBeenCalledTimes(1);
		for (const { socket } of clients.slice(1)) {
			expect(socket.send).toHaveBeenCalledTimes(1);
			expect(JSON.parse(socket.send.mock.calls[0][0]).isPlaying).toBe(false);
		}
	});

	it("pings adjacent peers even when one ping synchronously terminates a socket", async () => {
		await joinFour();
		clients[0].socket.ping.mockImplementation(() => {
			throw new Error("broken transport");
		});
		sweepDeadClients();
		expect(clients[0].socket.terminate).toHaveBeenCalledTimes(1);
		for (const { socket } of clients.slice(1)) {
			expect(socket.ping).toHaveBeenCalledTimes(1);
		}
	});
});
