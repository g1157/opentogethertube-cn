import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import { Visibility } from "ott-common/models/types.js";
import type { RoomListItem } from "ott-common/models/rest-api.js";
import { Room } from "../../../room.js";
import router from "../../../api/room.js";
import roommanager from "../../../roommanager.js";
import storage from "../../../storage.js";
import * as rateLimit from "../../../rate-limit.js";
import { conf } from "../../../ott-config.js";

const app = express();
app.use(express.json());
app.use("/api/room", router);
const previousRooms = roommanager.rooms;
const previousKey = conf.get("api_key");
const previousCreate = conf.get("room.enable_create_temporary");
const source = {
	service: "direct" as const,
	id: "https://media.example/private.mp4",
	title: "private title",
};
const loaded = (name: string, hasPassword: boolean): Room => {
	const room = new Room({
		name,
		title: name,
		description: "description",
		isTemporary: true,
		visibility: Visibility.Public,
		passwordHash: hasPassword ? "recorded-test-hash" : null,
	});
	room.currentSource = source;
	room.throttledSync.cancel();
	room.saveStateToRedisDebounced.cancel();
	return room;
};

describe("public room list and create input boundaries", () => {
	beforeEach(() => {
		vi.spyOn(rateLimit, "consumeRateLimitPoints").mockResolvedValue(true);
		vi.spyOn(storage, "getPermanentRoomList").mockResolvedValue([]);
		conf.set("api_key", "review-only-api-key");
		conf.set("room.enable_create_temporary", true);
		roommanager.rooms = [loaded("protected-loaded", true), loaded("open-loaded", false)];
	});

	afterEach(() => {
		roommanager.rooms = previousRooms;
		conf.set("api_key", previousKey);
		conf.set("room.enable_create_temporary", previousCreate);
		vi.restoreAllMocks();
	});

	it("hides loaded password-room sources without hiding ordinary public sources", async () => {
		const response = await request(app).get("/api/room/list").expect(200);
		expect(
			response.body.find((room: RoomListItem) => room.name === "protected-loaded")
				.currentSource,
		).toBeNull();
		expect(
			response.body.find((room: RoomListItem) => room.name === "open-loaded").currentSource,
		).toEqual(source);
	});

	it("hides saved password-room sources without loading their room", async () => {
		const room = loaded("protected-saved", true);
		vi.mocked(storage.getPermanentRoomList).mockResolvedValue([
			{
				name: room.name,
				title: room.title,
				description: room.description,
				visibility: room.visibility,
				queueMode: room.queueMode,
				users: 0,
				isTemporary: false,
				hasPassword: room.hasPassword,
				currentSource: source,
			},
		]);
		const response = await request(app).get("/api/room/list").expect(200);
		expect(
			response.body.find((room: RoomListItem) => room.name === "protected-saved")
				.currentSource,
		).toBeNull();
	});

	it("preserves the explicit management API key's source visibility", async () => {
		const response = await request(app)
			.get("/api/room/list")
			.set("apikey", "review-only-api-key")
			.expect(200);
		expect(
			response.body.find((room: RoomListItem) => room.name === "protected-loaded")
				.currentSource,
		).toEqual(source);
	});

	it("paginates the combined live/saved directory without repeating live room copies", async () => {
		const saved = ["alpha-saved", "open-loaded", "protected-loaded", "zulu-saved"].map(
			name => ({
				name,
				title: name,
				description: "description",
				visibility: Visibility.Public,
				queueMode: roommanager.rooms[0].queueMode,
				users: 0,
				isTemporary: false,
				hasPassword: name === "protected-loaded",
				currentSource: source,
			}),
		);
		vi.mocked(storage.getPermanentRoomList).mockImplementation(
			async (_includeUnlisted, limit = 200, offset = 0) =>
				saved.slice(offset, offset + limit),
		);
		const first = await request(app).get("/api/room/list?limit=2&offset=0").expect(200);
		const second = await request(app).get("/api/room/list?limit=2&offset=2").expect(200);
		expect(first.body.map((room: RoomListItem) => room.name)).toEqual([
			"alpha-saved",
			"open-loaded",
		]);
		expect(second.body.map((room: RoomListItem) => room.name)).toEqual([
			"protected-loaded",
			"zulu-saved",
		]);
		expect(second.body[0].currentSource).toBeNull();
	});

	it("places active live rooms before saved rooms and applies offsets to the merged list", async () => {
		const activeRoom = roommanager.rooms[0];
		vi.spyOn(activeRoom, "users", "get").mockReturnValue(
			new Array<(typeof activeRoom.users)[number]>(3),
		);
		const first = await request(app).get("/api/room/list?limit=1").expect(200);
		expect(first.body.map((room: RoomListItem) => room.name)).toEqual(["protected-loaded"]);
		expect(first.body[0].users).toBe(3);
		expect(first.body[0].currentSource).toBeNull();
		expect(storage.getPermanentRoomList).not.toHaveBeenCalled();
		const second = await request(app).get("/api/room/list?limit=1&offset=1").expect(200);
		expect(second.body.map((room: RoomListItem) => room.name)).toEqual(["open-loaded"]);
	});

	it("defaults to 200 and clamps pagination inputs for saved-only pages", async () => {
		roommanager.rooms = [];
		await request(app).get("/api/room/list").expect(200);
		expect(storage.getPermanentRoomList).toHaveBeenLastCalledWith(false, 200, 0);
		await request(app).get("/api/room/list?limit=9999&offset=-5").expect(200);
		expect(storage.getPermanentRoomList).toHaveBeenLastCalledWith(false, 200, 0);
		await request(app).get("/api/room/list?limit=0&offset=2").expect(200);
		expect(storage.getPermanentRoomList).toHaveBeenLastCalledWith(false, 1, 2);
	});

	it.each([
		"limit=abc",
		"limit=1.5",
		"limit=2&limit=3",
		"offset=not-a-number",
		"offset=9007199254740992",
	])("rejects malformed pagination: %s", async query => {
		await request(app).get(`/api/room/list?${query}`).expect(400);
		expect(storage.getPermanentRoomList).not.toHaveBeenCalled();
	});

	it("keeps unlisted live rooms out of public pages even after an authorized request", async () => {
		roommanager.rooms[0].visibility = Visibility.Unlisted;
		const management = await request(app)
			.get("/api/room/list?limit=1")
			.set("apikey", "review-only-api-key")
			.expect(200);
		expect(management.body).toHaveLength(1);
		const publicPage = await request(app).get("/api/room/list?limit=1").expect(200);
		expect(publicPage.body.map((room: RoomListItem) => room.name)).toEqual(["open-loaded"]);
	});

	it("rejects oversized create descriptions before admitting a room", async () => {
		const create = vi.spyOn(roommanager, "createRoom").mockResolvedValue(undefined);
		await request(app)
			.post("/api/room/create")
			.send({ name: "bounded-create", description: "x".repeat(5001) })
			.expect(400);
		expect(create).not.toHaveBeenCalled();
	});

	it("accepts the exact create description limit", async () => {
		const create = vi.spyOn(roommanager, "createRoom").mockResolvedValue(undefined);
		await request(app)
			.post("/api/room/create")
			.send({ name: "bounded-create", description: "x".repeat(5000) })
			.expect(201);
		expect(create).toHaveBeenCalledWith(
			expect.objectContaining({ description: "x".repeat(5000) }),
		);
	});
});
