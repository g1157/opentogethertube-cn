import { Room as DbRoomModel, User as UserModel } from "../models/index.js";
import type { Room as DbRoom, RoomAttributes } from "../models/room.js";
import { Role, Visibility, type RoomOptions } from "ott-common/models/types.js";
import type { RoomListItem } from "ott-common/models/rest-api.js";
import { getLogger } from "../logger.js";
import Sequelize from "sequelize";
import permissions from "ott-common/permissions.js";
import type { RoomStatePersistable } from "../room.js";
import _ from "lodash";
import { deleteAllNotes } from "./roomnote.js";

const log = getLogger("storage/room");

export const ROOM_LIST_DEFAULT_LIMIT = 200;
export const ROOM_LIST_MAX_LIMIT = 200;
const ROOM_LIST_CACHE_TTL = 5000;
const ROOM_LIST_CACHE_MAX_ENTRIES = 128;

type RoomListCache = {
	generation: number;
	entries: Map<string, { expiresAt: number; rooms: RoomListItem[] }>;
};
const roomListCaches = new WeakMap<Sequelize.Sequelize, RoomListCache>();

export function normalizeRoomListPagination(limit = ROOM_LIST_DEFAULT_LIMIT, offset = 0) {
	return {
		limit: Number.isFinite(limit)
			? Math.min(ROOM_LIST_MAX_LIMIT, Math.max(1, Math.floor(limit)))
			: ROOM_LIST_DEFAULT_LIMIT,
		offset: Number.isFinite(offset)
			? Math.min(
					Number.MAX_SAFE_INTEGER - ROOM_LIST_MAX_LIMIT,
					Math.max(0, Math.floor(offset)),
			  )
			: 0,
	};
}

function getRoomListCache(): RoomListCache {
	const connection = DbRoomModel.sequelize!;
	let cache = roomListCaches.get(connection);
	if (!cache) {
		cache = { generation: 0, entries: new Map() };
		roomListCaches.set(connection, cache);
		const invalidate = () => {
			cache!.generation++;
			cache!.entries.clear();
		};
		// Invalidate even for writes made outside this storage module (password/visibility changes).
		for (const hook of [
			"afterSave",
			"afterDestroy",
			"afterBulkCreate",
			"afterBulkUpdate",
			"afterBulkDestroy",
		] as const) {
			DbRoomModel.addHook(hook, "invalidateRoomList", invalidate);
		}
	}
	return cache;
}

/** List saved rooms without loading them or making unlisted rooms public. */
export async function getPermanentRoomList(
	includeUnlisted = false,
	limit = ROOM_LIST_DEFAULT_LIMIT,
	offset = 0,
): Promise<RoomListItem[]> {
	({ limit, offset } = normalizeRoomListPagination(limit, offset));
	const cache = getRoomListCache();
	const key = `${!!includeUnlisted}:${limit}:${offset}`;
	const now = Date.now();
	const cached = cache.entries.get(key);
	if (cached && cached.expiresAt > now) {
		// Callers merge live rooms into this array; never let them mutate the cache.
		return structuredClone(cached.rooms);
	}
	for (const [key, entry] of cache.entries) {
		if (entry.expiresAt <= now) cache.entries.delete(key);
	}
	const generation = cache.generation;
	const dialect = DbRoomModel.sequelize!.getDialect();
	const firstSource =
		dialect === "postgres"
			? Sequelize.literal('"prevQueue"->0')
			: dialect === "sqlite" || dialect === "mysql" || dialect === "mariadb"
			? Sequelize.fn("json_extract", Sequelize.col("prevQueue"), Sequelize.literal("'$[0]'"))
			: null;
	// Room names are ASCII. Match the API's case-sensitive name ordering even on
	// PostgreSQL/MySQL installations whose default collation ignores case/punctuation.
	const nameOrder =
		dialect === "postgres"
			? Sequelize.literal('"name" COLLATE "C"')
			: dialect === "mysql" || dialect === "mariadb"
			? Sequelize.literal("BINARY `name`")
			: "name";
	const rooms = await DbRoomModel.findAll({
		where: includeUnlisted ? {} : { visibility: Visibility.Public },
		attributes: [
			"name",
			"title",
			"description",
			"visibility",
			"queueMode",
			firstSource ? [firstSource, "listCurrentSource"] : "prevQueue",
			"passwordHash",
		],
		order: [
			[nameOrder, "ASC"],
			["id", "ASC"],
		],
		limit,
		offset,
	});
	const result = rooms.map(room => {
		const source = firstSource ? room.get("listCurrentSource") : room.prevQueue?.[0];
		return {
			name: room.name,
			title: room.title,
			description: room.description,
			visibility: room.visibility,
			queueMode: room.queueMode,
			isTemporary: false,
			// SQLite returns JSON text for an extracted object; PostgreSQL returns an object.
			currentSource: (typeof source === "string" ? JSON.parse(source) : source) ?? null,
			users: 0,
			// Only the boolean leaves storage; the hash itself stays in the row.
			hasPassword: !!room.passwordHash,
		} satisfies RoomListItem;
	});
	// A write racing this read must not resurrect a stale public/privileged entry.
	if (cache.generation === generation) {
		if (cache.entries.size >= ROOM_LIST_CACHE_MAX_ENTRIES) {
			cache.entries.delete(cache.entries.keys().next().value);
		}
		cache.entries.set(key, { expiresAt: Date.now() + ROOM_LIST_CACHE_TTL, rooms: result });
	}
	return structuredClone(result);
}

function buildFindRoomWhere(roomName: string) {
	return Sequelize.and(
		Sequelize.where(
			Sequelize.fn("lower", Sequelize.col("name")),
			Sequelize.fn("lower", roomName),
		),
	);
}

export async function getRoomByName(roomName: string): Promise<RoomOptions | null> {
	try {
		const dbroom = await DbRoomModel.findOne({
			where: buildFindRoomWhere(roomName),
			include: {
				model: UserModel,
				as: "owner",
				// Room state only needs the owner's identity; never pull password
				// material into memory where it can leak into snapshots or logs.
				attributes: { exclude: ["salt", "hash"] },
			},
		});
		if (!dbroom) {
			log.debug(`Room ${roomName} does not exist in db.`);
			return null;
		}
		return dbToRoomArgs(dbroom);
	} catch (err) {
		log.error(`Failed to get room by name: ${err} ${err.stack}`);
	}
	return null;
}

export async function isRoomNameTaken(roomName: string): Promise<boolean> {
	try {
		const room = await DbRoomModel.findOne({
			where: buildFindRoomWhere(roomName),
		});
		return !!room;
	} catch (err) {
		log.error(`${err} ${err.stack}`);
		throw err;
	}
}

/**
 * Create a room in the database, if it doesn't already exist
 * @returns boolean indicating whether the room was saved successfully
 */
export async function saveRoom(room: RoomStatePersistable): Promise<boolean> {
	const options = roomToDb(room);
	// HACK: search for the room to see if it exists
	if (await isRoomNameTaken(room.name)) {
		return false;
	}
	try {
		const room: DbRoom = await DbRoomModel.create(options);
		log.info(`Saved room ${room.name} to db: id ${room.dataValues.id}`);
		return true;
	} catch (err) {
		log.error(`Failed to save room ${room.name} to storage: ${err}`);
		return false;
	}
}

/**
 *Create a room in the database, if it doesn't already exist
 * @returns boolean indicating whether the room was saved successfully
 */
export async function updateRoom(room: Partial<RoomStatePersistable>): Promise<boolean> {
	if (!room.name) {
		throw new Error(`Cannot update room with no name`);
	}
	try {
		const options = roomToDbPartial(room);
		// Sequelize reports zero affected rows for an empty update, even if the room exists.
		if (_.isEmpty(options)) {
			return await isRoomNameTaken(room.name);
		}
		log.debug(`updating room ${room.name} in database ${JSON.stringify(options)}`);
		const result = await DbRoomModel.update(options, {
			where: buildFindRoomWhere(room.name),
		});
		return result[0] > 0;
	} catch (error) {
		log.error(`Failed to update room ${room.name} in storage: ${error}`);
		return false;
	}
}

export async function deleteRoom(roomName: string): Promise<boolean> {
	try {
		const deleted = await DbRoomModel.destroy({
			where: buildFindRoomWhere(roomName),
		});
		if (deleted === 0) {
			log.debug(`Room ${roomName} not found in db to delete.`);
		} else {
			log.info(`Deleted room ${roomName} from db: ${deleted} row(s)`);
		}
		// Notes are keyed by room name without a foreign key, so clean them up explicitly.
		await deleteAllNotes(roomName);
		return deleted > 0;
	} catch (err) {
		log.error(`Failed to delete room ${roomName} from storage: ${err}`);
		throw err;
	}
}

function dbToRoomArgs(db: DbRoom): RoomOptions {
	const room = {
		name: db.name,
		title: db.title,
		description: db.description,
		isTemporary: false,
		visibility: db.visibility,
		queueMode: db.queueMode,
		owner: db.owner,
		grants: new permissions.Grants(db.permissions),
		userRoles: new Map<Role, Set<number>>(),
		autoSkipSegmentCategories: db.autoSkipSegmentCategories,
		prevQueue: db.prevQueue,
		restoreQueueBehavior: db.restoreQueueBehavior,
		enableVoteSkip: db.enableVoteSkip,
		bufferGateMode: db.bufferGateMode,
		danmakuSource: db.danmakuSource,
		passwordHash: db.passwordHash,
		// A row saved before the revision column existed carries null: treat it like the
		// old snapshots (revision 0) so the additions are applied exactly once.
		permissionsRevision: db.permissionsRevision ?? undefined,
	};
	for (let i = Role.TrustedUser; i <= 4; i++) {
		room.userRoles.set(i, new Set(db[`role-${permissions.ROLE_NAMES[i]}`]));
	}
	return room;
}

export async function getRoomPasswordHash(roomName: string): Promise<string | null> {
	try {
		const room = await DbRoomModel.findOne({
			where: buildFindRoomWhere(roomName),
			attributes: ["passwordHash"],
		});
		return room?.passwordHash ?? null;
	} catch (err) {
		// Fail closed: a lookup error must not load a locked room as if it had no password.
		// The room simply fails to load until the database answers again.
		log.error(`Failed to read the password hash for room ${roomName}: ${err}`);
		throw err;
	}
}

export async function updateRoomPassword(
	roomName: string,
	passwordHash: string | null,
): Promise<boolean> {
	try {
		const [updated] = await DbRoomModel.update(
			{ passwordHash },
			{ where: buildFindRoomWhere(roomName) },
		);
		return updated > 0;
	} catch (err) {
		log.error(`Failed to update the password for room ${roomName}: ${err}`);
		return false;
	}
}

/**
 * Converts a room into an object that can be stored in the database
 */
export function roomToDb(room: RoomStatePersistable): Omit<RoomAttributes, "id"> {
	const grantsFiltered = _.cloneDeep(room.grants);
	// No need to waste storage space on these
	grantsFiltered.deleteRole(Role.Administrator);
	grantsFiltered.deleteRole(Role.Owner);

	const db: Omit<RoomAttributes, "id"> = {
		name: room.name,
		title: room.title,
		description: room.description,
		visibility: room.visibility,
		queueMode: room.queueMode,
		autoSkipSegmentCategories: room.autoSkipSegmentCategories,
		permissions: grantsFiltered.toJSON(),
		ownerId: null,
		"role-trusted": [],
		"role-mod": [],
		"role-admin": [],
		prevQueue: room.prevQueue,
		restoreQueueBehavior: room.restoreQueueBehavior,
		enableVoteSkip: room.enableVoteSkip,
		bufferGateMode: room.bufferGateMode,
		danmakuSource: room.danmakuSource ?? null,
		permissionsRevision: room.permissionsRevision ?? null,
	};
	if (room.owner) {
		db.ownerId = room.owner.id;
	}
	if (room.userRoles) {
		for (let i = Role.TrustedUser; i <= 4; i++) {
			db[`role-${permissions.ROLE_NAMES[i]}`] = Array.from(
				room.userRoles.get(i)?.values() ?? [],
			);
		}
	}
	return db;
}

/**
 * Converts a room into an object that can be stored in the database
 */
export function roomToDbPartial(
	room: Partial<RoomStatePersistable>,
): Partial<Omit<RoomAttributes, "id" | "name">> {
	const db: Partial<Omit<RoomAttributes, "id" | "name">> = _.pickBy(
		{
			title: room.title,
			description: room.description,
			visibility: room.visibility,
			queueMode: room.queueMode,
			autoSkipSegmentCategories: room.autoSkipSegmentCategories,
			restoreQueueBehavior: room.restoreQueueBehavior,
			enableVoteSkip: room.enableVoteSkip,
			bufferGateMode: room.bufferGateMode,
			danmakuSource: room.danmakuSource,
			permissionsRevision: room.permissionsRevision,
		},
		v => v !== undefined,
	);
	// room.prevQueue will become null if its length is 0, so we need to explicitly check for null here
	if (room.prevQueue || room.prevQueue === null) {
		db.prevQueue = room.prevQueue;
	}
	if (room.grants) {
		const grantsFiltered = _.cloneDeep(room.grants);
		// No need to waste storage space on these
		grantsFiltered.deleteRole(Role.Administrator);
		grantsFiltered.deleteRole(Role.Owner);
		db.permissions = grantsFiltered.toJSON();
	}
	if (room.owner) {
		db.ownerId = room.owner.id;
	}
	if (room.userRoles) {
		for (let i = Role.TrustedUser; i <= 4; i++) {
			db[`role-${permissions.ROLE_NAMES[i]}`] = Array.from(
				room.userRoles.get(i)?.values() ?? [],
			);
		}
	}
	return db;
}
