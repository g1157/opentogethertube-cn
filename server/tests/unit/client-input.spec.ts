import { afterEach, describe, expect, it, vi } from "vitest";
import EventEmitter from "node:events";
import type WebSocket from "ws";
import { OttWebsocketError } from "ott-common/models/types.js";
import { DirectClient } from "../../client.js";

describe("websocket input isolation", () => {
	const clients: DirectClient[] = [];
	afterEach(() => {
		for (const client of clients.splice(0)) {
			client.onClose();
		}
	});
	function connect() {
		const socket = Object.assign(new EventEmitter(), { close: vi.fn(), pong: vi.fn() });
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
});
