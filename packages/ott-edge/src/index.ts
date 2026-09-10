import { z } from "zod";
import { RoomRequestType as R } from "ott-common/models/messages.js";
import { QueueMode, Visibility } from "ott-common/models/types.js";
import { OttApiRequestRoomCreateSchema } from "ott-common/models/zod-schemas.js";
import { commandSchema, videoAdd, videoId } from "./commands";
import { resolveMedia } from "./media";
import { findRoom, idleMilliseconds, listItem, roomStub, type RoomRecord } from "./room-index";
import { checkOrigin, digest, grant, limit, requireSession } from "./session";
import { ApiError, errorResponse, json, readJson, type Env, type GuestSession } from "./types";

export { RoomObject } from "./room-object";

const TRAILING_SLASH = /\/$/;
const ROOM_ROUTE = /^\/api\/room\/([^/]+)(?:\/(queue|vote|undo))?$/;
const ACCOUNT_ROUTE = /^\/api\/(user\/(login|register|logout|recover|account)|auth\/discord)/;

const createSchema = OttApiRequestRoomCreateSchema.extend({
	description: z.string().max(2000).optional(),
	visibility: z.enum([Visibility.Public, Visibility.Unlisted]).optional(),
	queueMode: z.enum([QueueMode.Manual, QueueMode.Vote, QueueMode.Loop]).optional(),
	autoSkipSegmentCategories: z.array(z.never()).optional(),
});

async function createRoom(
	request: Request,
	env: Env,
	session: GuestSession,
	generated: boolean,
): Promise<Response> {
	const body = await readJson(request);
	const options: z.infer<typeof createSchema> = generated
		? {
				...z
					.object({ autoSkipSegmentCategories: z.array(z.never()).optional() })
					.parse(body),
				name: `room-${crypto.randomUUID().slice(0, 12)}`,
				isTemporary: true,
				visibility: Visibility.Unlisted,
			}
		: createSchema.parse(body);
	options.name = options.name.toLowerCase();
	// Validate the normalized spelling too, so reserved names cannot be bypassed with uppercase.
	createSchema.parse(options);
	await limit(env.DB, `create:${session.identity_id}`, 6);
	const instance = crypto.randomUUID();
	try {
		const inserted = await env.DB.prepare(`INSERT INTO rooms
			(name, instance_id, owner_id, title, description, visibility, is_temporary, queue_mode, expires_at, created_at)
			SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE (SELECT COUNT(*) FROM rooms WHERE owner_id = ?) < 20`)
			.bind(
				options.name,
				instance,
				session.identity_id,
				options.title || options.name,
				options.description ?? "",
				options.visibility ?? Visibility.Public,
				options.isTemporary ? 1 : 0,
				options.queueMode ?? QueueMode.Manual,
				options.isTemporary ? Date.now() + idleMilliseconds(env) : null,
				Date.now(),
				session.identity_id,
			)
			.run();
		if (!inserted.meta.changes) {
			throw new ApiError(429, "每个访客身份最多保留 20 个房间，请先删除不再使用的房间。");
		}
	} catch (error) {
		if (
			error instanceof Error &&
			error.message.includes("UNIQUE constraint failed: rooms.name")
		) {
			throw new ApiError(409, "这个房间名称已经被使用。", "RoomAlreadyExistsException");
		}
		throw error;
	}
	try {
		await roomStub(env, instance).initialize(
			{ ...options, visibility: options.visibility ?? Visibility.Public },
			session,
			instance,
		);
	} catch (error) {
		await env.DB.prepare("DELETE FROM rooms WHERE name = ? AND instance_id = ?")
			.bind(options.name, instance)
			.run();
		throw error;
	}
	return json({ success: true, room: options.name }, 201);
}

function rejectedSocket(code: number, reason: string): Response {
	const pair = new WebSocketPair();
	pair[1].accept();
	pair[1].close(code, reason);
	return new Response(null, { status: 101, webSocket: pair[0] });
}

async function roomRequest(
	request: Request,
	env: Env,
	name: string,
	action?: string,
): Promise<Response> {
	const websocket = request.headers.get("Upgrade")?.toLowerCase() === "websocket";
	let row: RoomRecord;
	try {
		row = await findRoom(env, name);
	} catch (error) {
		if (websocket && error instanceof ApiError && error.status === 404) {
			return rejectedSocket(4002, "Room not found");
		}
		throw error;
	}
	const room = roomStub(env, row.instance_id);
	if (websocket) {
		if (action || request.method !== "GET") {
			throw new ApiError(400, "无效的房间连接地址。");
		}
		const ip = request.headers.get("CF-Connecting-IP") ?? "local-development";
		await limit(env.DB, `connect:${await digest(ip)}`, 60);
		return room.fetch(request);
	}
	const session = await requireSession(request, env);
	if (!action && request.method === "GET") {
		return room.inspect();
	}
	if (!action && request.method === "DELETE") {
		return room.remove(session);
	}
	await limit(env.DB, `room-command:${session.identity_id}`, 120);
	const body = await readJson(request);
	let command: unknown;
	if (!action && request.method === "PATCH") {
		if (body && typeof body === "object" && "claim" in body) {
			throw new ApiError(400, "创建者已自动获得房主身份，无需认领。");
		}
		command = { type: R.ApplySettingsRequest, settings: body };
	} else if (action === "queue" && request.method === "POST") {
		const input = z
			.union([
				z.object({ videos: z.array(videoAdd).min(1).max(10) }),
				z.object({ url: z.string().max(4096) }),
				videoAdd,
			])
			.parse(body);
		command =
			"service" in input
				? { type: R.AddRequest, video: input }
				: { type: R.AddRequest, ...input };
	} else if (action === "queue" && request.method === "DELETE") {
		command = { type: R.RemoveRequest, video: videoId.parse(body) };
	} else if (action === "queue" && request.method === "PATCH") {
		const input = z
			.union([
				videoAdd,
				z.object({ video: videoId, update: videoAdd.omit({ service: true, id: true }) }),
			])
			.parse(body);
		command =
			"video" in input
				? { type: R.UpdateQueueItemRequest, ...input }
				: {
						type: R.UpdateQueueItemRequest,
						video: { service: input.service, id: input.id },
						update: {
							subtitleUrl: input.subtitleUrl,
							startAt: input.startAt,
							endAt: input.endAt,
						},
					};
	} else if (action === "vote" && ["POST", "DELETE"].includes(request.method)) {
		command = {
			type: R.VoteRequest,
			video: videoId.parse(body),
			add: request.method === "POST",
		};
	} else if (action === "undo") {
		throw new ApiError(400, "此预览版暂不支持撤销操作。");
	} else {
		throw new ApiError(404, "接口不存在。");
	}
	return room.command(commandSchema.parse(command), session);
}

async function api(request: Request, env: Env): Promise<Response> {
	checkOrigin(request);
	const url = new URL(request.url);
	const path = url.pathname.replace(TRAILING_SLASH, "");
	if (path === "/api/status" && request.method === "GET") {
		await env.DB.prepare("SELECT 1").first();
		return json({ status: "ok", backend: "cloudflare", instance: env.OTT_INSTANCE_ID });
	}
	if (path === "/api/status/version" && request.method === "GET") {
		return json({ revision: env.OTT_CLIENT_REVISION });
	}
	if (path === "/api/auth/grant" && request.method === "GET") {
		return grant(request, env);
	}
	const match = ROOM_ROUTE.exec(path);
	if (match && !["generate", "create", "list"].includes(match[1])) {
		return roomRequest(request, env, match[1], match[2]);
	}
	const session = await requireSession(request, env);
	if (path === "/api/user" && request.method === "GET") {
		return json({ loggedIn: false, username: session.username, discordLinked: false });
	}
	if (path === "/api/user" && request.method === "POST") {
		await limit(env.DB, `rename:${session.identity_id}`, 10);
		const { username } = z
			.object({
				username: z
					.string()
					.trim()
					.min(1)
					.max(48)
					.refine(value =>
						[...value].every(
							char => char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127,
						),
					),
			})
			.parse(await readJson(request));
		await env.DB.prepare("UPDATE sessions SET username = ? WHERE token_hash = ?")
			.bind(username, session.token_hash)
			.run();
		return json({ success: true });
	}
	if (
		(path === "/api/room/list" || path === "/api/user/owned-rooms") &&
		request.method === "GET"
	) {
		const owned = path === "/api/user/owned-rooms";
		const rows =
			await env.DB.prepare(`SELECT * FROM rooms WHERE ${owned ? "owner_id = ?" : "visibility = ?"}
			AND (expires_at IS NULL OR expires_at > ?) ORDER BY user_count DESC, name ASC LIMIT 200`)
				.bind(owned ? session.identity_id : Visibility.Public, Date.now())
				.all<RoomRecord>();
		const list = rows.results.map(listItem);
		return json(owned ? { success: true, data: list } : list);
	}
	if (["/api/room/generate", "/api/room/create"].includes(path) && request.method === "POST") {
		return createRoom(request, env, session, path.endsWith("generate"));
	}
	if (path === "/api/data/previewAdd" && request.method === "GET") {
		await limit(env.DB, `media:${session.identity_id}`, 20);
		const input = z.string().min(1).max(4096).parse(url.searchParams.get("input"));
		return json({ success: true, result: [await resolveMedia(env, input.trim())] });
	}
	if (ACCOUNT_ROUTE.test(path)) {
		throw new ApiError(
			501,
			"此预览版使用当前浏览器的访客身份，暂不支持账号登录。",
			"FeatureDisabledException",
		);
	}
	throw new ApiError(404, "接口不存在。");
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		try {
			if (new URL(request.url).pathname.startsWith("/api/")) {
				return await api(request, env);
			}
			return await env.ASSETS.fetch(request);
		} catch (error) {
			return errorResponse(error);
		}
	},
	async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
		const now = Date.now();
		await env.DB.batch([
			env.DB.prepare("DELETE FROM sessions WHERE expires_at <= ?").bind(now),
			env.DB.prepare("DELETE FROM media_cache WHERE expires_at <= ?").bind(now),
			env.DB.prepare("DELETE FROM rate_limits WHERE expires_at <= ?").bind(now),
		]);
		const expired = await env.DB.prepare(
			"SELECT instance_id FROM rooms WHERE expires_at <= ? LIMIT 100",
		)
			.bind(now)
			.all<{ instance_id: string }>();
		for (const row of expired.results) {
			await roomStub(env, row.instance_id).expire();
		}
	},
} satisfies ExportedHandler<Env>;
