import { inject, type InjectionKey, type App, type Plugin, ref, type Ref } from "vue";
import type {
	ClientMessage,
	ClientMessageAuthenticate,
	ServerMessage,
	ServerMessageActionType,
} from "ott-common/models/messages";
import type { AuthToken, OttWebsocketError } from "ott-common/models/types";

export interface OttRoomConnection {
	active: Ref<boolean>;
	connected: Ref<boolean>;
	kickReason: Ref<OttWebsocketError | null>;
	issue: Ref<"timeout" | "network" | null>;

	connect(roomName: string): void;
	reconnect(): void;
	disconnect(): void;
	send(message: ClientMessage): void;
	addMessageHandler(action: ServerMessageActionType, handler: (msg: ServerMessage) => void): void;
	removeMessageHandler(
		action: ServerMessageActionType,
		handler: (msg: ServerMessage) => void,
	): void;
	clearAllMessageHandlers(): void;
}

export const connectionInjectKey: InjectionKey<OttRoomConnection> = Symbol("ott:connection");

export function useConnection(): OttRoomConnection {
	const connection = inject(connectionInjectKey);
	if (!connection) {
		throw new Error("No connection available, did you forget to install the plugin?");
	}
	return connection;
}

type ConnectionEventKind = "connected" | "disconnected" | "kicked";

export type ConnectionEvent =
	| ConnectionEventConnected
	| ConnectionEventDisconnected
	| ConnectionEventKicked;

export interface ConnectionEventConnected {
	kind: "connected";
}

export interface ConnectionEventDisconnected {
	kind: "disconnected";
}

export interface ConnectionEventKicked {
	kind: "kicked";
	reason: OttWebsocketError;
}

function getReconnectDelayMs(
	reconnectAttempts: number,
	reconnectDelay: number,
	reconnectDelayIncrease: number,
	randomValue = Math.random(),
) {
	const baseDelay = reconnectDelay + reconnectDelayIncrease * reconnectAttempts;
	return Math.min(30000, Math.round(baseDelay * (0.5 + randomValue)));
}

export class OttRoomConnectionReal implements OttRoomConnection {
	/**
	 * Indicates if the client is actively attempting to maintain a connection. Not an indication of whether the connection is connected, see `connected`.
	 * @returns true if the client is actively attempting to maintain a connection to a room.
	 */
	active = ref(false);
	reconnecting = ref(false);
	connected = ref(false);
	roomName = ref("");
	reconnectAttempts = ref(0);
	reconnectDelay = 1000;
	reconnectDelayIncrease = 2000;
	kickReason: Ref<OttWebsocketError | null> = ref(null);
	issue: Ref<"timeout" | "network" | null> = ref(null);

	private socket: WebSocket | null = null;
	private reconnectTimeout: ReturnType<typeof setTimeout> | null = null;
	private connectTimeout: ReturnType<typeof setTimeout> | null = null;
	private readonly onOnline = () => {
		if (this.active.value && !this.connected.value) {
			this.reconnect();
		}
	};
	private readonly onOffline = () => {
		if (this.active.value) {
			this.failConnection("network");
		}
	};
	private messageHandlers = new Map<ServerMessageActionType, ((msg: ServerMessage) => void)[]>();
	private eventHandlers = new Map<ConnectionEventKind, ((e: unknown) => void)[]>();

	get connectionUrl() {
		return `${window.location.protocol.startsWith("https") ? "wss" : "ws"}://${
			window.location.host
		}${(import.meta.env.OTT_BASE_URL as string | undefined) ?? ""}/api/room/${
			this.roomName.value
		}`;
	}

	connect(roomName: string) {
		if (this.active.value) {
			console.log("connect(): connection is already active, ignoring");
			return;
		}
		this.roomName.value = roomName;
		this.active.value = true;
		this.kickReason.value = null;
		this.issue.value = null;
		this.reconnectAttempts.value = 0;
		window.addEventListener("online", this.onOnline);
		window.addEventListener("offline", this.onOffline);
		this.doConnect(this.connectionUrl);
	}

	reconnect() {
		if (!this.active.value) {
			console.log("reconnect(): connection is not active, ignoring");
			return;
		}
		console.log("reconnecting...");
		this.reconnectAttempts.value += 1;
		this.doConnect(`${this.connectionUrl}?reconnect=true`);
	}

	private doConnect(url: string) {
		this.clearTimers();
		this.closeSocket();
		this.connected.value = false;
		try {
			const socket = new WebSocket(url);
			this.socket = socket;
			// Closing an old socket is asynchronous. Its late events must never affect its replacement.
			socket.addEventListener("open", () => {
				if (this.socket === socket) {
					this.onOpen();
				}
			});
			socket.addEventListener("close", e => {
				if (this.socket === socket) {
					this.onClose(e);
				}
			});
			socket.addEventListener("message", e => {
				if (this.socket === socket) {
					this.onMessage(e);
				}
			});
			socket.addEventListener("error", () => {
				if (this.socket === socket) {
					this.failConnection("network");
				}
			});
			// Cover both a stalled WebSocket upgrade and an open socket that never completes room auth.
			this.connectTimeout = setTimeout(() => {
				if (this.socket === socket) {
					this.failConnection("timeout");
				}
			}, 15000);
		} catch {
			this.failConnection("network");
		}
	}

	send(message: ClientMessage) {
		if (!this.active.value) {
			throw new Error("send(): connection is not active");
		}
		if (!this.connected.value || this.socket?.readyState !== WebSocket.OPEN) {
			throw new Error("send(): connection is not connected");
		}
		const text = JSON.stringify(message);
		this.socket.send(text);
	}

	disconnect() {
		this.active.value = false;
		this.connected.value = false;
		this.reconnecting.value = false;
		this.issue.value = null;
		this.clearTimers();
		this.closeSocket();
		this.removeNetworkListeners();
		this.roomName.value = "";
	}

	private onOpen() {
		try {
			const authMsg: ClientMessageAuthenticate = {
				action: "auth",
				token: window.localStorage.getItem("token") as AuthToken,
			};
			this.socket!.send(JSON.stringify(authMsg));
		} catch {
			this.failConnection("network");
		}
	}

	private onClose(e: { code: number }) {
		if (e.code >= 4000) {
			this.clearTimers();
			this.closeSocket();
			this.connected.value = false;
			this.reconnecting.value = false;
			this.issue.value = null;
			this.kickReason.value = e.code;
			this.active.value = false;
			this.removeNetworkListeners();
			this.dispatchEvent({ kind: "disconnected" });
			this.dispatchEvent({ kind: "kicked", reason: e.code });
		} else if (this.active.value) {
			this.failConnection("network");
		}
	}

	private clearTimers() {
		if (this.connectTimeout !== null) {
			clearTimeout(this.connectTimeout);
		}
		if (this.reconnectTimeout !== null) {
			clearTimeout(this.reconnectTimeout);
		}
		this.connectTimeout = null;
		this.reconnectTimeout = null;
	}

	private closeSocket() {
		const socket = this.socket;
		this.socket = null;
		try {
			socket?.close();
		} catch {
			// Already closed or blocked sockets must not prevent cleanup or a fresh attempt.
		}
	}

	private removeNetworkListeners() {
		window.removeEventListener("online", this.onOnline);
		window.removeEventListener("offline", this.onOffline);
	}

	private failConnection(issue: "timeout" | "network") {
		this.clearTimers();
		this.closeSocket();
		this.connected.value = false;
		if (!this.active.value) {
			return;
		}
		this.issue.value = issue;
		this.reconnecting.value = true;
		this.dispatchEvent({ kind: "disconnected" });
		this.reconnectTimeout = setTimeout(() => this.reconnect(), this.getReconnectDelay());
	}

	private getReconnectDelay() {
		return getReconnectDelayMs(
			this.reconnectAttempts.value,
			this.reconnectDelay,
			this.reconnectDelayIncrease,
		);
	}

	private onMessage(e: { data: string | unknown }) {
		if (typeof e.data === "string") {
			try {
				const msg = JSON.parse(e.data) as ServerMessage;
				if (
					msg.action === "sync" &&
					typeof msg.name === "string" &&
					!this.connected.value
				) {
					this.clearTimers();
					this.connected.value = true;
					this.reconnecting.value = false;
					this.reconnectAttempts.value = 0;
					this.issue.value = null;
					this.dispatchEvent({ kind: "connected" });
				}
				this.handleMessage(msg);
			} catch {
				console.error("unable to process room message");
			}
		}
	}

	addMessageHandler(action: ServerMessageActionType, handler: (msg: ServerMessage) => void) {
		const handlers = this.messageHandlers.get(action) ?? [];
		handlers.push(handler);
		this.messageHandlers.set(action, handlers);
	}

	removeMessageHandler(action: ServerMessageActionType, handler: (msg: ServerMessage) => void) {
		const handlers = this.messageHandlers.get(action) ?? [];
		const index = handlers.indexOf(handler);
		if (index >= 0) {
			handlers.splice(index, 1);
			this.messageHandlers.set(action, handlers);
		}
	}

	clearAllMessageHandlers(): void {
		this.messageHandlers.clear();
	}

	private handleMessage(msg: ServerMessage) {
		const handlers = this.messageHandlers.get(msg.action) ?? [];
		if (handlers.length === 0) {
			console.error("connection: no message handlers for message: ", msg.action);
			return;
		}
		for (const handler of handlers) {
			handler(msg);
		}
	}

	addEventHandler(event: ConnectionEventKind, handler: (e: unknown) => void) {
		const handlers = this.eventHandlers.get(event) ?? [];
		handlers.push(handler);
		this.eventHandlers.set(event, handlers);
	}

	removeEventHandler(event: ConnectionEventKind, handler: (e: unknown) => void) {
		const handlers = this.eventHandlers.get(event) ?? [];
		const index = handlers.indexOf(handler);
		if (index >= 0) {
			handlers.splice(index, 1);
			this.eventHandlers.set(event, handlers);
		}
	}

	dispatchEvent(e: ConnectionEvent) {
		console.info("dispatching event", e);
		const handlers = this.eventHandlers.get(e.kind) ?? [];
		for (const handler of handlers) {
			handler(e);
		}
	}
}

export const OttRoomConnectionPlugin: Plugin = (app: App, options) => {
	const connection = new OttRoomConnectionReal();
	app.provide(connectionInjectKey, connection);
};

export default OttRoomConnectionPlugin;

export class OttRoomConnectionMock implements OttRoomConnection {
	active: Ref<boolean> = ref(false);
	connected: Ref<boolean> = ref(false);
	kickReason: Ref<OttWebsocketError | null> = ref(null);
	issue: Ref<"timeout" | "network" | null> = ref(null);

	sent: ClientMessage[] = [];
	private messageHandlers = new Map<ServerMessageActionType, ((msg: ServerMessage) => void)[]>();

	public mockReset() {
		this.sent = [];
	}

	public mockReceive(msg: ServerMessage) {
		this.handleMessage(msg);
	}

	// biome-ignore lint/suspicious/noEmptyBlockStatements: biome migration
	public connect(roomName: string) {}
	// biome-ignore lint/suspicious/noEmptyBlockStatements: biome migration
	public reconnect() {}
	// biome-ignore lint/suspicious/noEmptyBlockStatements: biome migration
	public disconnect() {}
	public send(message: ClientMessage) {
		this.sent.push(message);
	}

	public addMessageHandler(
		action: ServerMessageActionType,
		handler: (msg: ServerMessage) => void,
	) {
		const handlers = this.messageHandlers.get(action) ?? [];
		handlers.push(handler);
		this.messageHandlers.set(action, handlers);
	}

	public removeMessageHandler(
		action: ServerMessageActionType,
		handler: (msg: ServerMessage) => void,
	) {
		const handlers = this.messageHandlers.get(action) ?? [];
		const index = handlers.indexOf(handler);
		if (index >= 0) {
			handlers.splice(index, 1);
			this.messageHandlers.set(action, handlers);
		}
	}

	clearAllMessageHandlers(): void {
		this.messageHandlers.clear();
	}

	private handleMessage(msg: ServerMessage) {
		const handlers = this.messageHandlers.get(msg.action) ?? [];
		if (handlers.length === 0) {
			return;
		}
		for (const handler of handlers) {
			handler(msg);
		}
	}
}

export const MockOttRoomConnectionPlugin: Plugin = (app: App, options) => {
	const connection = new OttRoomConnectionMock();
	app.provide(connectionInjectKey, connection);
};
