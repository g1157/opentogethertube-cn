import {
	type AuthToken,
	type ClientId,
	type ClientInfo,
	OttWebsocketError,
} from "ott-common/models/types.js";
import { clientMessageSchema } from "./ws-schemas.js";
import type { ClientMessage, ServerMessage } from "ott-common/models/messages.js";
import WebSocket from "ws";
import { type SessionInfo, setSessionInfo } from "./auth/tokens.js";
import { v4 as uuidv4 } from "uuid";
import EventEmitter from "node:events";
import { getLogger } from "./logger.js";
import { getSessionInfo } from "./auth/tokens.js";
import type { BalancerConnection } from "./balancer.js";
import { replacer } from "ott-common/serialize.js";
import { Counter } from "prom-client";

const log = getLogger("client");

/**
 * Latency-probe replies per connection: a short burst on join (the client needs several
 * samples to find its clock offset), then one per second. A flood is still bounded.
 */
const LATENCY_PROBE_BURST = 5;
const LATENCY_PROBE_REFILL_PER_SEC = 1;
const MAX_WEBSOCKET_BUFFERED_BYTES = 8 * 1024 * 1024;

export type ClientEvents = "auth" | "reauth" | "message" | "disconnect";
export type ClientEventHandlers<E> = E extends "auth" | "reauth"
	? (client: Client, token: AuthToken, session: SessionInfo) => void | Promise<void>
	: E extends "message"
		? (client: Client, msg: ClientMessage) => void
		: E extends "disconnect"
			? (client: Client) => void
			: never;

export enum ClientJoinStatus {
	WaitingForAuth,
	Joined,
}

/**
 * A client that is connected to the server.
 */
export abstract class Client {
	id: ClientId;
	room: string;
	token: AuthToken | null = null;
	session?: SessionInfo;
	joinStatus: ClientJoinStatus = ClientJoinStatus.WaitingForAuth;
	/** True when the websocket URL carried ?reconnect=true (session resume attempt). */
	isReconnect = false;

	private bus: EventEmitter;
	private disconnected = false;
	private reauthenticating = false;
	/** Probe reply budget; see LATENCY_PROBE_BURST. */
	private latencyTokens = LATENCY_PROBE_BURST;
	private latencyTokensUpdatedAt = 0;

	constructor(room: string) {
		this.id = uuidv4();
		this.room = room;
		this.bus = new EventEmitter();
	}

	abstract get clientType(): string;

	on<E extends ClientEvents>(event: E, handler: ClientEventHandlers<E>) {
		this.bus.on(event, handler);
	}

	emit<E extends ClientEvents>(event: E, ...args: Parameters<ClientEventHandlers<E>>) {
		if (event === "disconnect") {
			if (this.disconnected) {
				return;
			}
			this.disconnected = true;
		}
		this.bus.emit(event, ...args);
	}

	async saveSession(): Promise<void> {
		if (!this.token) {
			throw new Error("Client has not authenticated yet");
		}
		if (!this.session) {
			throw new Error("Client has no session");
		}
		await setSessionInfo(this.token, this.session);
	}

	public async auth(token: AuthToken): Promise<void> {
		if (this.disconnected) {
			return;
		}
		if (typeof token !== "string" || !token || token.length > 1024 || this.token !== null) {
			log.warn("Client sent empty auth token, kicking");
			this.kick(OttWebsocketError.MISSING_TOKEN);
			return;
		}
		this.token = token;
		try {
			this.session = await getSessionInfo(this.token);
		} catch (err) {
			log.warn(`Client sent invalid auth token, kicking: ${err}`);
			this.kick(OttWebsocketError.MISSING_TOKEN);
			return;
		}
		if (this.disconnected) {
			return;
		}
		this.joinStatus = ClientJoinStatus.Joined;
		this.emit("auth", this, this.token, this.session);
	}

	/**
	 * Update the identity of an already joined connection.
	 *
	 * A login rotates the token, but the open socket keeps the identity it
	 * authenticated with, which leaves the viewer stuck with the permissions of their
	 * old (guest) identity. Re-authenticating swaps the identity in place so the
	 * viewer keeps their seat and picks up their new role.
	 */
	public async reauthenticate(token: AuthToken): Promise<boolean> {
		if (
			typeof token !== "string" ||
			!token ||
			token.length > 1024 ||
			this.joinStatus !== ClientJoinStatus.Joined ||
			!this.token ||
			!this.session ||
			this.disconnected ||
			this.reauthenticating
		) {
			log.warn("Client sent an invalid re-authentication token");
			return false;
		}
		this.reauthenticating = true;
		const previousToken = this.token;
		const previousSession = this.session;
		try {
			const session = await getSessionInfo(token);
			if (this.disconnected) {
				return false;
			}
			this.token = token;
			this.session = session;
			const handlers = this.bus.listeners("reauth") as ClientEventHandlers<"reauth">[];
			await Promise.all(handlers.map(handler => handler(this, token, session)));
			return !this.disconnected;
		} catch (err) {
			this.token = previousToken;
			this.session = previousSession;
			log.warn(`Client sent an invalid re-authentication token: ${err}`);
			return false;
		} finally {
			this.reauthenticating = false;
		}
	}

	send(msg: ServerMessage) {
		this.sendRaw(JSON.stringify(msg, replacer));
	}

	abstract sendRaw(msg: string): void;
	abstract kick(code: OttWebsocketError): void;

	/**
	 * Spend one probe reply from this connection's budget. A joining client needs a short
	 * burst to get several round trips at once; the refill of one per second still bounds
	 * a flood. Both transports answer probes, so the budget lives on the connection.
	 */
	takeLatencyReplyToken(now = Date.now()): boolean {
		const elapsedSec = Math.max(0, now - this.latencyTokensUpdatedAt) / 1000;
		this.latencyTokens = Math.min(
			LATENCY_PROBE_BURST,
			this.latencyTokens + elapsedSec * LATENCY_PROBE_REFILL_PER_SEC,
		);
		this.latencyTokensUpdatedAt = now;
		if (this.latencyTokens < 1) {
			return false;
		}
		this.latencyTokens -= 1;
		return true;
	}

	getClientInfo(): ClientInfo {
		if (!this.session) {
			log.warn("Client has no session, client info will be incomplete");
			return {
				id: this.id,
			};
		}
		if (this.session.isLoggedIn) {
			return {
				id: this.id,
				user_id: this.session.user_id,
			};
		} else {
			return {
				id: this.id,
				username: this.session.username,
			};
		}
	}
}

/**
 * A client that is connected directly to the server.
 */
export class DirectClient extends Client {
	socket: WebSocket;
	/** Every pong sets this back to true; a sweep that finds it false terminates the socket. */
	isAlive = true;
	private authTimeout: ReturnType<typeof setTimeout>;
	private terminated = false;

	constructor(room: string, socket: WebSocket) {
		super(room);
		this.socket = socket;

		this.socket.on("message", this.onData.bind(this));
		this.socket.on("ping", this.onPing.bind(this));
		this.socket.on("pong", this.onPong.bind(this));
		this.socket.on("close", this.onClose.bind(this));
		this.socket.on("error", this.onError.bind(this));
		this.authTimeout = setTimeout(() => {
			if (this.joinStatus === ClientJoinStatus.WaitingForAuth) {
				this.kick(OttWebsocketError.MISSING_TOKEN);
			}
		}, 10000);
		this.authTimeout.unref();
	}

	get clientType() {
		return "direct";
	}

	onData(data: WebSocket.Data) {
		try {
			const parsed: unknown = JSON.parse(data.toString());
			const result = clientMessageSchema.safeParse(parsed);
			if (!result.success) {
				this.kick(OttWebsocketError.UNKNOWN);
				return;
			}
			const msg = result.data as unknown as ClientMessage;
			if (msg.action === "auth") {
				// eslint-disable-next-line promise/prefer-await-to-then -- Synchronous socket callback owns this asynchronous rejection.
				void this.auth(msg.token).catch(() => this.kick(OttWebsocketError.UNKNOWN));
				return;
			}
			if (this.joinStatus !== ClientJoinStatus.Joined) {
				this.kick(OttWebsocketError.MISSING_TOKEN);
				return;
			}
			if (msg.action === "ping") {
				this.replyToLatencyProbe(msg.t0);
				return;
			}
			this.emit("message", this, msg);
		} catch {
			this.kick(OttWebsocketError.UNKNOWN);
		}
	}

	onPing() {
		this.socket.pong();
	}

	onPong() {
		this.isAlive = true;
	}

	/**
	 * Answer a latency probe. Clients use the echoed send time for the round trip and the
	 * server time to place a sync on the server's clock; an over-budget probe is dropped
	 * silently, because the next refill answers it.
	 */
	private replyToLatencyProbe(t0: number) {
		if (!this.takeLatencyReplyToken()) {
			return;
		}
		this.send({ action: "pong", t0, serverTime: Date.now() });
	}

	onClose() {
		clearTimeout(this.authTimeout);
		this.emit("disconnect", this);
	}

	onError(err: Error) {
		log.error(`Error on socket for client ${this.id}: ${err}`);
	}

	sendRaw(msg: string) {
		if (this.terminated || this.socket.readyState !== WebSocket.OPEN) {
			return;
		}
		if (
			this.socket.bufferedAmount + Buffer.byteLength(msg, "utf8") >
			MAX_WEBSOCKET_BUFFERED_BYTES
		) {
			log.warn(`Terminating slow websocket client ${this.id}`);
			this.terminate();
			return;
		}
		try {
			this.socket.send(msg, error => {
				if (error) {
					this.onError(error);
					this.terminate();
				}
			});
		} catch (error) {
			log.warn(`Failed to write to websocket client ${this.id}: ${String(error)}`);
			this.terminate();
		}
	}

	private terminate() {
		if (this.terminated) {
			return;
		}
		this.terminated = true;
		clearTimeout(this.authTimeout);
		this.socket.terminate();
		this.onClose();
	}

	kick(code: OttWebsocketError) {
		clearTimeout(this.authTimeout);
		this.socket.close(code);
		this.onClose();
		counterWebsocketCloseCodes.inc({ code: OttWebsocketError[code] });
	}

	ping() {
		if (this.terminated || this.socket.readyState !== WebSocket.OPEN) {
			return;
		}
		try {
			this.socket.ping();
		} catch (error) {
			log.warn(`Failed to ping websocket client ${this.id}: ${String(error)}`);
			this.terminate();
		}
	}
}

/**
 * A client that is connected from a load balancer.
 */
export class BalancerClient extends Client {
	conn: BalancerConnection;

	constructor(room: string, clientId: ClientId, conn: BalancerConnection) {
		super(room);
		this.id = clientId;
		this.conn = conn;
	}

	get clientType() {
		return "balancer.js";
	}

	leave() {
		this.emit("disconnect", this);
	}

	receiveMessage(msg: ClientMessage) {
		this.emit("message", this, msg);
	}

	send(msg: ServerMessage) {
		this.conn.send({
			type: "room_msg",
			payload: {
				room: this.room,
				client_id: this.id,
				payload: msg,
			},
		});
	}

	sendRaw(msg: string) {
		// Raw payloads are serialized ServerMessages (e.g. announcements). Route them
		// like any other room message; a balancer client has no direct socket.
		try {
			const parsed = JSON.parse(msg) as ServerMessage;
			this.send(parsed);
		} catch {
			// Not a ServerMessage; nothing sensible to route, but never crash the caller.
		}
	}

	kick(code: OttWebsocketError) {
		this.conn.send({
			type: "kick",
			payload: {
				client_id: this.id,
				reason: code,
			},
		});
		counterWebsocketCloseCodes.inc({ code: OttWebsocketError[code] });
		this.leave();
	}
}

const counterWebsocketCloseCodes = new Counter({
	name: "ott_websocket_kick_close_codes",
	help: "Count of websocket close codes",
	labelNames: ["code"],
});
