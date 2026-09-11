import type { RoomListItem } from "ott-common/models/rest-api.js";
import type { Snapshot } from "./room-state";
import { ApiError, type Env } from "./types";

const ROOM_NAME = /^[a-z0-9_-]{3,64}$/i;

export interface RoomRecord {
	name: string;
	instance_id: string;
	owner_id: string;
	title: string;
	description: string;
	visibility: RoomListItem["visibility"];
	is_temporary: number;
	queue_mode: RoomListItem["queueMode"];
	current_source: string | null;
	user_count: number;
	expires_at: number | null;
	created_at: number;
}

export function idleMilliseconds(env: Env): number {
	const seconds = Number(env.ROOM_IDLE_SECONDS ?? 300);
	return Number.isFinite(seconds) && seconds >= 1 && seconds <= 86400 ? seconds * 1000 : 300_000;
}

export function checkpointMilliseconds(env: Env): number {
	const seconds = Number(env.CHECKPOINT_SECONDS ?? 30);
	return Number.isFinite(seconds) && seconds >= 15 && seconds <= 600 ? seconds * 1000 : 30_000;
}

export function roomName(value: string): string {
	if (!ROOM_NAME.test(value)) {
		throw new ApiError(404, "房间不存在。", "RoomNotFoundException");
	}
	return value.toLowerCase();
}

export async function findRoom(env: Env, name: string): Promise<RoomRecord> {
	const row = await env.DB.prepare("SELECT * FROM rooms WHERE name = ?")
		.bind(roomName(name))
		.first<RoomRecord>();
	if (!row) {
		throw new ApiError(404, "房间不存在或已过期。", "RoomNotFoundException");
	}
	return row;
}

export function roomStub(env: Env, instance: string) {
	return env.ROOMS.get(env.ROOMS.idFromName(instance));
}

export function listItem(row: RoomRecord): RoomListItem {
	return {
		name: row.name,
		title: row.title,
		description: row.description,
		isTemporary: Boolean(row.is_temporary),
		visibility: row.visibility,
		queueMode: row.queue_mode,
		currentSource: row.current_source ? JSON.parse(row.current_source) : null,
		users: row.user_count,
	};
}

export function indexValues(snapshot: Snapshot, users: number, idleMs: number) {
	return [
		snapshot.title,
		snapshot.description,
		snapshot.visibility,
		snapshot.queueMode,
		snapshot.currentSource ? JSON.stringify(snapshot.currentSource) : null,
		users,
		snapshot.isTemporary && snapshot.emptySince !== null ? snapshot.emptySince + idleMs : null,
	];
}
