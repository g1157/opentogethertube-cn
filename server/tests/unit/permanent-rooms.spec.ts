import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import dayjs from "dayjs";
import { BehaviorOption, Role, Visibility } from "ott-common/models/types.js";
import { RoomRequestType } from "ott-common/models/messages.js";
import { Room, RoomUser } from "../../room.js";
import { loadModels, sequelize } from "../../models/index.js";
import { buildClients } from "../../redisclient.js";
import storage from "../../storage.js";
import { conf } from "../../ott-config.js";

describe("permanent room persistence", () => {
	const rooms: Room[] = [];
	beforeAll(async () => {
		loadModels();
		await buildClients();
		conf.set("video.sponsorblock.enabled", false);
	});
	beforeEach(async () => {
		await sequelize.sync({ force: true });
	});
	afterEach(async () => {
		for (const room of rooms.splice(0)) {
			room.throttledSync.cancel();
			await room.saveStateToRedisDebounced.flush();
			room.saveStateToRedisDebounced.cancel();
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
		await room.leaveRoom({ type: RoomRequestType.LeaveRequest }, {
			clientId: "viewer", username: "viewer", role: Role.UnregisteredUser,
		});
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
		await createRoom("public-room");
		await createRoom("unlisted-room", Visibility.Unlisted);
		expect((await storage.getPermanentRoomList()).map(room => room.name)).toEqual(["public-room"]);
		expect(await storage.getPermanentRoomList(true)).toHaveLength(2);
	});

	it("persists false, zero, and empty strings when settings are changed", async () => {
		const room = await createRoom("settings-room");
		await storage.updateRoom({ name: room.name, enableVoteSkip: true, description: "old" });
		await storage.updateRoom({
			name: room.name, enableVoteSkip: false, restoreQueueBehavior: BehaviorOption.Never, description: "",
		});
		const saved = await storage.getRoomByName(room.name);
		expect(saved?.enableVoteSkip).toBe(false);
		expect(saved?.restoreQueueBehavior).toBe(BehaviorOption.Never);
		expect(saved?.description).toBe("");
	});
});
