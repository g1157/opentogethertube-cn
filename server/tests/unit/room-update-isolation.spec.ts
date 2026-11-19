import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import roommanager from "../../roommanager.js";
import { Room } from "../../room.js";
import { buildClients } from "../../redisclient.js";

describe("periodic room update isolation", () => {
	const releases: (() => void)[] = [];

	beforeAll(async () => {
		await buildClients();
	});

	beforeEach(() => {
		vi.useFakeTimers();
		vi.spyOn(roommanager.log, "error").mockImplementation(() => roommanager.log);
	});

	afterEach(async () => {
		for (const release of releases.splice(0)) {
			release();
		}
		await vi.advanceTimersByTimeAsync(0);
		await roommanager.shutdown();
		roommanager.clearRooms();
		vi.restoreAllMocks();
		vi.useRealTimers();
	});

	function addRoom(name: string): Room {
		const room = new Room({ name, isTemporary: true });
		room.throttledSync.cancel();
		room.saveStateToRedisDebounced.cancel();
		vi.spyOn(room, "update").mockResolvedValue();
		vi.spyOn(room, "sync").mockResolvedValue();
		vi.spyOn(room, "isStale", "get").mockReturnValue(false);
		vi.spyOn(room, "onBeforeUnload").mockResolvedValue();
		roommanager.rooms.push(room);
		return room;
	}

	function blocked(): Promise<void> {
		return new Promise(resolve => {
			releases.push(resolve);
		});
	}

	it("keeps ticking other rooms while one checkpoint is still pending", async () => {
		const slow = addRoom("slow-checkpoint");
		vi.mocked(slow.sync).mockReturnValue(blocked());
		const fast = addRoom("fast-checkpoint");

		await roommanager.start();
		await vi.advanceTimersByTimeAsync(4_000);

		expect(fast.update).toHaveBeenCalledTimes(4);
		expect(fast.sync).toHaveBeenCalledTimes(4);
		expect(slow.update).toHaveBeenCalledTimes(1);
		expect(slow.sync).toHaveBeenCalledTimes(1);
	});

	it("does not overlap a room whose update has not completed", async () => {
		const slow = addRoom("slow-update");
		vi.mocked(slow.update).mockReturnValue(blocked());
		const fast = addRoom("fast-update");

		await roommanager.start();
		await vi.advanceTimersByTimeAsync(3_000);

		expect(slow.update).toHaveBeenCalledTimes(1);
		expect(slow.sync).not.toHaveBeenCalled();
		expect(fast.update).toHaveBeenCalledTimes(3);
	});

	it("bounds concurrent work and does not enqueue another task on every tick", async () => {
		const pending = blocked();
		const rooms = Array.from({ length: 12 }, (_, index) => addRoom("bounded-" + index));
		for (const room of rooms) {
			vi.mocked(room.sync).mockReturnValue(pending);
		}

		await roommanager.start();
		await vi.advanceTimersByTimeAsync(4_000);

		expect(
			rooms.reduce((count, room) => count + vi.mocked(room.sync).mock.calls.length, 0),
		).toBe(8);
		for (const release of releases.splice(0)) {
			release();
		}
		await vi.advanceTimersByTimeAsync(0);
		for (const room of rooms) {
			expect(room.update).toHaveBeenCalledTimes(1);
			expect(room.sync).toHaveBeenCalledTimes(1);
		}
	});

	it("drops queued work for a room unloaded before it receives a slot", async () => {
		const pending = blocked();
		for (let index = 0; index < 8; index++) {
			vi.mocked(addRoom("occupied-" + index).sync).mockReturnValue(pending);
		}
		const removed = addRoom("removed-before-tick");
		await roommanager.start();
		await vi.advanceTimersByTimeAsync(1_000);
		roommanager.rooms.splice(roommanager.rooms.indexOf(removed), 1);

		for (const release of releases.splice(0)) {
			release();
		}
		await vi.advanceTimersByTimeAsync(0);

		expect(removed.update).not.toHaveBeenCalled();
		expect(removed.sync).not.toHaveBeenCalled();
	});

	it("releases a failed room's slot and retries on the next tick", async () => {
		const failed = addRoom("failed-update");
		vi.mocked(failed.update).mockRejectedValue(new Error("database offline"));
		const fast = addRoom("healthy-after-failure");
		await roommanager.start();
		await vi.advanceTimersByTimeAsync(2_000);

		expect(failed.update).toHaveBeenCalledTimes(2);
		expect(fast.sync).toHaveBeenCalledTimes(2);
	});

	it("does not install duplicate periodic timers", async () => {
		const interval = vi.spyOn(global, "setInterval");
		await roommanager.start();
		await roommanager.start();
		expect(interval).toHaveBeenCalledTimes(1);
	});
});
