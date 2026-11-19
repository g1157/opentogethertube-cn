import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Room, RoomUser, type RoomStateFromRedis } from "../../room.js";
import { redisStateToState } from "../../roommanager.js";
import { buildClients, redisClient } from "../../redisclient.js";
import storage from "../../storage.js";
import type { User } from "../../models/user.js";
import { Role } from "ott-common/models/types.js";
import { RoomRequestType } from "ott-common/models/messages.js";

const PRIVATE_STATE_KEYS = /"userRoles"|"owner"|"hash"|"salt"/;

// Exercise the real Room checkpoint and snapshot restoration using the Redis mock.
// SQL persistence and broadcasts are isolated; no database or media request is needed.
describe("room access checkpoints", () => {
	const rooms: Room[] = [];
	const viewerId = 314;
	const context = { clientId: "admin", username: "admin", role: Role.Administrator };
	let nextRoom = 0;

	function track(room: Room): Room {
		rooms.push(room);
		room.throttledSync.cancel();
		vi.spyOn(room, "throttledSync").mockReturnValue(undefined);
		vi.spyOn(room, "publish").mockResolvedValue(undefined);
		return room;
	}

	function create(isTemporary: boolean): Room {
		return track(new Room({ name: "access-checkpoint-" + nextRoom++, isTemporary }));
	}

	function addViewer(room: Room): RoomUser {
		const viewer = new RoomUser("viewer", "access-viewer-token");
		viewer.user_id = viewerId;
		viewer.user = { id: viewerId, username: "registered-viewer" } as User;
		room.realusers.push(viewer);
		return viewer;
	}

	async function seed(room: Room): Promise<void> {
		await redisClient.set("room:" + room.name, room.serializeState());
		room._dirty.clear();
		room.queue.clean();
	}

	async function checkpoint(room: Room): Promise<void> {
		await room.sync();
		await room.saveStateToRedisDebounced.flush();
	}

	async function snapshot(room: Room): Promise<RoomStateFromRedis> {
		const text = await redisClient.get("room:" + room.name);
		expect(text).not.toBeNull();
		return JSON.parse(text!) as RoomStateFromRedis;
	}

	async function restore(room: Room): Promise<Room> {
		return track(new Room(redisStateToState(await snapshot(room))));
	}

	function expectPrivateStateNotBroadcast(room: Room): void {
		expect(JSON.stringify(vi.mocked(room.publish).mock.calls)).not.toMatch(PRIVATE_STATE_KEYS);
	}

	beforeAll(async () => {
		await buildClients();
	});

	beforeEach(() => {
		vi.spyOn(storage, "updateRoom").mockResolvedValue(true);
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		for (const room of rooms.splice(0)) {
			room.throttledSync.cancel();
			room.saveStateToRedisDebounced.cancel();
			await redisClient.del("room:" + room.name);
		}
	});

	it.each([true, false])("restores a role promotion with isTemporary=%s", async isTemporary => {
		const room = create(isTemporary);
		const viewer = addViewer(room);
		await seed(room);
		await room.promoteUser(
			{
				type: RoomRequestType.PromoteRequest,
				targetClientId: viewer.id,
				role: Role.Moderator,
			},
			context,
		);
		expect(room.getRole(viewer)).toBe(Role.Moderator);
		await checkpoint(room);
		const restored = await restore(room);
		expect(restored.getRoleFromSession({ isLoggedIn: true, user_id: viewerId })).toBe(
			Role.Moderator,
		);
		expectPrivateStateNotBroadcast(room);
	});

	it.each([
		true,
		false,
	])("does not restore a demoted administrator with isTemporary=%s", async isTemporary => {
		const room = create(isTemporary);
		const viewer = addViewer(room);
		room.userRoles.get(Role.Administrator)!.add(viewerId);
		await seed(room);
		await room.promoteUser(
			{
				type: RoomRequestType.PromoteRequest,
				targetClientId: viewer.id,
				role: Role.RegisteredUser,
			},
			context,
		);
		expect(room.getRole(viewer)).toBe(Role.RegisteredUser);
		await checkpoint(room);
		const restored = await restore(room);
		expect(restored.getRoleFromSession({ isLoggedIn: true, user_id: viewerId })).toBe(
			Role.RegisteredUser,
		);
		expectPrivateStateNotBroadcast(room);
	});

	it.each([
		true,
		false,
	])("restores a newly claimed owner with isTemporary=%s", async isTemporary => {
		const room = create(isTemporary);
		await seed(room);
		const owner: Pick<User, "id" | "username" | "hash" | "salt"> = {
			id: 21,
			username: "owner",
			hash: Buffer.from("private-hash"),
			salt: Buffer.from("private-salt"),
		};
		room.owner = owner as User;
		await checkpoint(room);
		expect((await snapshot(room)).owner).toEqual({ id: 21 });
		const restored = await restore(room);
		expect(restored.getRoleFromSession({ isLoggedIn: true, user_id: 21 })).toBe(Role.Owner);
		expectPrivateStateNotBroadcast(room);
	});

	it.each([
		true,
		false,
	])("replaces a previous owner even while hasOwner stays true with isTemporary=%s", async isTemporary => {
		const room = create(isTemporary);
		room.owner = { id: 20 } as User;
		await seed(room);
		room.owner = { id: 21 } as User;
		expect(room.hasOwner).toBe(true);
		await checkpoint(room);
		const restored = await restore(room);
		expect(restored.getRoleFromSession({ isLoggedIn: true, user_id: 20 })).toBe(
			Role.RegisteredUser,
		);
		expect(restored.getRoleFromSession({ isLoggedIn: true, user_id: 21 })).toBe(Role.Owner);
		expectPrivateStateNotBroadcast(room);
	});

	it.each([
		true,
		false,
	])("does not restore a removed owner with isTemporary=%s", async isTemporary => {
		const room = create(isTemporary);
		room.owner = { id: 20 } as User;
		await seed(room);
		room.owner = null;
		await checkpoint(room);
		expect((await snapshot(room)).owner).toBeNull();
		const restored = await restore(room);
		expect(restored.getRoleFromSession({ isLoggedIn: true, user_id: 20 })).toBe(
			Role.RegisteredUser,
		);
		expectPrivateStateNotBroadcast(room);
	});

	it("retains a role change for retry when permanent storage rejects its checkpoint", async () => {
		const room = create(false);
		const viewer = addViewer(room);
		room.userRoles.get(Role.Administrator)!.add(viewerId);
		await seed(room);
		await room.promoteUser(
			{
				type: RoomRequestType.PromoteRequest,
				targetClientId: viewer.id,
				role: Role.RegisteredUser,
			},
			context,
		);
		vi.mocked(storage.updateRoom).mockResolvedValueOnce(false);
		await expect(room.sync()).rejects.toThrow("Failed to persist permanent room state");
		expect(room._dirty.has("userRoles")).toBe(true);
		await checkpoint(room);
		expect(room._dirty.size).toBe(0);
		const restored = await restore(room);
		expect(restored.getRoleFromSession({ isLoggedIn: true, user_id: viewerId })).toBe(
			Role.RegisteredUser,
		);
		expectPrivateStateNotBroadcast(room);
	});
});
