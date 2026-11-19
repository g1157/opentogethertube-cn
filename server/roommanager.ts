import { Room, type RoomState, type RoomStateFromRedis } from "./room.js";
import type { Role, RoomOptions, Visibility } from "ott-common/models/types.js";
import { Mutex, Semaphore } from "@divine/synchronization";
import _ from "lodash";
import { getLogger } from "./logger.js";
import { redisClient } from "./redisclient.js";
import storage from "./storage.js";
import {
	getTemporaryRoomPasswordHash,
	temporaryPasswordKey,
	setRoomPassword,
} from "./room-password.js";
import {
	type RoomAlreadyLoadedException,
	RoomNameTakenException,
	RoomNotFoundException,
} from "./exceptions.js";
import type { ServerMessage } from "ott-common/models/messages.js";
import { Counter, Gauge, Histogram } from "prom-client";
import { EventEmitter } from "node:events";
import { type Result, ok, err } from "ott-common/result.js";
import { Grants } from "ott-common/permissions.js";
import type { ClientManagerCommand } from "./clientmanager.js";
import { UnloadReason } from "./generated.js";

export const log = getLogger("roommanager");
export const rooms: Room[] = [];
const LOAD_EPOCH_KEY = "roommanager:load_epoch";
const roomOperations = new Map<string, { lock: Mutex; users: number }>();

/** Serialize admission by canonical name without retaining locks for arbitrary room names. */
async function withRoomOperation<T>(name: string, operation: () => Promise<T>): Promise<T> {
	const key = name.toLowerCase();
	let entry = roomOperations.get(key);
	if (!entry) {
		entry = { lock: new Mutex(), users: 0 };
		roomOperations.set(key, entry);
	}
	entry.users++;
	try {
		return await entry.lock.protect(operation);
	} finally {
		if (--entry.users === 0) {
			roomOperations.delete(key);
		}
	}
}

export type RoomManagerEvents = "publish" | "load" | "unload" | "command";
export type RoomManagerEventHandlers<E> = E extends "publish"
	? (roomName: string, message: ServerMessage) => void
	: E extends "load"
		? (roomName: string) => void
		: E extends "unload"
			? (roomName: string, reason: UnloadReason) => void
			: E extends "command"
				? (roomName: string, command: ClientManagerCommand) => void
				: never;
const bus = new EventEmitter();

async function addRoom(room: Room) {
	try {
		const epoch = await redisClient.incr(LOAD_EPOCH_KEY);
		room.loadEpoch = epoch;
		if (epoch >= 2147483640) {
			// ensure we don't overflow the integer
			await redisClient.set(LOAD_EPOCH_KEY, 0);
		}
	} catch (error) {
		room.throttledSync.cancel();
		room.saveStateToRedisDebounced.cancel();
		throw error;
	}
	rooms.push(room);
	bus.emit("load", room.name);
}

const MAX_CONCURRENT_ROOM_UPDATES = 8;
const roomUpdateSlots = new Semaphore(MAX_CONCURRENT_ROOM_UPDATES);
const roomUpdates = new Map<Room, Promise<void>>();
let updaterInterval: ReturnType<typeof setInterval> | null = null;

export async function start() {
	if (updaterInterval) {
		return;
	}
	log.info("Starting room manager");
	updaterInterval = setInterval(runUpdate, 1000);
}

/** Schedule one task per room without keeping a blocked global sweep alive. */
function runUpdate(): void {
	for (const room of [...rooms]) {
		if (roomUpdates.has(room)) {
			counterUpdateSkipped.inc();
			continue;
		}
		void scheduleRoomUpdate(room);
	}
}

export async function shutdown() {
	log.info("Shutting down room manager");
	if (updaterInterval) {
		clearInterval(updaterInterval);
		updaterInterval = null;
	}
	await Promise.all(
		rooms.map(room => unloadRoom(room.name, UnloadReason.Shutdown, { preserveRedis: true })),
	);
}

export function redisStateToState(state: RoomStateFromRedis): RoomState {
	const userRoles = new Map<Role, Set<number>>();
	for (const [role, userIds] of state.userRoles) {
		userRoles.set(role, new Set(userIds));
	}
	const grants = new Grants(state.grants);
	return {
		...state,
		grants,
		userRoles,
	};
}

export async function update(): Promise<void> {
	// Explicit callers can await their snapshot; periodic ticks never await all rooms.
	await Promise.all([...rooms].map(scheduleRoomUpdate));
}

function scheduleRoomUpdate(room: Room): Promise<void> {
	const pending = roomUpdates.get(room);
	if (pending) {
		return pending;
	}
	// The queue contains at most one task per loaded Room object, not one per interval.
	const task = (async () => {
		try {
			await roomUpdateSlots.protect(async () => {
				if (!rooms.includes(room)) {
					return;
				}
				const endTimer = histUpdateDuration.startTimer();
				try {
					await updateRoom(room);
				} finally {
					endTimer();
				}
			});
		} finally {
			roomUpdates.delete(room);
		}
	})();
	roomUpdates.set(room, task);
	return task;
}

async function updateRoom(room: Room): Promise<void> {
	try {
		await room.update();
		if (!rooms.includes(room)) {
			return;
		}
		await room.sync();
	} catch (e) {
		log.error(`Error updating room ${room.name}: ${e}`);
	}

	if (rooms.includes(room) && room.isStale) {
		try {
			// Unload by object identity, never a replacement room with the same name.
			await unloadRoom(room, UnloadReason.Keepalive);
		} catch (e) {
			log.error(`Error unloading room ${room.name}: ${e}`);
		}
	}
}

export async function createRoom(
	options: Partial<RoomOptions> & { name: string; password?: string },
): Promise<void> {
	await withRoomOperation(options.name, () => createRoomUnlocked(options));
}

async function createRoomUnlocked(
	options: Partial<RoomOptions> & { name: string; password?: string },
): Promise<void> {
	for (const room of rooms) {
		if (options.name.toLowerCase() === room.name.toLowerCase()) {
			log.warn("can't create room, already loaded");
			throw new RoomNameTakenException(options.name);
		}
	}
	if (await redisClient.exists(`room:${options.name}`)) {
		log.warn("can't create room, already in redis");
		throw new RoomNameTakenException(options.name);
	}
	if (await storage.isRoomNameTaken(options.name)) {
		log.warn("can't create room, already exists in database");
		throw new RoomNameTakenException(options.name);
	}
	const room = new Room(options);
	if (!room.isTemporary) {
		const saved = await storage.saveRoom(room);
		if (!saved) {
			// A permanent room without a database row would retry its checkpoint
			// forever; fail the create instead of admitting a doomed room.
			throw new Error(`Failed to save room ${options.name} to storage`);
		}
	}
	if (options.password) {
		await setRoomPassword(room, options.password);
	}
	await room.update();
	await room.sync();
	await addRoom(room);
	log.info(`Room created: ${room.name}`);
}

/**
 * Get a room by name, or load it from storage if it's not loaded.
 * @param roomName
 * @param options
 * @param options.mustAlreadyBeLoaded If true, will throw if the room is not already loaded in the current Monolith.
 * @returns
 */
export async function getRoom(
	roomName: string,
	options: { mustAlreadyBeLoaded?: boolean } = {},
): Promise<Result<Room, RoomNotFoundException | RoomAlreadyLoadedException>> {
	return withRoomOperation(roomName, () => getRoomUnlocked(roomName, options));
}

async function getRoomUnlocked(
	roomName: string,
	options: { mustAlreadyBeLoaded?: boolean },
): Promise<Result<Room, RoomNotFoundException | RoomAlreadyLoadedException>> {
	_.defaults(options, {
		mustAlreadyBeLoaded: false,
	});
	for (const room of rooms) {
		if (room.name.toLowerCase() === roomName.toLowerCase()) {
			log.debug("found room in room manager");
			return ok(room);
		}
	}

	if (options.mustAlreadyBeLoaded) {
		return err(new RoomNotFoundException(roomName));
	}

	let fixedState: ReturnType<typeof redisStateToState> | null = null;
	const redisState = await redisClient.get(`room:${roomName}`);
	if (redisState) {
		log.debug("found room in redis");
		try {
			const state = JSON.parse(redisState) as RoomStateFromRedis;
			fixedState = redisStateToState(state);
			if (!fixedState.isTemporary) {
				fixedState.isPlaying = false;
			}
		} catch (e) {
			// A corrupt snapshot must not wedge every load; drop it and fall back to the DB.
			log.error(`Failed to parse redis state for room ${roomName}, discarding it: ${e}`);
			await redisClient.del(`room:${roomName}`);
		}
	}
	if (fixedState) {
		// The snapshot never carries password material, so the hash is read back separately:
		// permanent rooms from Postgres, temporary rooms from their own Redis key. Skipping
		// this for temporary rooms reopened a private room unlocked after every restart.
		fixedState.passwordHash = fixedState.isTemporary
			? await getTemporaryRoomPasswordHash(fixedState.name)
			: await storage.getRoomPasswordHash(fixedState.name);
		const room = new Room(fixedState);
		await addRoom(room);
		return ok(room);
	}

	const opts = await storage.getRoomByName(roomName);
	if (!opts) {
		log.debug("room not found in room manager, nor redis, nor database");
		return err(new RoomNotFoundException(roomName));
	}
	const room = new Room(opts);
	// No snapshot survived, so the room comes back paused with its queue loaded: only Redis
	// remembers whether the room was playing, and entering the room must not start it.
	room.restoreFromStorage();
	await addRoom(room);
	return ok(room);
}

export async function unloadRoom(
	room: string | Room,
	reason: UnloadReason,
	options: Partial<{ preserveRedis: boolean }> = {},
): Promise<void> {
	await withRoomOperation(typeof room === "string" ? room : room.name, () =>
		unloadRoomUnlocked(room, reason, options),
	);
}

async function unloadRoomUnlocked(
	room: string | Room,
	reason: UnloadReason,
	options: Partial<{ preserveRedis: boolean }>,
): Promise<void> {
	const opts = _.defaults(options, {
		preserveRedis: reason === UnloadReason.Commanded,
	});

	let idx = -1;
	if (typeof room === "string") {
		for (let i = 0; i < rooms.length; i++) {
			if (rooms[i].name.toLowerCase() === room.toLowerCase()) {
				idx = i;
				break;
			}
		}
		if (idx < 0) {
			throw new RoomNotFoundException(room);
		}
		room = rooms[idx];
	}
	const roomName = room.name;
	log.info(`Unloading room: ${roomName}`);
	if (reason !== UnloadReason.Commanded) {
		await room.onBeforeUnload();
	}
	// Re-resolve by identity: the awaits above may have shifted the array, and a
	// Room object argument never produced a valid index here at all.
	idx = rooms.indexOf(room);
	if (idx < 0) {
		throw new RoomNotFoundException(roomName);
	}
	rooms.splice(idx, 1);
	if (!opts.preserveRedis) {
		await redisClient.del(`room:${room.name}`);
		await redisClient.del(`room-sync:${room.name}`);
		if (room.isTemporary) {
			await redisClient.del(temporaryPasswordKey(room.name));
		}
	}
	bus.emit("unload", room.name, reason);
}

/**
 * Clear all rooms off of this node.
 * Does not "unload" rooms. Intended to only be used in tests.
 */
export function clearRooms(): void {
	while (rooms.length > 0) {
		rooms.shift();
	}
}

/** Unload all rooms off of this node. Intended to only be used in tests. */
export async function unloadAllRooms(): Promise<void> {
	const names = rooms.map(r => r.name);
	await Promise.all(names.map(name => unloadRoom(name, UnloadReason.Admin)));
}

export function publish(roomName: string, msg: ServerMessage) {
	bus.emit("publish", roomName, msg);
}

export function command(roomName: string, cmd: ClientManagerCommand) {
	bus.emit("command", roomName, cmd);
}

export function on<E extends RoomManagerEvents>(event: E, listener: RoomManagerEventHandlers<E>) {
	bus.on(event, listener);
}

/** Per-room work duration; waiting for a concurrency slot is not included. */
const histUpdateDuration = new Histogram({
	name: "ott_room_manager_update_duration_seconds",
	help: "How long one room update and checkpoint takes, excluding slot wait",
	buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10],
});

const counterUpdateSkipped = new Counter({
	name: "ott_room_manager_update_skipped_total",
	help: "Periodic updates skipped for rooms with work already pending",
});

// biome-ignore lint/correctness/noUnusedVariables: biome migration
const gaugeRoomCount = new Gauge({
	name: "ott_room_count",
	help: "The number of loaded rooms.",
	labelNames: ["roomType", "visibility"],
	collect() {
		const counts: Record<"temporary" | "permanent", Record<Visibility, number>> = {
			temporary: {
				public: 0,
				unlisted: 0,
				private: 0,
			},
			permanent: {
				public: 0,
				unlisted: 0,
				private: 0,
			},
		};
		for (const room of rooms) {
			counts[room.isTemporary ? "temporary" : "permanent"][room.visibility] += 1;
		}
		for (const roomType of Object.keys(counts)) {
			for (const visibility of Object.keys(counts[roomType])) {
				const value = counts[roomType][visibility];
				this.set({ roomType, visibility }, value);
			}
		}
	},
});

// biome-ignore lint/correctness/noUnusedVariables: biome migration
const gaugeUsersInRooms = new Gauge({
	name: "ott_users_in_rooms",
	help: "The number of users that the room manager thinks are in rooms.",
	collect() {
		let count = 0;
		for (const room of rooms) {
			count += room.users.length;
		}
		this.set(count);
	},
});

const roommanager = {
	rooms,
	log,
	start,
	shutdown,

	createRoom,
	getRoom,
	unloadRoom,
	clearRooms,
	unloadAllRooms,
	publish,
	command,
	on,
};

export default roommanager;
