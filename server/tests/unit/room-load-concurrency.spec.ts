import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import roommanager from "../../roommanager.js";
import { RoomNameTakenException } from "../../exceptions.js";
import { buildClients, redisClient } from "../../redisclient.js";
import storage from "../../storage.js";
import type { RoomOptions } from "ott-common/models/types.js";

describe("concurrent room admission", () => {
	beforeAll(async () => {
		await buildClients();
	});
	afterEach(() => {
		for (const room of roommanager.rooms) {
			room.throttledSync.cancel();
			room.saveStateToRedisDebounced.cancel();
		}
		roommanager.clearRooms();
		vi.restoreAllMocks();
	});

	it("shares one cold-loaded room between simultaneous case-insensitive lookups", async () => {
		vi.spyOn(redisClient, "get").mockResolvedValue(null);
		const lookup = vi.spyOn(storage, "getRoomByName").mockResolvedValue({
			name: "cold-room",
			isTemporary: true,
		} as RoomOptions);
		const results = await Promise.all([
			roommanager.getRoom("cold-room"),
			roommanager.getRoom("COLD-ROOM"),
			roommanager.getRoom("Cold-Room"),
		]);
		expect(results[0].unwrap()).toBe(results[1].unwrap());
		expect(results[0].unwrap()).toBe(results[2].unwrap());
		expect(roommanager.rooms).toHaveLength(1);
		expect(lookup).toHaveBeenCalledOnce();
	});

	it("admits only one temporary room when creators race on the same name", async () => {
		vi.spyOn(redisClient, "exists").mockResolvedValue(0);
		vi.spyOn(storage, "isRoomNameTaken").mockResolvedValue(false);
		const results = await Promise.allSettled([
			roommanager.createRoom({ name: "create-race", isTemporary: true }),
			roommanager.createRoom({ name: "CREATE-RACE", isTemporary: true }),
		]);
		expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
		expect(results.find(result => result.status === "rejected")).toMatchObject({
			status: "rejected",
			reason: expect.any(RoomNameTakenException),
		});
		expect(roommanager.rooms).toHaveLength(1);
	});

	it("does not expose a room whose load epoch failed and permits a later retry", async () => {
		vi.spyOn(redisClient, "get").mockResolvedValue(null);
		vi.spyOn(storage, "getRoomByName").mockResolvedValue({
			name: "failed-epoch",
			isTemporary: true,
		} as RoomOptions);
		const epoch = vi
			.spyOn(redisClient, "incr")
			.mockRejectedValueOnce(new Error("Redis offline"));
		await expect(roommanager.getRoom("failed-epoch")).rejects.toThrow("Redis offline");
		expect(roommanager.rooms).toHaveLength(0);
		epoch.mockResolvedValue(42);
		expect((await roommanager.getRoom("failed-epoch")).unwrap().loadEpoch).toBe(42);
		expect(roommanager.rooms).toHaveLength(1);
	});
});
