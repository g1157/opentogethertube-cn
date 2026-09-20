import type express from "express";
import type WebSocket from "ws";
import { wss } from "./websockets.js";
import { getLogger } from "./logger.js";
import type { Request } from "express";
import { createSubscriber } from "./redisclient.js";
import {
	type ClientMessage,
	type RoomRequest,
	RoomRequestType,
	type ServerMessage,
	type ServerMessageError,
	type ServerMessageSync,
	type ServerMessageUser,
	type ServerMessageYou,
	type ServerMessageSignal,
	type ServerMessageVoice,
	type ClientMessageSignal,
} from "ott-common/models/messages.js";
import { ClientNotFoundInRoomException, MissingToken } from "./exceptions.js";
import { getVoiceIceServers, isVoiceEnabled } from "./voice.js";
import { decideVoiceJoin, isRelayAllowedNow, recordUsage } from "./voice-budget.js";
import {
	type MySession,
	OttWebsocketError,
	type AuthToken,
	type ClientId,
} from "ott-common/models/types.js";
import roommanager from "./roommanager.js";
import storage from "./storage.js";
import { ANNOUNCEMENT_CHANNEL, ROOM_NAME_REGEX } from "ott-common/constants.js";
import tokens, { type SessionInfo } from "./auth/tokens.js";
import { Gauge } from "prom-client";
import { replacer } from "ott-common/serialize.js";
import { type Client, ClientJoinStatus, DirectClient, BalancerClient } from "./client.js";
import {
	type BalancerConnection,
	type MsgB2M,
	balancerManager,
	buildGossipMessage,
	initBalancerConnections,
} from "./balancer.js";
import usermanager from "./usermanager.js";
import { OttException } from "ott-common/exceptions.js";
import { conf } from "./ott-config.js";
import { UnloadReason } from "./generated.js";

const log = getLogger("clientmanager");

// Membership and identity updates are server lifecycle events, never client requests.
const CLIENT_ROOM_REQUEST_TYPES = new Set<RoomRequestType>([
	RoomRequestType.PlaybackRequest,
	RoomRequestType.SkipRequest,
	RoomRequestType.SeekRequest,
	RoomRequestType.AddRequest,
	RoomRequestType.RemoveRequest,
	RoomRequestType.OrderRequest,
	RoomRequestType.VoteRequest,
	RoomRequestType.PromoteRequest,
	RoomRequestType.ChatRequest,
	RoomRequestType.UndoRequest,
	RoomRequestType.ApplySettingsRequest,
	RoomRequestType.PlayNowRequest,
	RoomRequestType.ShuffleRequest,
	RoomRequestType.PlaybackSpeedRequest,
	RoomRequestType.RestoreQueueRequest,
	RoomRequestType.KickRequest,
	RoomRequestType.UpdateQueueItemRequest,
	RoomRequestType.TemporaryPlaybackSpeedRequest,
	RoomRequestType.AddNoteRequest,
	RoomRequestType.DeleteNoteRequest,
]);

const connections: Client[] = [];
const roomJoins: Map<string, Client[]> = new Map();
const pendingRoomJoins = new Map<Client, Promise<void>>();
const voiceParticipants: Map<string, Set<ClientId>> = new Map();

function buildVoiceMessage(roomName: string, includeRelay: boolean): ServerMessageVoice {
	return {
		action: "voice",
		participants: [...(voiceParticipants.get(roomName) ?? [])],
		iceServers: getVoiceIceServers(includeRelay),
		relay: includeRelay,
	};
}

/**
 * Relay a WebRTC signal to exactly one other client. Both parties must already be in voice in the
 * same room, so this cannot be used to reach arbitrary sockets.
 */
function relayVoiceSignal(client: Client, msg: ClientMessageSignal): void {
	const participants = voiceParticipants.get(client.room);
	if (!participants?.has(client.id) || !participants.has(msg.to)) {
		return;
	}
	const target = getClient(msg.to);
	if (!target || target.room !== client.room) {
		return;
	}
	const relay: ServerMessageSignal = {
		action: "signal",
		from: client.id,
		signal: msg.signal,
	};
	target.send(relay);
}

async function setVoicePresence(client: Client, joinedVoice: boolean): Promise<void> {
	if (!isVoiceEnabled() || client.joinStatus !== ClientJoinStatus.Joined) {
		if (joinedVoice) {
			client.send({ ...buildVoiceMessage(client.room, false), denied: "disabled" });
		}
		return;
	}
	let participants = voiceParticipants.get(client.room);
	if (!participants) {
		participants = new Set();
		voiceParticipants.set(client.room, participants);
	}
	if (joinedVoice && !participants.has(client.id)) {
		let otherVoiceRooms = 0;
		for (const set of voiceParticipants.values()) {
			if (set !== participants && set.size > 0) {
				otherVoiceRooms++;
			}
		}
		const decision = await decideVoiceJoin({
			roomParticipants: participants.size,
			roomAlreadyInVoice: participants.size > 0,
			voiceRoomCount: otherVoiceRooms,
		});
		if (!decision.allowed) {
			// A set created only to hold this refused join must not linger and count as a room.
			if (participants.size === 0) {
				voiceParticipants.delete(client.room);
			}
			client.send({
				...buildVoiceMessage(client.room, decision.includeRelay),
				denied: decision.reason,
			});
			return;
		}
		participants.add(client.id);
	} else if (!joinedVoice) {
		participants.delete(client.id);
	}
	if (participants.size === 0) {
		voiceParticipants.delete(client.room);
	}
	await broadcast(client.room, buildVoiceMessage(client.room, await isRelayAllowedNow()));
}

/**
 * Called when a socket disconnects. Peers need the updated list, otherwise they keep a dead
 * connection and the participant lingers in everyone's UI.
 */
async function removeFromVoice(client: Client): Promise<void> {
	const participants = voiceParticipants.get(client.room);
	if (!participants?.delete(client.id)) {
		return;
	}
	if (participants.size === 0) {
		voiceParticipants.delete(client.room);
	}
	try {
		await broadcast(client.room, buildVoiceMessage(client.room, await isRelayAllowedNow()));
	} catch (e) {
		log.error(`Failed to broadcast voice presence after ${client.id} left: ${e}`);
	}
}
export async function setup(): Promise<void> {
	log.debug("setting up client manager...");
	const server = wss;
	server.on("connection", async (ws, req: Request & { session: MySession }) => {
		if (!req.url.startsWith(`${conf.get("base_url")}/api/room/`)) {
			log.error("Rejecting connection because the connection url was invalid");
			ws.close(OttWebsocketError.INVALID_CONNECTION_URL, "Invalid connection url");
			return;
		}
		await onDirectConnect(ws, req);
	});
	roommanager.on("publish", onRoomPublish);
	roommanager.on("unload", onRoomUnload);
	roommanager.on("command", handleCommand);

	usermanager.on("userModified", onUserModified);

	setupBalancerManager();
	initBalancerConnections();

	if (conf.get("env") !== "test") {
		log.silly("creating redis subscriber");
		const redisSubscriber = await createSubscriber();
		log.silly("subscribing to announcement channel");
		await redisSubscriber.subscribe(ANNOUNCEMENT_CHANNEL, onAnnouncement);
	}
}

export function setupBalancerManager() {
	balancerManager.on("connect", onBalancerConnect);
	balancerManager.on("disconnect", onBalancerDisconnect);
	balancerManager.on("message", onBalancerMessage);
	balancerManager.on("error", onBalancerError);
}

export function shutdown() {
	log.info("Shutting down client manager");
	balancerManager.shutdown();
	for (const client of connections) {
		client.kick(OttWebsocketError.AWAY);
	}
}

/**
 * Called when a websocket connects.
 * @param socket
 */
async function onDirectConnect(socket: WebSocket, req: express.Request) {
	try {
		const roomName = parseWebsocketConnectionUrl(req);
		if (!ROOM_NAME_REGEX.test(roomName)) {
			log.warn("Rejecting connection because the room name was invalid");
			socket.close(OttWebsocketError.INVALID_CONNECTION_URL, "Invalid room name");
			return;
		}
		log.debug(`connection received: ${roomName}, waiting for auth token...`);
		const client = new DirectClient(roomName, socket);
		client.isReconnect = isReconnectRequest(req);
		addClient(client);
	} catch (e) {
		log.error(`Failed to process new client : ${e}`);
		socket.close(OttWebsocketError.UNKNOWN);
	}
}

/**
 * Extract the room name from the websocket connection url.
 * @returns Room name
 */
export function parseWebsocketConnectionUrl(req: express.Request): string {
	const connectUrl = new URL(req.url, `ws://${req.headers.host ?? "localhost"}`);
	const baseUrl = conf.get("base_url");
	const adjustedPath = baseUrl ? connectUrl.pathname.replace(baseUrl, "") : connectUrl.pathname;
	const roomName = adjustedPath.split("/").slice(3)[0];
	return roomName;
}

/**
 * Whether the websocket connection url carries ?reconnect=true.
 */
function isReconnectRequest(req: express.Request): boolean {
	const connectUrl = new URL(req.url, `ws://${req.headers.host ?? "localhost"}`);
	return connectUrl.searchParams.get("reconnect") === "true";
}

export function addClient(client: Client) {
	log.info(`New ${client.clientType} client (${client.id}) joining room ${client.room}`);
	connections.push(client);
	client.on("auth", onClientAuth);
	client.on("message", onClientMessage);
	client.on("disconnect", onClientDisconnect);
}

async function onClientAuth(client: Client, token: AuthToken, session: SessionInfo) {
	const joining = joinAuthenticatedClient(client, token, session);
	pendingRoomJoins.set(client, joining);
	try {
		await joining;
	} catch (error) {
		log.error(`Failed to finish joining client ${client.id}: ${String(error)}`);
		if (connections.includes(client)) {
			client.kick(OttWebsocketError.UNKNOWN);
		}
	} finally {
		pendingRoomJoins.delete(client);
	}
}

async function joinAuthenticatedClient(client: Client, token: AuthToken, session: SessionInfo) {
	const result = await roommanager.getRoom(client.room);
	if (!connections.includes(client)) {
		return;
	}
	if (!result.ok) {
		client.kick(OttWebsocketError.ROOM_NOT_FOUND);
		return;
	}
	const room = result.value;
	client.room = room.name;
	room.holdEmptyPlaybackForJoin(client.isReconnect);

	// full sync
	const syncMsg = Object.assign(
		{ action: "sync" },
		room.syncableState(),
	) as unknown as ServerMessageSync;
	client.send(syncMsg);

	// join the room
	let clients = roomJoins.get(room.name);
	if (clients === undefined) {
		log.warn("room joins not present, creating");
		clients = [];
		roomJoins.set(room.name, clients);
	}
	clients.push(client);

	// actually join the room
	try {
		await makeRoomRequest(client, {
			type: RoomRequestType.JoinRequest,
			info: client.getClientInfo(),
			reconnect: client.isReconnect,
		});
	} catch (e) {
		log.error(`Failed to process join request for client ${client.id}: ${e}`);
	}
	if (!connections.includes(client)) {
		// Disconnect waits for this operation, then removes the member that joinRoom may have added.
		return;
	}

	// Joining can adjust the authoritative position (for example when an empty room resumes).
	// Only the joining client needs that update; broadcasting it would force every other
	// viewer to re-align and briefly freeze their playback.
	const positionMsg: ServerMessageSync = {
		action: "sync",
		playbackPosition: room.realPlaybackPosition,
	};
	client.send(positionMsg);

	// Notes are a variable-length list, so they are not part of `sync`; the joining client
	// gets the full list once and receives every later change as a broadcast.
	const notes = room.isTemporary ? [] : await storage.listNotes(room.name);
	client.send(room.buildNotesMessage(notes));

	// initialize client info
	const clientsInit: ServerMessageUser = {
		action: "user",
		update: {
			kind: "init",
			value: room.users,
		},
	};
	client.send(clientsInit);

	const youmsg: ServerMessageYou = {
		action: "you",
		info: {
			id: client.id,
		},
	};
	client.send(youmsg);

	// Let the client know voice exists and who is already in it, before it joins.
	if (isVoiceEnabled()) {
		client.send(buildVoiceMessage(room.name, await isRelayAllowedNow()));
	}
}

async function onClientMessage(client: Client, msg: ClientMessage) {
	try {
		if (msg.action === "kickme") {
			client.kick(msg.reason ?? OttWebsocketError.UNKNOWN);
			return;
		} else if (msg.action === "status") {
			const request: RoomRequest = {
				type: RoomRequestType.UpdateUser,
				info: {
					id: client.id,
					status: msg.status,
				},
				playbackPrepared: msg.playbackPrepared,
			};
			await makeRoomRequest(client, request);
		} else if (msg.action === "req") {
			if (
				!msg.request ||
				typeof msg.request !== "object" ||
				Array.isArray(msg.request) ||
				!CLIENT_ROOM_REQUEST_TYPES.has(msg.request.type)
			) {
				log.warn(`Rejecting invalid or internal room request from client ${client.id}`);
				client.kick(OttWebsocketError.UNKNOWN);
				return;
			}
			// WS requests bypass the REST body schemas; enforce the same content caps
			// so oversized text cannot reach storage or every client's UI.
			if (msg.request.type === RoomRequestType.ApplySettingsRequest) {
				const settings = (
					msg.request as { settings?: { title?: unknown; description?: unknown } }
				).settings;
				if (settings) {
					if (typeof settings.title === "string" && settings.title.length > 254) {
						throw new OttException("title is too long (max 254 characters)");
					}
					if (
						typeof settings.description === "string" &&
						settings.description.length > 5000
					) {
						throw new OttException("description is too long (max 5000 characters)");
					}
				}
			} else if (msg.request.type === RoomRequestType.ChatRequest) {
				const text = (msg.request as { text?: unknown }).text;
				if (typeof text !== "string" || text.length === 0 || text.length > 300) {
					throw new OttException("chat message must be between 1 and 300 characters");
				}
			}
			await makeRoomRequest(client, msg.request);
		} else if (msg.action === "voice") {
			await setVoicePresence(client, msg.joined);
		} else if (msg.action === "signal") {
			relayVoiceSignal(client, msg);
		} else if (msg.action === "notify") {
			if (msg.message === "usernameChanged") {
				onUserModified(client.token!);
			} else {
				log.warn(`Unknown notify message: ${msg.message}`);
			}
		} else {
			log.warn(`Unknown client message: ${(msg as { action: string }).action}`);
			return;
		}
	} catch (err) {
		log.error(
			`Failed to process client (id=${client.id}, room=${client.room}) message (action=${msg.action}): ${err}`,
		);
		if (err instanceof MissingToken) {
			// The connection cannot be authorized at all, so there is nothing to recover.
			log.error("Client is missing token, kicking client");
			client.kick(OttWebsocketError.MISSING_TOKEN);
			return;
		}
		// A failed request (bad video, permission denied, probe failure, ...) must never
		// drop the connection. Report it to the client that asked; explicit kicks use
		// handleCommand, and connection level failures above use their own codes.
		const errorMsg: ServerMessageError = {
			action: "error",
			name: err instanceof Error ? err.name : "UnknownError",
			message: err instanceof Error ? err.message : String(err),
		};
		try {
			client.send(errorMsg);
		} catch (sendError) {
			log.error(`Failed to report a request error to client ${client.id}: ${sendError}`);
		}
	}
}

async function onClientDisconnect(client: Client) {
	log.debug(`Client ${client.id} disconnected`);
	const index = connections.indexOf(client);
	if (index !== -1) {
		const clients = connections.splice(index, 1);
		if (clients.length !== 1) {
			log.error("failed to remove client from connections");
			return;
		}
		const client = clients[0];
		const joins = roomJoins.get(client.room);
		if (joins) {
			const index = joins.indexOf(client);
			if (index !== -1) {
				joins.splice(index, 1);
			}
		}
	}

	await removeFromVoice(client);

	// A socket can close while joinRoom awaits identity lookup. Do not let its leave run before
	// the pending join adds the member, leaving a disconnected playback preparer in the room.
	try {
		await pendingRoomJoins.get(client);
	} catch {
		// onClientAuth owns reporting the failed join; any partially added member still needs cleanup.
	}
	if (client.joinStatus !== ClientJoinStatus.Joined) {
		log.debug(`Client ${client.id} disconnected before joining`);
		return;
	}

	const result = await roommanager.getRoom(client.room, { mustAlreadyBeLoaded: true });
	if (!result.ok) {
		log.error(
			`Failed to get room ${client.room} when processing disconnect: ${result.value.name}: ${result.value.message}`,
		);
		return;
	}
	const room = result.value;
	if (!room.getUser(client.id)) {
		return;
	}
	// it's safe to bypass authenticating the leave request because this event is only triggered by the socket closing
	try {
		await room.processRequestUnsafe(
			{
				type: RoomRequestType.LeaveRequest,
			},
			client.id,
		);
	} catch (err) {
		log.error(`Failed to process leave request for client ${client.id}: ${err}`);
	}

	await broadcast(room.name, {
		action: "user",
		update: {
			kind: "remove",
			value: client.id,
		},
	});
}

function onBalancerConnect(conn: BalancerConnection) {
	log.info(`Connected to balancer ${conn.id}`);
	const result = conn.send(buildGossipMessage());
	if (!result.ok) {
		log.error(`Failed to send initial gossip message to balancer ${conn.id}: ${result.value}`);
	}
}

function onBalancerDisconnect(conn: BalancerConnection) {
	log.info(`Disconnected from balancer ${conn.id}`);
	// We can't immediately remove the balancer clients from the connections array because that would mess up the index of the other clients, so we have to do it later
	const leavingClients: BalancerClient[] = [];
	for (const client of connections) {
		if (client instanceof BalancerClient && client.conn.id === conn.id) {
			log.debug(`Kicking balancer client ${client.id}`);
			leavingClients.push(client);
		}
	}
	for (const client of leavingClients) {
		client.leave();
	}
}

async function onBalancerMessage(conn: BalancerConnection, message: MsgB2M) {
	log.silly(`balancer message: ${JSON.stringify(message)}`);

	/**
	 * This is a type that maps the message type to the handler for that message type.
	 *
	 * Useful for handling enums that are discriminated by a string, like the ones generated by typeshare.
	 */
	type EnumHandler<T extends { type: string; payload: T["payload"] }> = {
		[P in T["type"]]: (
			instruction: Extract<T, { type: P; payload: T["payload"] }>,
		) => Promise<void>;
	};

	// the intersection type makes it so that it throws a compile error if all the enum variants aren't handled
	const handlers: Record<MsgB2M["type"], unknown> & EnumHandler<MsgB2M> = {
		load: async message => {
			log.debug(`Balancer requested to load room ${message.payload.room}`);
			const msg = message.payload;
			await roommanager.getRoom(msg.room);
		},
		unload: async message => {
			log.debug(`Balancer requested to unload room ${message.payload.room}`);
			const msg = message.payload;
			await roommanager.unloadRoom(msg.room, UnloadReason.Commanded);
		},
		join: async message => {
			const msg = message.payload;
			const client = new BalancerClient(msg.room, msg.client, conn);
			connections.push(client);
			client.on("auth", onClientAuth);
			client.on("message", onClientMessage);
			client.on("disconnect", onClientDisconnect);
			client.auth(msg.token);
		},
		leave: async message => {
			const msg = message.payload;
			const client = connections.find(c => c.id === msg.client);
			if (client instanceof BalancerClient) {
				client.leave();
			} else {
				log.error(
					`Balancer tried to make client leave that does not exist or is not a balancer client`,
				);
			}
		},
		client_msg: async message => {
			const msg = message.payload;
			const client = connections.find(c => c.id === msg.client_id);
			if (client instanceof BalancerClient) {
				client.receiveMessage(msg.payload as ClientMessage);
			} else {
				log.error(
					`Balancer sent message for client that does not exist or is not a balancer client`,
				);
			}
		},
		init: async message => {
			const msg = message.payload;
			conn.id = msg.id;
			log.info(`Received init message: ${JSON.stringify(msg.id)}`);
		},
	};

	const handler = handlers[message.type];
	if (!handler) {
		log.error(`Unknown balancer message type: ${(message as { type: string }).type}`);
		return;
	}
	await handler(message as any); // this cast is safe because the type is checked and narrowed above
}

function onBalancerError(conn: BalancerConnection, error: WebSocket.ErrorEvent) {
	log.error(`Error from balancer ${conn.id}: ${error}`);
}

async function makeRoomRequest(client: Client, request: RoomRequest): Promise<void> {
	if (!client.token) {
		throw new MissingToken();
	}
	const result = await roommanager.getRoom(client.room, {
		mustAlreadyBeLoaded: true,
	});
	if (!result.ok) {
		log.error(`Failed to get room ${client.room} when processing request`);
		return;
	}
	const room = result.value;
	await room.processUnauthorizedRequest(request, {
		token: client.token,
		clientId: client.id,
	});
}

async function broadcast(roomName: string, msg: ServerMessage) {
	const clients = roomJoins.get(roomName);
	if (!clients) {
		return;
	}
	const text = JSON.stringify(msg, replacer);
	const balancers = new Set<string>();
	for (const client of clients) {
		if (client instanceof BalancerClient) {
			balancers.add(client.conn.id);
		} else {
			try {
				client.sendRaw(text);
			} catch (e) {
				if (e instanceof Error) {
					log.error(`failed to send to client: ${e.message}`);
				} else {
					log.error(`failed to send to client`);
				}
			}
		}
	}

	// broadcast to balancers
	for (const balancerId of balancers) {
		const conn = balancerManager.getConnection(balancerId);
		if (!conn) {
			log.error(`Balancer ${balancerId} not found`);
			continue;
		}
		conn.send({
			type: "room_msg",
			payload: {
				room: roomName,
				payload: msg,
			},
		});
	}
}

async function onRoomPublish(roomName: string, msg: ServerMessage) {
	await broadcast(roomName, msg);
}

async function handleCommand(roomName: string, command: ClientManagerCommand) {
	if (command.type === "kick") {
		const client = getClient(command.clientId);
		client?.kick(OttWebsocketError.KICKED);
	}
}

const roomUnloadReasons: Record<UnloadReason, OttWebsocketError> = {
	[UnloadReason.Keepalive]: OttWebsocketError.ROOM_UNLOADED,
	[UnloadReason.Admin]: OttWebsocketError.ROOM_UNLOADED,
	[UnloadReason.Commanded]: OttWebsocketError.AWAY,
	[UnloadReason.Shutdown]: OttWebsocketError.AWAY,
};

function onRoomUnload(roomName: string, reason: UnloadReason) {
	const code = roomUnloadReasons[reason];
	const clients = roomJoins.get(roomName);
	log.debug(`Room unloaded, kicking ${clients?.length} clients`);
	if (clients) {
		for (const client of clients) {
			client.kick(code);
		}
	}

	roomJoins.delete(roomName);
	voiceParticipants.delete(roomName);
}

function onAnnouncement(text: string) {
	log.debug(`Announcement: ${text}`);
	for (const client of connections) {
		try {
			client.sendRaw(text);
		} catch (e) {
			if (e instanceof Error) {
				log.error(`failed to send to client: ${e.message}`);
			} else {
				log.error(`failed to send to client`);
			}
		}
	}
}

async function onUserModified(token: AuthToken): Promise<void> {
	log.debug(`User was modified, pulling info and telling rooms`);
	for (const client of connections) {
		if (client.token === token) {
			client.session = await tokens.getSessionInfo(token);
			await makeRoomRequest(client, {
				type: RoomRequestType.UpdateUser,
				info: client.getClientInfo(),
			});
		}
	}
}

function getClientByToken(token: AuthToken, roomName: string): Client {
	for (const client of connections) {
		if (!client.token) {
			continue;
		}
		if (client.token === token && client.room === roomName) {
			return client;
		}
	}
	throw new ClientNotFoundInRoomException(roomName);
}

function getClient(id: ClientId): Client | undefined {
	for (const client of connections) {
		if (client.id === id) {
			return client;
		}
	}
	return undefined;
}

function getClientsInRoom(roomName: string): Client[] {
	return roomJoins.get(roomName) ?? [];
}

setInterval(() => {
	for (const client of connections) {
		if (client instanceof DirectClient) {
			client.ping();
		}
	}
}, 10000);

/**
 * Accrue estimated relayed volume while voice is active. Accounting in the unit Cloudflare bills
 * on is what lets the budget act as a cost brake instead of a rough guess.
 */
const voiceUsageTickSeconds = Math.max(1, conf.get("voice.usage_tick_seconds"));
setInterval(() => {
	const counts = [...voiceParticipants.values()].map(participants => participants.size);
	void recordUsage(counts, voiceUsageTickSeconds);
}, voiceUsageTickSeconds * 1000);

export type ClientManagerCommand = CmdKick;

interface CmdBase {
	type: string;
}

export interface CmdKick extends CmdBase {
	type: "kick";
	clientId: ClientId;
}

// biome-ignore lint/correctness/noUnusedVariables: biome migration
const gaugeWebsocketConnections = new Gauge({
	name: "ott_websocket_connections",
	help: "The number of active websocket connections (deprecated)",
	collect() {
		this.set(connections.length);
	},
});

// biome-ignore lint/correctness/noUnusedVariables: biome migration
const gaugeClients = new Gauge({
	name: "ott_clients_connected",
	help: "The number of clients connected.",
	labelNames: ["clientType", "joinStatus"],
	collect() {
		this.reset();
		for (const client of connections) {
			const clientType = client instanceof DirectClient ? "direct" : "balancer.js";
			this.labels(clientType, ClientJoinStatus[client.joinStatus]).inc();
		}
	},
});

export default {
	setup,
	shutdown,
	onUserModified,
	getClientByToken,
	makeRoomRequest,
	addClient,
	getClient,
	getClientsInRoom,
};
