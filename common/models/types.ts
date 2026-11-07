import type { Session } from "express-session";
import type { QueueItem, Video } from "./video.js";
import type { Grants } from "../permissions.js";
import type { Category } from "sponsorblock-api";

export enum Visibility {
	Public = "public",
	Unlisted = "unlisted",
	Private = "private",
}

export enum QueueMode {
	Manual = "manual",
	Vote = "vote",
	Loop = "loop",
	Dj = "dj",
}

export enum BehaviorOption {
	Always = 2,
	Prompt = 1,
	Never = 0,
}

export enum BufferGateMode {
	Off = "off",
	Pause = "pause",
}

export enum OttWebsocketError {
	AWAY = 1001,
	UNKNOWN = 4000,
	INVALID_CONNECTION_URL = 4001,
	ROOM_NOT_FOUND = 4002,
	ROOM_UNLOADED = 4003,
	MISSING_TOKEN = 4004,
	KICKED = 4005,
	ROOM_PASSWORD_REQUIRED = 4006,
}

export enum PlayerStatus {
	none = "none",
	ready = "ready",
	buffering = "buffering",
	error = "error",
}

export type AuthToken = string;
export type MySession = Session & {
	username?: string;
	passport?: { user?: number };
	postLoginRedirect?: string;
};

/**
 * A compact, per-viewer snapshot of why playback is (or is not) healthy. Sent alongside
 * the status heartbeat so the server can log it when a viewer holds the buffer gate,
 * instead of only knowing that the viewer is buffering. It is ephemeral: never stored in
 * Redis or the sync payload, and it carries only the source host, never the full URL.
 */
export interface PlaybackDiagnostics {
	/** Client wall-clock time when this snapshot was sampled. */
	sampledAt: number;
	/** Server receive time; set by the server, ignored from the wire. */
	receivedAt?: number;
	service?: string;
	/** Host only (no path, query or fragment). */
	sourceHost?: string;
	playerKind?: "native" | "embedded";
	hidden?: boolean;
	paused?: boolean;
	readyState?: number;
	networkState?: number;
	/** Seconds buffered ahead of the current playback position. */
	bufferAhead?: number | null;
	/** Seconds of media buffered per wall second since the previous snapshot. */
	bufferGrowth?: number | null;
	startup?: number | null;
	rebuffers?: number;
	rebufferSeconds?: number;
	playSeconds?: number;
	rateWrites?: number;
	deadlineSeeks?: number;
	maxDrift?: number;
	totalFrames?: number;
	droppedFrames?: number;
	/** Round-trip estimate to the room server, from its ping/pong probes. */
	wsRttMs?: number | null;
	/** navigator.connection, Chromium-only; absent elsewhere. */
	connectionEffectiveType?: string;
	connectionDownlinkMbps?: number;
	connectionRttMs?: number;
	connectionSaveData?: boolean;
	/** hls.js only. */
	hlsBandwidthKbps?: number;
	hlsLevelHeight?: number;
	hlsLevelCount?: number;
	autoplayBlocked?: boolean;
	recovering?: boolean;
	seeking?: boolean;
	errorCode?: number | null;
}

export type ClientInfo = {
	id: ClientId;
	username?: string;
	user_id?: number;
	status?: PlayerStatus;
	diagnostics?: PlaybackDiagnostics;
};

/**
 * A danmaku track a room shares with everyone watching it. The structure is deliberately
 * the same as the per-device binding: the client fetches it through its normal providers
 * (the girigiri bridge or the danmu_api base), never from a stored, arbitrary URL.
 */
export interface RoomDanmakuSource {
	/** Only this video uses the source; another video treats it as stale. */
	videoUrl: string;
	provider: RoomDanmakuProvider;
	label: string;
	/** girigiri: the play-page path (`/playGV…/`). */
	page?: string;
	/** danmu-api: the matched episode id. */
	episodeId?: number | string;
	/** Seconds to shift the track; part of the source, so the room shares it. */
	offset: number;
}

export type RoomDanmakuProvider = "danmu-api" | "girigiri";

/**
 * Settings that can be set through the "settings" UI.
 */
export interface RoomSettings {
	title: string;
	description: string;
	visibility: Visibility;
	queueMode: QueueMode;
	grants: Grants;
	autoSkipSegmentCategories: Category[];
	restoreQueueBehavior: BehaviorOption;
	enableVoteSkip: boolean;
	bufferGateMode: BufferGateMode;
	/** The shared danmaku track, if the room has one; null clears it. */
	danmakuSource?: RoomDanmakuSource | null;
}

/**
 * Things that can be used in `Room`'s constructor. These must be remembered.
 */
export interface RoomOptions extends RoomSettings {
	name: string;
	isTemporary: boolean;
	owner: UserAccountAttributes | null;
	userRoles: Map<Role, Set<number>>;
	/** The queue as it was when the room was last unloaded. */
	prevQueue: QueueItem[] | null;
	/** Which round of permission additions the stored grants already know about. */
	permissionsRevision?: number;
	/** Argon2 hash of the room password; null when unset. Never synced or stored in Redis. */
	passwordHash?: string | null;
}

export type RoomUserInfo = {
	id: ClientId;
	name: string;
	isLoggedIn: boolean;
	status: PlayerStatus;
	role: Role;
};

export enum Role {
	Administrator = 4,
	Moderator = 3,
	TrustedUser = 2,
	RegisteredUser = 1,
	UnregisteredUser = 0,
	Owner = -1,
}

export type ClientId = string;

export interface RoomEventContext {
	video?: Video;
	videos?: Video[];
	prevPosition?: number;
	queueIdx?: number;
	user?: RoomUserInfo;
}

export interface ChatMessage {
	from: RoomUserInfo;
	text: string;
}

export interface UserAccountAttributes {
	id: number;
	username: string;
	email: string | null;
	salt: Buffer | null;
	hash: Buffer | null;
	discordId: string | null;
}
