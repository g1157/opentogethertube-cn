import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OttRoomConnectionReal } from "@/plugins/connection";

class TestWebSocket extends EventTarget {
	static CONNECTING = 0;
	static OPEN = 1;
	static CLOSING = 2;
	static CLOSED = 3;
	static sockets: TestWebSocket[] = [];
	readyState = TestWebSocket.CONNECTING;
	send = vi.fn();
	close = vi.fn(() => {
		this.readyState = TestWebSocket.CLOSING;
	});
	constructor(readonly url: string) {
		super();
		TestWebSocket.sockets.push(this);
	}
	open() {
		this.readyState = TestWebSocket.OPEN;
		this.dispatchEvent(new Event("open"));
	}
	message(data: unknown) {
		this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(data) }));
	}
	finishClose(code = 1006) {
		this.readyState = TestWebSocket.CLOSED;
		this.dispatchEvent(new CloseEvent("close", { code }));
	}
}

describe("room WebSocket recovery", () => {
	let connection: OttRoomConnectionReal;
	beforeEach(() => {
		vi.useFakeTimers();
		const saved = new Map<string, string>();
		vi.stubGlobal("localStorage", {
			getItem: (key: string) => saved.get(key) ?? null,
			setItem: (key: string, value: string) => saved.set(key, value),
			clear: () => saved.clear(),
		});
		vi.spyOn(Math, "random").mockReturnValue(0.5);
		vi.spyOn(console, "info").mockImplementation(() => undefined);
		vi.spyOn(console, "log").mockImplementation(() => undefined);
		vi.spyOn(console, "error").mockImplementation(() => undefined);
		vi.stubGlobal("WebSocket", TestWebSocket);
		TestWebSocket.sockets = [];
		localStorage.setItem("token", "test-session");
		connection = new OttRoomConnectionReal();
		connection.addMessageHandler("sync", () => undefined);
	});
	afterEach(() => {
		connection.disconnect();
		localStorage.clear();
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
		vi.useRealTimers();
	});

	function join() {
		connection.connect("test-room");
		const socket = TestWebSocket.sockets.at(-1)!;
		socket.open();
		socket.message({ action: "sync", name: "test-room" });
		return socket;
	}

	it("authenticates on open and only reports connected after the full room sync", () => {
		const connected = vi.fn();
		connection.addEventHandler("connected", connected);
		connection.connect("test-room");
		const socket = TestWebSocket.sockets[0];
		socket.open();
		expect(socket.send).toHaveBeenCalledWith('{"action":"auth","token":"test-session"}');
		expect(connection.connected.value).toBe(false);
		socket.message({ action: "sync", name: "test-room" });
		expect(connection.connected.value).toBe(true);
		expect(connected).toHaveBeenCalledTimes(1);
		vi.advanceTimersByTime(60000);
		expect(TestWebSocket.sockets).toHaveLength(1);
	});

	it("times out a proxy that leaves the upgrade pending, then reconnects", () => {
		connection.connect("test-room");
		const first = TestWebSocket.sockets[0];
		vi.advanceTimersByTime(15000);
		expect(connection.issue.value).toBe("timeout");
		expect(first.close).toHaveBeenCalledTimes(1);
		vi.advanceTimersByTime(1000);
		expect(TestWebSocket.sockets).toHaveLength(2);
		const second = TestWebSocket.sockets[1];
		expect(second.url).toContain("?reconnect=true");
		second.open();
		second.message({ action: "sync", name: "test-room" });
		expect(connection.connected.value).toBe(true);
		expect(connection.issue.value).toBeNull();
	});

	it("also times out a socket that opens but never receives the authenticated room", () => {
		connection.connect("test-room");
		TestWebSocket.sockets[0].open();
		vi.advanceTimersByTime(15000);
		expect(connection.connected.value).toBe(false);
		expect(connection.issue.value).toBe("timeout");
	});

	it("ignores late open, sync, error and terminal close events from a replaced socket", () => {
		const first = join();
		connection.reconnect();
		const second = TestWebSocket.sockets[1];
		second.open();
		second.message({ action: "sync", name: "test-room" });
		first.open();
		first.message({ action: "sync", name: "wrong-room" });
		first.dispatchEvent(new Event("error"));
		first.finishClose(4000);
		expect(connection.active.value).toBe(true);
		expect(connection.connected.value).toBe(true);
		expect(connection.kickReason.value).toBeNull();
		expect(second.send).toHaveBeenCalledTimes(1);
		expect(second.close).not.toHaveBeenCalled();
	});

	it("schedules only one retry when error is followed by close", () => {
		const socket = join();
		socket.dispatchEvent(new Event("error"));
		socket.finishClose();
		expect(connection.issue.value).toBe("network");
		vi.advanceTimersByTime(1000);
		expect(TestWebSocket.sockets).toHaveLength(2);
	});

	it("disconnects safely while waiting to retry and removes online/offline listeners", () => {
		const socket = join();
		socket.finishClose();
		connection.disconnect();
		connection.disconnect();
		window.dispatchEvent(new Event("online"));
		window.dispatchEvent(new Event("offline"));
		vi.advanceTimersByTime(60000);
		expect(connection.active.value).toBe(false);
		expect(connection.connected.value).toBe(false);
		expect(connection.issue.value).toBeNull();
		expect(TestWebSocket.sockets).toHaveLength(1);
	});

	it("manual retry replaces the pending timer instead of creating overlapping sockets", () => {
		join().finishClose();
		connection.reconnect();
		const second = TestWebSocket.sockets[1];
		second.open();
		second.message({ action: "sync", name: "test-room" });
		vi.advanceTimersByTime(5000);
		expect(TestWebSocket.sockets).toHaveLength(2);
		expect(connection.connected.value).toBe(true);
	});

	it("reconnects immediately when the network comes back", () => {
		join();
		window.dispatchEvent(new Event("offline"));
		expect(connection.connected.value).toBe(false);
		expect(connection.issue.value).toBe("network");
		window.dispatchEvent(new Event("online"));
		expect(TestWebSocket.sockets).toHaveLength(2);
	});

	it("honors a server kick and does not reconnect after it", () => {
		join().finishClose(4000);
		expect(connection.active.value).toBe(false);
		expect(connection.kickReason.value).toBe(4000);
		window.dispatchEvent(new Event("online"));
		vi.advanceTimersByTime(60000);
		expect(TestWebSocket.sockets).toHaveLength(1);
	});

	it("caps retry backoff at 30 seconds after many failures", () => {
		const socket = join();
		connection.reconnectAttempts.value = 100;
		socket.finishClose();
		vi.advanceTimersByTime(29999);
		expect(TestWebSocket.sockets).toHaveLength(1);
		vi.advanceTimersByTime(1);
		expect(TestWebSocket.sockets).toHaveLength(2);
	});

	it("recovers from a WebSocket constructor failure", () => {
		vi.stubGlobal(
			"WebSocket",
			class {
				constructor() {
					throw new Error("blocked");
				}
			},
		);
		connection.connect("test-room");
		expect(connection.issue.value).toBe("network");
		vi.stubGlobal("WebSocket", TestWebSocket);
		vi.advanceTimersByTime(1000);
		expect(TestWebSocket.sockets).toHaveLength(1);
	});
});
