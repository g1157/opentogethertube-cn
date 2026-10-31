import { afterEach, describe, expect, it, vi } from "vitest";
import argon2 from "argon2";
import { verifyRoomPassword } from "../../../room-password.js";

describe("room password hashing boundary", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("bounds concurrent argon2 verifications", async () => {
		let active = 0;
		let maxActive = 0;
		vi.spyOn(argon2, "verify").mockImplementation(async () => {
			active++;
			maxActive = Math.max(maxActive, active);
			await new Promise(resolve => setTimeout(resolve, 5));
			active--;
			return true;
		});
		const room = { passwordHash: "stored-hash" } as any;

		const results = await Promise.all(
			Array.from({ length: 8 }, () => verifyRoomPassword(room, "guess")),
		);

		expect(results).toEqual(Array(8).fill(true));
		expect(maxActive).toBeLessThanOrEqual(2);
		expect(active).toBe(0);
	});

	it("releases a slot when a verification rejects", async () => {
		let calls = 0;
		vi.spyOn(argon2, "verify").mockImplementation(async () => {
			calls++;
			if (calls === 1) {
				throw new Error("bad hash");
			}
			return true;
		});
		const room = { passwordHash: "stored-hash" } as any;

		await expect(verifyRoomPassword(room, "guess")).resolves.toBe(false);
		await expect(verifyRoomPassword(room, "guess")).resolves.toBe(true);
		await expect(verifyRoomPassword(room, "guess")).resolves.toBe(true);
	});
});
