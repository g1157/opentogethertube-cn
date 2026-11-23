import { afterEach, describe, expect, it, vi } from "vitest";
import EventEmitter from "node:events";
import type WebSocket from "ws";
import { OttWebsocketError } from "ott-common/models/types.js";
import { ClientJoinStatus, DirectClient } from "../../client.js";

describe("websocket input isolation", () => {
	const clients: DirectClient[] = [];
	afterEach(() => {
		for (const client of clients.splice(0)) {
			client.onClose();
		}
		vi.useRealTimers();
	});
	function connect() {
		const socket = Object.assign(new EventEmitter(), {
			close: vi.fn(),
			pong: vi.fn(),
			send: vi.fn(),
			readyState: 1,
		});
		const client = new DirectClient("test-room", socket as unknown as WebSocket);
		clients.push(client);
		return { client, socket };
	}
	it.each([
		"{",
		"null",
		"[]",
		"1",
		'"message"',
		'{"action":null}',
	])("closes only the bad connection for %s", data => {
		const { socket } = connect();
		expect(() => socket.emit("message", Buffer.from(data))).not.toThrow();
		expect(socket.close).toHaveBeenCalledWith(OttWebsocketError.UNKNOWN);
	});
	it("rejects room messages before authentication", () => {
		const { client, socket } = connect();
		const handler = vi.fn();
		client.on("message", handler);
		socket.emit("message", Buffer.from('{"action":"status","status":"ready"}'));
		expect(socket.close).toHaveBeenCalledWith(OttWebsocketError.MISSING_TOKEN);
		expect(handler).not.toHaveBeenCalled();
	});

	it("answers a burst of probes with the server clock, then one per second", () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
		const { client, socket } = connect();
		client.joinStatus = ClientJoinStatus.Joined;
		const replies = () =>
			(socket.send as unknown as { mock: { calls: [string][] } }).mock.calls.map(([text]) =>
				JSON.parse(text),
			);
		for (let index = 0; index < 6; index++) {
			socket.emit("message", Buffer.from(JSON.stringify({ action: "ping", t0: index })));
		}

		// A joining client needs several samples to find its clock offset at once.
		expect(replies()).toHaveLength(5);
		expect(replies()[0]).toEqual({
			action: "pong",
			t0: 0,
			serverTime: Date.now(),
		});

		vi.advanceTimersByTime(1000);
		socket.emit("message", Buffer.from(JSON.stringify({ action: "ping", t0: 6 })));
		expect(replies()).toHaveLength(6);
		expect(replies()[5]).toMatchObject({ action: "pong", t0: 6 });
	});
});
