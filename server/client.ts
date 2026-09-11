import {
	type AuthToken,
	type ClientId,
	type ClientInfo,
	OttWebsocketError,
	PlayerStatus,
} from "ott-common/models/types.js";
import { z } from "zod";
import type { ClientMessage, ServerMessage } from "ott-common/models/messages.js";
import type WebSocket from "ws";
import { type SessionInfo, setSessionInfo } from "./auth/tokens.js";
import { v4 as uuidv4 } from "uuid";
import EventEmitter from "node:events";
import { getLogger } from "./logger.js";
import { getSessionInfo } from "./auth/tokens.js";
import type { BalancerConnection } from "./balancer.js";
import { replacer } from "ott-common/serialize.js";
import { Counter } from "prom-client";

const log = getLogger("client");

export type ClientEvents = "auth" | "message" | "disconnect";
export type ClientEventHandlers<E> = E extends "auth"
	? (client: Client, token: AuthToken, session: SessionInfo) => void
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

	private bus: EventEmitter;

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
		this.joinStatus = ClientJoinStatus.Joined;
		this.emit("auth", this, this.token, this.session);
	}

	send(msg: ServerMessage) {
		this.sendRaw(JSON.stringify(msg, replacer));
	}

	abstract sendRaw(msg: string): void;
	abstract kick(code: OttWebsocketError): void;

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
const playbackPreparedSchema = z.object({
	id: z.string().max(100),
	position: z.number().finite(),
});

const clientMessageSchema = z.discriminatedUnion("action", [
	z.object({
		action: z.literal("auth"),
		token: z.string().max(512),
	}),
	z.object({
		action: z.literal("kickme"),
		reason: z.number().optional(),
	}),
	z.object({
		action: z.literal("status"),
		status: z.nativeEnum(PlayerStatus),
		playbackPrepared: playbackPreparedSchema.optional(),
	}),
	z.object({
		action: z.literal("notify"),
		message: z.literal("usernameChanged"),
	}),
	// Room requests are validated per command inside the room; the envelope guards size and shape.
	z.object({
		action: z.literal("req"),
		request: z.object({ type: z.string().max(64) }).passthrough(),
	}),
]);

export class DirectClient extends Client {
	socket: WebSocket;
	private authTimeout: ReturnType<typeof setTimeout>;

	constructor(room: string, socket: WebSocket) {
		super(room);
		this.socket = socket;

		this.socket.on("message", this.onData.bind(this));
		this.socket.on("ping", this.onPing.bind(this));
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
			this.emit("message", this, msg);
		} catch {
			this.kick(OttWebsocketError.UNKNOWN);
		}
	}

	onPing() {
		this.socket.pong();
	}

	onClose() {
		clearTimeout(this.authTimeout);
		this.emit("disconnect", this);
	}

	onError(err: Error) {
		log.error(`Error on socket for client ${this.id}: ${err}`);
	}

	sendRaw(msg: string) {
		this.socket.send(msg);
	}

	kick(code: OttWebsocketError) {
		clearTimeout(this.authTimeout);
		this.socket.close(code);
		counterWebsocketCloseCodes.inc({ code: OttWebsocketError[code] });
	}

	ping() {
		this.socket.ping();
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
		throw new Error("Not implemented");
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
