import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import dayjs from "dayjs";
import { BehaviorOption, Role, Visibility } from "ott-common/models/types.js";
import { RoomRequestType } from "ott-common/models/messages.js";
import { Room, RoomUser } from "../../room.js";
import { loadModels, Room as DbRoom } from "../../models/index.js";
import { buildClients, redisClient } from "../../redisclient.js";
import storage from "../../storage.js";
import { conf } from "../../ott-config.js";
import roommanager from "../../roommanager.js";
import { UnloadReason } from "../../generated.js";

describe("permanent room persistence", () => {
	const rooms: Room[] = [];
	beforeAll(async () => {
		loadModels();
		await buildClients();
		conf.set("video.sponsorblock.enabled", false);
	});
	afterEach(async () => {
		vi.restoreAllMocks();
		for (const room of rooms.splice(0)) {
			room.throttledSync.cancel();
			if (roommanager.rooms.includes(room)) {
				await roommanager.unloadRoom(room.name, UnloadReason.Admin);
			}
			await room.saveStateToRedisDebounced.flush();
			room.saveStateToRedisDebounced.cancel();
			await DbRoom.destroy({ where: { name: room.name } });
		}
	});

	async function createRoom(name: string, visibility = Visibility.Public) {
		const room = new Room({ name, visibility });
		rooms.push(room);
		expect(await storage.saveRoom(room)).toBe(true);
		return room;
	}

	it("saves current and queued links before the room is unloaded", async () => {
		const room = await createRoom("saved-before-unload");
		room.currentSource = { service: "direct", id: "first.mp4", length: 120 };
		room.playbackPosition = 18;
		await room.queue.enqueue({ service: "direct", id: "second.mp4", length: 120 });
		await room.sync();
		const saved = await storage.getRoomByName(room.name);
		expect(saved?.prevQueue?.map(item => item.id)).toEqual(["first.mp4", "second.mp4"]);
		expect(saved?.prevQueue?.[0].startAt).toBe(18);
	});

	it("pauses when the last viewer leaves and restores links without duplicating the queue", async () => {
		const room = await createRoom("empty-room");
		room.currentSource = { service: "direct", id: "first.mp4", length: 120 };
		await room.queue.enqueue({ service: "direct", id: "second.mp4", length: 120 });
		room.playbackPosition = 10;
		room._playbackStart = dayjs().subtract(20, "seconds");
		room.isPlaying = true;
		room.realusers.push(new RoomUser("viewer", "test-token"));
		await room.leaveRoom(
			{ type: RoomRequestType.LeaveRequest },
			{
				clientId: "viewer",
				username: "viewer",
				role: Role.UnregisteredUser,
			},
		);
		expect(room.isPlaying).toBe(false);
		expect(room.realPlaybackPosition).toBeCloseTo(30, 0);
		await room.onBeforeUnload();
		expect(room.queue.items.map(item => item.id)).toEqual(["second.mp4"]);
		const saved = await storage.getRoomByName(room.name);
		expect(saved?.restoreQueueBehavior).toBe(BehaviorOption.Always);
		const restored = new Room(saved!);
		rooms.push(restored);
		await restored.update();
		expect(restored.currentSource?.id).toBe("first.mp4");
		expect(restored.playbackPosition).toBeCloseTo(30, 0);
		expect(restored.queue.items.map(item => item.id)).toEqual(["second.mp4"]);
		expect(restored.isPlaying).toBe(false);
	});

	it("keeps saved public rooms discoverable while hiding unlisted rooms", async () => {
		const publicRoom = await createRoom("retention-list-public");
		const unlistedRoom = await createRoom("retention-list-unlisted", Visibility.Unlisted);
		const privateRoom = await createRoom("retention-list-private", Visibility.Private);
		const fixtureNames = new Set([publicRoom.name, unlistedRoom.name, privateRoom.name]);
		// Parallel test files share SQLite; only assert visibility for this test's fixtures.
		const publicNames = (await storage.getPermanentRoomList())
			.map(room => room.name)
			.filter(name => fixtureNames.has(name));
		expect(publicNames).toEqual([publicRoom.name]);
		const allNames = (await storage.getPermanentRoomList(true))
			.map(room => room.name)
			.filter(name => fixtureNames.has(name));
		expect(new Set(allNames)).toEqual(fixtureNames);
	});

	it("does not resurrect links after the current video and queue are explicitly cleared", async () => {
		const room = await createRoom("cleared-permanent-room");
		room.currentSource = { service: "direct", id: "first.mp4", length: 120 };
		await room.queue.enqueue({ service: "direct", id: "second.mp4", length: 120 });
		await room.sync();
		room.currentSource = null;
		await room.queue.set([]);
		await room.onBeforeUnload();
		const saved = await storage.getRoomByName(room.name);
		expect(saved?.prevQueue).toBeNull();
	});

	it("preserves a link added while a previous database checkpoint is still pending", async () => {
		const room = await createRoom("concurrent-checkpoint-room");
		await room.sync();
		room.throttledSync.cancel();
		const updateRoom = storage.updateRoom;
		let started: () => void = () => undefined;
		const firstStarted = new Promise<void>(resolve => {
			started = resolve;
		});
		let release: () => void = () => undefined;
		const blocked = new Promise<void>(resolve => {
			release = resolve;
		});
		vi.spyOn(storage, "updateRoom").mockImplementationOnce(async update => {
			started();
			await blocked;
			return updateRoom(update);
		});
		room.currentSource = { service: "direct", id: "first.mp4", length: 120 };
		const first = room.sync();
		await firstStarted;
		await room.queue.enqueue({ service: "direct", id: "second.mp4", length: 120 });
		const second = room.sync();
		release();
		await Promise.all([first, second]);
		const saved = await storage.getRoomByName(room.name);
		expect(saved?.prevQueue?.map(item => item.id)).toEqual(["first.mp4", "second.mp4"]);
	});

	it("persists false, zero, and empty strings when settings are changed", async () => {
		const room = await createRoom("settings-room");
		await storage.updateRoom({ name: room.name, enableVoteSkip: true, description: "old" });
		await storage.updateRoom({
			name: room.name,
			enableVoteSkip: false,
			restoreQueueBehavior: BehaviorOption.Never,
			description: "",
		});
		const saved = await storage.getRoomByName(room.name);
		expect(saved?.enableVoteSkip).toBe(false);
		expect(saved?.restoreQueueBehavior).toBe(BehaviorOption.Never);
		expect(saved?.description).toBe("");
	});

	it.each([
		"false result",
		"rejected write",
	])("keeps a failed checkpoint dirty and saves the latest queue on retry: %s", async failure => {
		const room = await createRoom("retry-failed-checkpoint");
		await room.sync();
		room.throttledSync.cancel();
		room.currentSource = { service: "direct", id: "first.mp4", length: 120 };
		await room.queue.enqueue({ service: "direct", id: "second.mp4", length: 120 });
		room.throttledSync.cancel();
		const update = vi.spyOn(storage, "updateRoom");
		if (failure === "false result") {
			update.mockResolvedValueOnce(false);
		} else {
			update.mockRejectedValueOnce(new Error("test database outage"));
		}
		await expect(room.sync()).rejects.toThrow();
		expect(room._dirty.has("currentSource")).toBe(true);
		expect(room._dirty.has("queue")).toBe(true);
		await room.queue.enqueue({ service: "direct", id: "third.mp4", length: 120 });
		await room.sync();
		const saved = await storage.getRoomByName(room.name);
		expect(saved?.prevQueue?.map(item => item.id)).toEqual([
			"first.mp4",
			"second.mp4",
			"third.mp4",
		]);
		expect(room._dirty.size).toBe(0);
	});

	it("handles a background checkpoint failure without losing the retry state", async () => {
		const room = await createRoom("background-failed-checkpoint");
		await room.sync();
		room.throttledSync.cancel();
		vi.spyOn(storage, "updateRoom").mockResolvedValueOnce(false);
		const logged = vi.spyOn(room.log, "error");
		room.currentSource = { service: "direct", id: "first.mp4", length: 120 };
		await expect(room.throttledSync.flush()).resolves.toBeUndefined();
		expect(logged).toHaveBeenCalledWith(
			expect.stringContaining("Background room checkpoint failed"),
		);
		expect(room._dirty.has("currentSource")).toBe(true);
		await room.sync();
		expect((await storage.getRoomByName(room.name))?.prevQueue?.[0].id).toBe("first.mp4");
	});

	it("accepts a no-op checkpoint only when its permanent room still exists", async () => {
		const room = await createRoom("empty-update-checkpoint");
		expect(await storage.updateRoom({ name: room.name, owner: null })).toBe(true);
		expect(
			await storage.updateRoom({ name: "missing-empty-update-checkpoint", owner: null }),
		).toBe(false);
	});

	it("retains the loaded room and Redis until its final database checkpoint succeeds", async () => {
		const roomName = "failed-unload-checkpoint";
		await roommanager.createRoom({ name: roomName, isTemporary: false });
		const room = (await roommanager.getRoom(roomName)).unwrap();
		rooms.push(room);
		room.currentSource = { service: "direct", id: "first.mp4", length: 120 };
		room.playbackPosition = 42;
		await room.queue.enqueue({ service: "direct", id: "second.mp4", length: 120 });
		await room.sync();
		room.throttledSync.cancel();
		await room.saveStateToRedisDebounced.flush();
		const previousRedis = await redisClient.get(`room:${roomName}`);
		expect(previousRedis).not.toBeNull();
		const update = vi.spyOn(storage, "updateRoom").mockResolvedValue(false);
		await expect(roommanager.unloadRoom(roomName, UnloadReason.Keepalive)).rejects.toThrow(
			"Failed to persist permanent room state",
		);
		expect((await roommanager.getRoom(roomName, { mustAlreadyBeLoaded: true })).unwrap()).toBe(
			room,
		);
		expect(await redisClient.get(`room:${roomName}`)).toBe(previousRedis);
		expect(room._dirty.has("currentSource")).toBe(true);
		await room.queue.enqueue({ service: "direct", id: "third.mp4", length: 120 });
		room.throttledSync.cancel();
		update.mockRestore();
		await roommanager.unloadRoom(roomName, UnloadReason.Keepalive);
		expect(roommanager.rooms).not.toContain(room);
		expect(await redisClient.exists(`room:${roomName}`)).toBe(0);
		const saved = await storage.getRoomByName(roomName);
		expect(saved?.prevQueue?.map(item => item.id)).toEqual([
			"first.mp4",
			"second.mp4",
			"third.mp4",
		]);
		expect(saved?.prevQueue?.[0].startAt).toBe(42);
	});
});
