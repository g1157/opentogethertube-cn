import { DurableObject } from "cloudflare:workers";
import { z } from "zod";
import { RoomRequestType as R, type ServerMessage } from "ott-common/models/messages.js";
import { PlayerStatus } from "ott-common/models/types.js";
import type { QueueItem, VideoAdd } from "ott-common/models/video.js";
import { commandSchema, type Command } from "./commands";
import { applyExtras, Probe, resolveAdd, resolveMedia } from "./media";
import { idleMilliseconds, indexValues } from "./room-index";
import { createSnapshot, RoomState, sameVideo, type Member, type Snapshot } from "./room-state";
import { digest, findSession } from "./session";
import { ApiError, errorResponse, json, type Env, type GuestSession } from "./types";

interface Attachment {
	id: string;
	session: GuestSession | null;
	status: PlayerStatus;
	authDeadline: number;
	window: number;
	count: number;
	closed?: boolean;
}
interface StoredRoom {
	instance: string;
	snapshot: Snapshot;
}

const messageSchema = z.discriminatedUnion("action", [
	z.object({ action: z.literal("auth"), token: z.string().regex(/^[a-f0-9]{64}$/) }),
	z.object({
		action: z.literal("status"),
		status: z.nativeEnum(PlayerStatus),
		playbackPrepared: z
			.object({ id: z.string().max(64), position: z.number().finite().min(0) })
			.optional(),
	}),
	z.object({ action: z.literal("req"), request: commandSchema }),
	z.object({ action: z.literal("notify"), message: z.literal("usernameChanged") }),
	z.object({ action: z.literal("kickme"), reason: z.number().int().optional() }),
]);

/** One room per object; accepted sockets and attachments survive Worker hibernation. */
export class RoomObject extends DurableObject<Env> {
	private room: RoomState | null = null;
	private instance = "";
	private saved = "";
	private indexed = "";
	private indexRetryAt: number | null = null;
	private pending: Promise<unknown> = Promise.resolve();

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
		ctx.blockConcurrencyWhile(async () => {
			const record = await ctx.storage.get<StoredRoom>("room");
			if (!record) {
				return;
			}
			this.instance = record.instance;
			this.saved = JSON.stringify(record.snapshot);
			this.room = new RoomState(record.snapshot);
			for (const socket of ctx.getWebSockets()) {
				const attachment = this.attachment(socket);
				if (attachment && !attachment.closed && attachment.session) {
					this.room.members.set(attachment.id, {
						id: attachment.id,
						session: attachment.session,
						status: attachment.status,
					});
				}
			}
			this.room.recover();
		});
	}

	private serial<T>(operation: () => Promise<T>): Promise<T> {
		const result = this.pending.then(operation);
		this.pending = result.catch(() => undefined);
		return result;
	}

	private attachment(socket: WebSocket): Attachment | null {
		return socket.deserializeAttachment() as Attachment | null;
	}

	private sockets(): [WebSocket, Attachment][] {
		const sockets: [WebSocket, Attachment][] = [];
		for (const socket of this.ctx.getWebSockets()) {
			const attachment = this.attachment(socket);
			if (attachment && !attachment.closed) {
				sockets.push([socket, attachment]);
			}
		}
		return sockets;
	}

	private close(socket: WebSocket, code: number, reason: string): void {
		const attachment = this.attachment(socket);
		if (attachment) {
			attachment.closed = true;
			socket.serializeAttachment(attachment);
			this.room?.leave(attachment.id);
		}
		try {
			socket.close(code, reason);
		} catch {
			/* The close event also removes disconnected members. */
		}
	}

	private send(socket: WebSocket, message: ServerMessage): void {
		try {
			socket.send(JSON.stringify(message));
		} catch {
			this.close(socket, 1011, "Connection lost");
		}
	}

	private expired(): boolean {
		const s = this.room?.snapshot;
		return Boolean(
			s?.isTemporary &&
				s.emptySince !== null &&
				s.emptySince + idleMilliseconds(this.env) <= Date.now(),
		);
	}

	private async live(): Promise<RoomState> {
		if (this.expired()) {
			await this.erase();
		}
		if (!this.room) {
			throw new ApiError(404, "房间不存在或已过期。", "RoomNotFoundException");
		}
		return this.room;
	}

	async initialize(
		options: Parameters<typeof createSnapshot>[0],
		owner: GuestSession,
		instance: string,
	): Promise<void> {
		return this.serial(async () => {
			if (this.room) {
				throw new ApiError(409, "房间已存在。");
			}
			this.instance = instance;
			this.room = new RoomState(createSnapshot(options, owner));
			await this.commit();
		});
	}

	async inspect(): Promise<Response> {
		return this.serial(async () => {
			try {
				const room = await this.live();
				room.tick();
				await this.commit();
				const sync = room.fullSync();
				return json({
					name: sync.name,
					title: sync.title,
					description: sync.description,
					isTemporary: sync.isTemporary,
					visibility: sync.visibility,
					queueMode: sync.queueMode,
					queue: sync.queue,
					hasOwner: sync.hasOwner,
					grants: sync.grants,
					autoSkipSegmentCategories: sync.autoSkipSegmentCategories,
					restoreQueueBehavior: sync.restoreQueueBehavior,
					enableVoteSkip: sync.enableVoteSkip,
					users: room.users,
				});
			} catch (error) {
				return errorResponse(error);
			}
		});
	}

	async remove(session: GuestSession): Promise<Response> {
		return this.serial(async () => {
			try {
				const room = await this.live();
				if (room.snapshot.ownerId !== session.identity_id) {
					throw new ApiError(
						403,
						"只有房主可以删除这个房间。",
						"PermissionDeniedException",
					);
				}
				await this.erase();
				return json({ success: true });
			} catch (error) {
				return errorResponse(error);
			}
		});
	}

	async expire(): Promise<boolean> {
		return this.serial(async () => {
			if (!this.room) {
				return true;
			}
			if (this.expired()) {
				await this.erase();
				return true;
			}
			await this.commit();
			return false;
		});
	}

	private async erase(): Promise<void> {
		if (!this.room) {
			return;
		}
		await this.env.DB.prepare("DELETE FROM rooms WHERE name = ? AND instance_id = ?")
			.bind(this.room.snapshot.name, this.instance)
			.run();
		for (const [socket] of this.sockets()) {
			this.close(socket, 4003, "Room unloaded");
		}
		await this.ctx.storage.deleteAlarm();
		await this.ctx.storage.deleteAll();
		this.room = null;
		this.saved = "";
		this.indexed = "";
	}

	private member(session: GuestSession): Member {
		return (
			[...(this.room?.members.values() ?? [])].find(
				member => member.session.token_hash === session.token_hash,
			) ?? { id: `http:${session.identity_id}`, session, status: PlayerStatus.none }
		);
	}

	private async resolve(command: Command): Promise<QueueItem[]> {
		const probe = new Probe();
		const known = [
			...(this.room?.snapshot.queue ?? []),
			this.room?.snapshot.currentSource ?? null,
		];
		const resolve = (video: VideoAdd) => {
			const existing = known.find(candidate => sameVideo(candidate, video));
			return existing
				? Promise.resolve(applyExtras(existing, video))
				: resolveAdd(this.env, video, probe);
		};
		if (command.type === R.AddRequest) {
			if (
				[command.url, command.video, command.videos].filter(value => value !== undefined)
					.length !== 1
			) {
				throw new ApiError(400, "每次添加请提供一种视频参数。");
			}
			if (command.url) {
				return [await resolveMedia(this.env, command.url)];
			}
			const result: QueueItem[] = [];
			for (const video of command.videos ?? (command.video ? [command.video] : [])) {
				result.push(await resolve(video));
			}
			return result;
		}
		if (command.type === R.PlayNowRequest) {
			return [await resolve(command.video)];
		}
		if (command.type === R.UpdateQueueItemRequest) {
			const existing = this.room?.snapshot.queue.find(video =>
				sameVideo(video, command.video),
			);
			if (!existing) {
				throw new ApiError(404, "待播队列中没有该视频。");
			}
			return [applyExtras(existing, { ...existing, ...command.update })];
		}
		return [];
	}

	async command(input: unknown, session: GuestSession): Promise<Response> {
		try {
			const command = commandSchema.parse(input);
			await this.serial(async () => {
				const room = await this.live();
				room.checkCommand(command, this.member(session));
			});
			// External metadata I/O must not block pause/seek or another viewer's departure.
			const resolved = await this.resolve(command);
			return await this.serial(async () => {
				const room = await this.live();
				const member = this.member(session);
				if (command.type === R.VoteRequest && !room.members.has(member.id)) {
					throw new ApiError(403, "请先进入房间再投票。");
				}
				room.tick();
				room.apply(command, member, resolved);
				await this.commit();
				return json({ success: true });
			});
		} catch (error) {
			return errorResponse(error);
		}
	}

	async fetch(request: Request): Promise<Response> {
		return this.serial(async () => {
			try {
				await this.live();
				if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
					throw new ApiError(426, "需要 WebSocket 连接。");
				}
				const sockets = this.sockets();
				if (
					sockets.length >= 100 ||
					sockets.filter(([, peer]) => !peer.session).length >= 16
				) {
					throw new ApiError(429, "房间连接较多，请稍后再试。");
				}
				const pair = new WebSocketPair();
				const attachment: Attachment = {
					id: crypto.randomUUID(),
					session: null,
					status: PlayerStatus.none,
					authDeadline: Date.now() + 10_000,
					window: Date.now(),
					count: 0,
				};
				this.ctx.acceptWebSocket(pair[1]);
				pair[1].serializeAttachment(attachment);
				await this.commit();
				return new Response(null, { status: 101, webSocket: pair[0] });
			} catch (error) {
				if (error instanceof ApiError && error.status === 404) {
					const pair = new WebSocketPair();
					pair[1].accept();
					pair[1].close(4002, "Room not found");
					return new Response(null, { status: 101, webSocket: pair[0] });
				}
				return errorResponse(error);
			}
		});
	}

	private async authenticate(
		socket: WebSocket,
		attachment: Attachment,
		token: string,
	): Promise<void> {
		if (attachment.session) {
			if (attachment.session.token_hash !== (await digest(token))) {
				throw new ApiError(403, "连接建立后不能切换身份。");
			}
			return;
		}
		const session = await findSession(this.env.DB, token);
		if (!session || attachment.authDeadline <= Date.now()) {
			this.close(socket, 4004, "Missing valid token");
			await this.commit();
			return;
		}
		const room = await this.live();
		if (
			[...room.members.values()].filter(
				member => member.session.identity_id === session.identity_id,
			).length >= 4
		) {
			this.close(socket, 4000, "Too many connections for this identity");
			await this.commit();
			return;
		}
		attachment.session = session;
		socket.serializeAttachment(attachment);
		room.tick();
		room.join({ id: attachment.id, session, status: attachment.status });
		await this.commit(false, socket);
	}

	private async refreshSession(socket: WebSocket, attachment: Attachment): Promise<boolean> {
		if (!attachment.session) {
			return false;
		}
		const session = await this.env.DB.prepare(
			"SELECT token_hash, identity_id, username, expires_at FROM sessions WHERE token_hash = ? AND expires_at > ?",
		)
			.bind(attachment.session.token_hash, Date.now())
			.first<GuestSession>();
		if (!session) {
			this.close(socket, 4004, "Session expired");
			return false;
		}
		attachment.session = session;
		socket.serializeAttachment(attachment);
		const member = this.room?.members.get(attachment.id);
		if (member) {
			member.session = session;
		}
		return true;
	}

	async webSocketMessage(socket: WebSocket, raw: string | ArrayBuffer): Promise<void> {
		try {
			const intent = await this.serial(async () => {
				const room = await this.live();
				const attachment = this.attachment(socket);
				if (!attachment || attachment.closed) {
					return;
				}
				if (
					typeof raw !== "string" ||
					new TextEncoder().encode(raw).byteLength > 64 * 1024
				) {
					this.close(socket, 1009, "Message too large or not text");
					await this.commit();
					return;
				}
				if (Date.now() - attachment.window >= 60_000) {
					attachment.window = Date.now();
					attachment.count = 0;
				}
				attachment.count++;
				socket.serializeAttachment(attachment);
				if (attachment.count > 120) {
					this.close(socket, 1008, "Message rate exceeded");
					await this.commit();
					return;
				}
				let input: unknown;
				try {
					input = JSON.parse(raw);
				} catch {
					throw new ApiError(400, "消息需要有效的 JSON。");
				}
				const message = messageSchema.parse(input);
				if (message.action === "auth") {
					await this.authenticate(socket, attachment, message.token);
					return;
				}
				if (
					!attachment.session ||
					(attachment.session.expires_at <= Date.now() &&
						!(await this.refreshSession(socket, attachment)))
				) {
					this.close(socket, 4004, "Authenticate first");
					await this.commit();
					return;
				}
				const member = room.members.get(attachment.id);
				if (!member) {
					return;
				}
				if (message.action === "req") {
					room.checkCommand(message.request, member);
					return { command: message.request, id: member.id };
				}
				if (message.action === "kickme") {
					this.close(socket, 1000, "Left room");
				}
				if (message.action === "status") {
					attachment.status = message.status;
					socket.serializeAttachment(attachment);
					room.status(member, message.status, message.playbackPrepared);
				}
				if (message.action === "notify") {
					if (await this.refreshSession(socket, attachment)) {
						for (const [peer, details] of this.sockets()) {
							if (details.session?.identity_id !== member.session.identity_id) {
								continue;
							}
							details.session = member.session;
							peer.serializeAttachment(details);
							const user = room.members.get(details.id);
							if (user) {
								user.session = member.session;
								room.messages.push({
									action: "user",
									update: { kind: "update", value: room.info(user) },
								});
							}
						}
					}
				}
				await this.commit();
			});
			if (intent) {
				const resolved = await this.resolve(intent.command);
				await this.serial(async () => {
					const room = await this.live();
					const member = room.members.get(intent.id);
					if (!member || this.attachment(socket)?.closed) {
						return;
					}
					room.tick();
					room.apply(intent.command, member, resolved);
					await this.commit();
				});
			}
		} catch (error) {
			const response = await errorResponse(error).json<{ error: { message: string } }>();
			this.send(socket, {
				action: "eventcustom",
				text: response.error.message,
				duration: 5000,
			});
		}
	}

	async webSocketClose(socket: WebSocket): Promise<void> {
		await this.serial(async () => {
			this.close(socket, 1000, "Closed");
			await this.commit();
		});
	}

	async webSocketError(socket: WebSocket): Promise<void> {
		await this.webSocketClose(socket);
	}

	private async commit(checkpoint = false, joined?: WebSocket): Promise<void> {
		const room = this.room;
		if (!room) {
			return;
		}
		if (checkpoint || JSON.stringify(room.snapshot) !== this.saved) {
			const snapshot = room.persisted();
			await this.ctx.storage.put("room", {
				instance: this.instance,
				snapshot,
			} satisfies StoredRoom);
			this.saved = JSON.stringify(snapshot);
		}
		const values = indexValues(room.snapshot, room.members.size, idleMilliseconds(this.env));
		if (JSON.stringify(values) !== this.indexed) {
			try {
				await this.env.DB.prepare(`UPDATE rooms SET title = ?, description = ?, visibility = ?, queue_mode = ?,
					current_source = ?, user_count = ?, expires_at = ? WHERE name = ? AND instance_id = ?`)
					.bind(...values, room.snapshot.name, this.instance)
					.run();
				this.indexed = JSON.stringify(values);
				this.indexRetryAt = null;
			} catch {
				// The object owns playback; retry its searchable D1 projection independently.
				this.indexRetryAt = Date.now() + 10_000;
			}
		}
		if (joined) {
			const attachment = this.attachment(joined)!;
			this.send(joined, { action: "you", info: { id: attachment.id } });
			this.send(joined, { action: "user", update: { kind: "init", value: room.users } });
			this.send(joined, room.fullSync());
		}
		const { messages, kicks } = room.drain();
		for (const [socket, attachment] of this.sockets()) {
			if (kicks.includes(attachment.id)) {
				this.close(socket, 4005, "Kicked from room");
				continue;
			}
			if (socket === joined || !attachment.session || !room.members.has(attachment.id)) {
				continue;
			}
			for (const message of messages) {
				this.send(socket, message);
			}
		}
		// Failed sends may have removed the last viewer. Persist that pause as well.
		if (JSON.stringify(room.snapshot) !== this.saved) {
			await this.commit();
			return;
		}
		const times = [room.nextAlarm(idleMilliseconds(this.env)), this.indexRetryAt];
		for (const [, attachment] of this.sockets()) {
			times.push(attachment.session?.expires_at ?? attachment.authDeadline);
		}
		const scheduled = times.filter((value): value is number => value !== null);
		if (scheduled.length) {
			const alarm = Math.max(Date.now() + 1, Math.min(...scheduled));
			if ((await this.ctx.storage.getAlarm()) !== alarm) {
				await this.ctx.storage.setAlarm(alarm);
			}
		} else {
			await this.ctx.storage.deleteAlarm();
		}
	}

	async alarm(): Promise<void> {
		await this.serial(async () => {
			if (!this.room) {
				return;
			}
			for (const [socket, attachment] of this.sockets()) {
				if (!attachment.session && attachment.authDeadline <= Date.now()) {
					this.close(socket, 4004, "Authentication timed out");
				} else if (attachment.session && attachment.session.expires_at <= Date.now()) {
					await this.refreshSession(socket, attachment);
				}
			}
			if (this.expired()) {
				await this.erase();
				return;
			}
			this.room.tick();
			await this.commit(true);
		});
	}
}
