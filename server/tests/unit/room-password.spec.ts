import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Room } from "../../room.js";
import { buildClients } from "../../redisclient.js";
import {
	grantRoomAccess,
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
});
