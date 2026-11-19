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
