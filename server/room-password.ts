import argon2 from "argon2";
import crypto from "node:crypto";
import {
	RateLimiterMemory,
	type RateLimiterAbstract,
	type RateLimiterRes,
} from "rate-limiter-flexible";
import { RateLimiterRedisv4 } from "./rate-limit.js";
import { conf } from "./ott-config.js";
import { getLogger } from "./logger.js";
import { redisClient } from "./redisclient.js";
import storage from "./storage.js";
import type { Room } from "./room.js";
import type { SessionInfo } from "./auth/tokens.js";
import type { AuthToken } from "ott-common/models/types.js";

const log = getLogger("room-password");

const GRANT_TTL_SECONDS = 60 * 60 * 24;
const MAX_WRONG_ATTEMPTS = 10;

/**
 * The grant key carries a short version of the stored hash, so changing or clearing the
 * password invalidates every earlier grant without having to scan for the keys.
 */
function grantKey(room: Room, token: AuthToken): string {
	const version = crypto
		.createHash("sha256")
		.update(room.passwordHash ?? "")
		.digest("hex")
		.slice(0, 16);
	return `room-password:${room.name}:${version}:${token}`;
}

export async function setRoomPassword(room: Room, password: string | null): Promise<void> {
	const hash = password === null ? null : await argon2.hash(password);
	if (!room.isTemporary) {
		const updated = await storage.updateRoomPassword(room.name, hash);
		if (!updated) {
			throw new Error(`Failed to persist the password for room ${room.name}`);
		}
	}
	room.setPasswordHash(hash);
}

export async function verifyRoomPassword(room: Room, password: string): Promise<boolean> {
	if (!room.passwordHash) {
		return true;
	}
	try {
		return await argon2.verify(room.passwordHash, password);
	} catch (e) {
		log.error(`Failed to verify the room password: ${e}`);
		return false;
	}
}

export async function grantRoomAccess(room: Room, token: AuthToken): Promise<void> {
	await redisClient.setEx(grantKey(room, token), GRANT_TTL_SECONDS, "1");
}

export async function hasRoomAccess(
	room: Room,
	token: AuthToken | undefined,
	session: SessionInfo | undefined,
): Promise<boolean> {
	if (!room.passwordHash) {
		return true;
	}
	if (session?.isLoggedIn && room.owner && room.owner.id === session.user_id) {
		return true;
	}
	if (!token) {
		return false;
	}
	return (await redisClient.exists(grantKey(room, token))) > 0;
}

let limiter: RateLimiterAbstract | null = null;

function getLimiter(): RateLimiterAbstract {
	if (limiter) {
		return limiter;
	}
	const opts = {
		storeClient: redisClient,
		keyPrefix: "room_password_fail",
		points: conf.get("env") === "test" ? 9999999999 : MAX_WRONG_ATTEMPTS,
		duration: 60,
		blockDuration: 60 * 5,
	};
	limiter =
		conf.get("env") === "test" ? new RateLimiterMemory(opts) : new RateLimiterRedisv4(opts);
	return limiter;
}

function limiterKey(roomName: string, ip: string): string {
	return `${roomName}_${ip}`;
}

/**
 * Consume one attempt before the password is checked. Consuming first makes the limit
 * atomic and exact: a concurrent burst can no longer all pass a pre-check before any of
 * them is counted, and the attempt that crosses the limit is blocked instead of being
 * verified (previously the 11th wrong password still ran argon2 before the block).
 *
 * @returns seconds to wait before retrying, or 0 when the attempt may proceed.
 */
export async function consumeRoomPasswordAttempt(roomName: string, ip: string): Promise<number> {
	if (!conf.get("rate_limit.enabled")) {
		return 0;
	}
	try {
		const result = await getLimiter().consume(limiterKey(roomName, ip));
		return result.consumedPoints > MAX_WRONG_ATTEMPTS
			? Math.round(result.msBeforeNext / 1000) || 1
			: 0;
	} catch (e) {
		if (e instanceof Error) {
			// Storage trouble must not lock everyone out of a password room; the password
			// itself still gates access.
			log.warn(`Failed to consume a room password attempt: ${e}`);
			return 0;
		}
		// rate-limiter-flexible rejects with a RateLimiterRes when the key is blocked.
		const blocked = e as RateLimiterRes;
		return Math.round(blocked.msBeforeNext / 1000) || 1;
	}
}

export async function clearRoomPasswordFailures(roomName: string, ip: string): Promise<void> {
	if (!conf.get("rate_limit.enabled")) {
		return;
	}
	try {
		await getLimiter().delete(limiterKey(roomName, ip));
	} catch (e) {
		log.warn(`Failed to clear the room password attempts counter: ${e}`);
	}
}
