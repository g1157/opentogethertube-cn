import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Room } from "../../room.js";
import { buildClients } from "../../redisclient.js";
import {
	grantRoomAccess,
	getTemporaryRoomPasswordHash,
	hasRoomAccess,
	setRoomPassword,
	verifyRoomPassword,
} from "../../room-password.js";
import type { AuthToken } from "ott-common/models/types.js";
import type { User } from "../../models/user.js";

describe("room password", () => {
	beforeAll(async () => {
		await buildClients();
	});

	let room: Room;
	const guestSession = { isLoggedIn: false as const, username: "guest" };
	const guestToken = "guest-token" as AuthToken;

	beforeEach(() => {
		room = new Room({
			name: `pw-${Math.random().toString(36).slice(2, 8)}`,
			isTemporary: true,
		});
		vi.spyOn(room, "publish").mockResolvedValue(undefined);
	});

	afterEach(async () => {
		await room.onBeforeUnload();
		room.throttledSync.cancel();
		room.saveStateToRedisDebounced.cancel();
		vi.restoreAllMocks();
	});

	it("stores a hash instead of the password and verifies it", async () => {
		await setRoomPassword(room, "hunter22");
		expect(room.hasPassword).toBe(true);
		expect(room.passwordHash).toBeTruthy();
		expect(room.passwordHash).not.toContain("hunter22");
		expect(room.passwordHash?.startsWith("$argon2")).toBe(true);
		await expect(verifyRoomPassword(room, "hunter22")).resolves.toBe(true);
		await expect(verifyRoomPassword(room, "hunter23")).resolves.toBe(false);
	});

	it("leaves rooms without a password open", async () => {
		expect(await hasRoomAccess(room, undefined, guestSession)).toBe(true);
		await expect(verifyRoomPassword(room, "anything")).resolves.toBe(true);
	});

	it("lets the owner in without a grant and requires one for everyone else", async () => {
		room.owner = { id: 7 } as User;
		await setRoomPassword(room, "hunter22");
		expect(await hasRoomAccess(room, guestToken, { isLoggedIn: true, user_id: 7 })).toBe(true);
		expect(await hasRoomAccess(room, guestToken, guestSession)).toBe(false);
		await grantRoomAccess(room, guestToken);
		expect(await hasRoomAccess(room, guestToken, guestSession)).toBe(true);
	});

	it("invalidates existing grants when the password changes", async () => {
		await setRoomPassword(room, "hunter22");
		await grantRoomAccess(room, guestToken);
		expect(await hasRoomAccess(room, guestToken, guestSession)).toBe(true);
		await setRoomPassword(room, "different33");
		expect(await hasRoomAccess(room, guestToken, guestSession)).toBe(false);
	});

	it("clears the requirement when the password is removed", async () => {
		await setRoomPassword(room, "hunter22");
		expect(await hasRoomAccess(room, guestToken, guestSession)).toBe(false);
		await setRoomPassword(room, null);
		expect(room.hasPassword).toBe(false);
		expect(await hasRoomAccess(room, guestToken, guestSession)).toBe(true);
	});

	/**
	 * A temporary room has no Postgres row and the Redis snapshot deliberately omits
	 * password material, so the hash used to live only in memory. Every restart therefore
	 * reopened a private temporary room to everyone.
	 */
	it("keeps a temporary room's password across a process restart", async () => {
		await setRoomPassword(room, "hunter22");
		const stored = await getTemporaryRoomPasswordHash(room.name);
		expect(stored).toBe(room.passwordHash);

		// The room object is gone; only what reached storage may be used to rebuild it.
		room.throttledSync.cancel();
		room.saveStateToRedisDebounced.cancel();
		const rebuilt = new Room({ name: room.name, isTemporary: true });
		vi.spyOn(rebuilt, "publish").mockResolvedValue(undefined);
		rebuilt.setPasswordHash(await getTemporaryRoomPasswordHash(rebuilt.name));
		expect(rebuilt.hasPassword).toBe(true);
		expect(await hasRoomAccess(rebuilt, guestToken, guestSession)).toBe(false);
		expect(await verifyRoomPassword(rebuilt, "hunter22")).toBe(true);
		await rebuilt.onBeforeUnload();
	});

	it("forgets the stored hash when a temporary room's password is removed", async () => {
		await setRoomPassword(room, "hunter22");
		await setRoomPassword(room, null);
		await expect(getTemporaryRoomPasswordHash(room.name)).resolves.toBeNull();
	});
});
