import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import Sequelize from "sequelize";
import express from "express";
import request from "supertest";
import router from "../../../api/room.js";
import roommanager from "../../../roommanager.js";
import * as rateLimit from "../../../rate-limit.js";
import { conf } from "../../../ott-config.js";
import { BehaviorOption, BufferGateMode, QueueMode, Visibility } from "ott-common/models/types.js";
import { MAX_QUEUE_ITEMS } from "ott-common/constants.js";
import type { RoomAttributes } from "../../../models/room.js";
import { Room as DbRoom, sequelize } from "../../../models/index.js";
import { getPermanentRoomList } from "../../../storage/room.js";

vi.mock("../../../models/index.js", async () => {
	const actual = await vi.importActual<typeof import("../../../models/index.js")>(
		"../../../models/index.js",
	);
	const { createModel } = await import("../../../models/room.js");
	const connection = new Sequelize.Sequelize({
		dialect: "sqlite",
		storage: ":memory:",
		logging: false,
	});
	return { ...actual, sequelize: connection, Room: createModel(connection) };
});

function attributes(name: string, visibility = Visibility.Public): Omit<RoomAttributes, "id"> {
	return {
		name,
		title: name,
		description: "description",
		visibility,
		queueMode: QueueMode.Manual,
		ownerId: null,
		permissions: [],
		"role-admin": [],
		"role-mod": [],
		"role-trusted": [],
		autoSkipSegmentCategories: [],
		prevQueue: null,
		restoreQueueBehavior: BehaviorOption.Always,
		enableVoteSkip: false,
		bufferGateMode: BufferGateMode.Off,
		danmakuSource: null,
		passwordHash: null,
		permissionsRevision: null,
	};
}

const source = {
	service: "direct" as const,
	id: "https://media.example/first.mp4",
	title: "First video",
};

const app = express();
app.use("/api/room", router);
const previousRooms = roommanager.rooms;
const previousKey = conf.get("api_key");

describe("permanent room list projection, pagination and cache", () => {
	beforeAll(async () => {
		await sequelize.sync({ force: true });
	});
	beforeEach(async () => {
		await DbRoom.destroy({ where: {} });
		roommanager.rooms = [];
	});
	afterEach(() => {
		vi.restoreAllMocks();
		roommanager.rooms = previousRooms;
		conf.set("api_key", previousKey);
	});
	afterAll(async () => {
		await sequelize.close();
	});

	it("extracts only the first item of a full SQLite queue and retains password metadata", async () => {
		await DbRoom.create({
			...attributes("long-queue"),
			passwordHash: "never-expose-this",
			prevQueue: Array.from({ length: MAX_QUEUE_ITEMS }, (_, index) => ({
				...source,
				id: index === 0 ? source.id : `tail-${index}.mp4`,
			})),
		});
		const query = vi.spyOn(sequelize, "query");
		const rows = await getPermanentRoomList();
		expect(rows).toHaveLength(1);
		expect(rows[0].currentSource).toEqual(source);
		expect(rows[0].hasPassword).toBe(true);
		expect(JSON.stringify(rows)).not.toContain("never-expose-this");
		expect(JSON.stringify(rows)).not.toContain("tail-");
		const sql = String(query.mock.calls[0][0]);
		expect(sql).toContain("json_extract(`prevQueue`, '$[0]') AS `listCurrentSource`");
		expect(sql).not.toContain("`prevQueue`, `passwordHash`");
	});

	it("reports a long saved queue through the API without exposing a locked room source", async () => {
		const queue = Array.from({ length: MAX_QUEUE_ITEMS }, (_, index) => ({
			...source,
			id: index === 0 ? source.id : `tail-${index}.mp4`,
		}));
		await DbRoom.create({ ...attributes("api-open-room"), prevQueue: queue });
		await DbRoom.create({
			...attributes("api-locked-room"),
			passwordHash: "secret-hash",
			prevQueue: queue,
		});
		vi.spyOn(rateLimit, "consumeRateLimitPoints").mockResolvedValue(true);
		conf.set("api_key", "room-list-test-key");
		const publicPage = await request(app).get("/api/room/list").expect(200);
		expect(
			publicPage.body.find((room: { name: string }) => room.name === "api-open-room")
				.currentSource,
		).toEqual(source);
		expect(
			publicPage.body.find((room: { name: string }) => room.name === "api-locked-room")
				.currentSource,
		).toBeNull();
		const management = await request(app)
			.get("/api/room/list")
			.set("apikey", "room-list-test-key")
			.expect(200);
		expect(
			management.body.find((room: { name: string }) => room.name === "api-locked-room")
				.currentSource,
		).toEqual(source);
		expect(JSON.stringify(management.body)).not.toContain("tail-");
		expect(JSON.stringify(management.body)).not.toContain("secret-hash");
	});

	it("orders names deterministically and applies limit/offset before returning rows", async () => {
		for (const name of ["charlie-room", "alpha-room", "bravo-room"])
			await DbRoom.create(attributes(name));
		expect((await getPermanentRoomList(false, 1, 1)).map(room => room.name)).toEqual([
			"bravo-room",
		]);
		expect((await getPermanentRoomList(false, 999, -10)).map(room => room.name)).toEqual([
			"alpha-room",
			"bravo-room",
			"charlie-room",
		]);
		const find = vi.spyOn(DbRoom, "findAll");
		await getPermanentRoomList(false, 0, 2);
		expect(find).toHaveBeenCalledWith(
			expect.objectContaining({
				limit: 1,
				offset: 2,
				order: [
					["name", "ASC"],
					["id", "ASC"],
				],
			}),
		);
	});

	it("keys cache by visibility and page, copies results, and expires after five seconds", async () => {
		await DbRoom.create(attributes("public-room"));
		await DbRoom.create(attributes("unlisted-room", Visibility.Unlisted));
		await DbRoom.create(attributes("private-room", Visibility.Private));
		const clock = vi.spyOn(Date, "now").mockReturnValue(10000);
		const find = vi.spyOn(DbRoom, "findAll");
		const privileged = await getPermanentRoomList(true, 10, 0);
		expect(privileged).toHaveLength(3);
		privileged.splice(0);
		expect(await getPermanentRoomList(true, 10, 0)).toHaveLength(3);
		expect((await getPermanentRoomList(false, 10, 0)).map(room => room.name)).toEqual([
			"public-room",
		]);
		await getPermanentRoomList(false, 1, 0);
		await getPermanentRoomList(false, 1, 1);
		expect(find).toHaveBeenCalledTimes(4);
		clock.mockReturnValue(14999);
		await getPermanentRoomList(false, 10, 0);
		expect(find).toHaveBeenCalledTimes(4);
		clock.mockReturnValue(15000);
		await getPermanentRoomList(false, 10, 0);
		expect(find).toHaveBeenCalledTimes(5);
	});

	it("invalidates cached public rows immediately when visibility or password changes", async () => {
		await DbRoom.create(attributes("changed-room"));
		expect(await getPermanentRoomList()).toHaveLength(1);
		await DbRoom.update(
			{ visibility: Visibility.Unlisted },
			{ where: { name: "changed-room" } },
		);
		expect(await getPermanentRoomList()).toEqual([]);
		await DbRoom.update(
			{ visibility: Visibility.Public, passwordHash: "new-hash" },
			{ where: { name: "changed-room" } },
		);
		expect((await getPermanentRoomList())[0].hasPassword).toBe(true);
	});

	it.each([
		{
			dialect: "postgres",
			projection: [Sequelize.literal('"prevQueue"->0'), "listCurrentSource"],
		},
		{
			dialect: "mysql",
			projection: [
				Sequelize.fn(
					"json_extract",
					Sequelize.col("prevQueue"),
					Sequelize.literal("'$[0]'"),
				),
				"listCurrentSource",
			],
		},
		{
			dialect: "mariadb",
			projection: [
				Sequelize.fn(
					"json_extract",
					Sequelize.col("prevQueue"),
					Sequelize.literal("'$[0]'"),
				),
				"listCurrentSource",
			],
		},
		{ dialect: "mssql", projection: "prevQueue" },
	])("uses the safe projection for $dialect", async ({ dialect, projection }) => {
		vi.spyOn(sequelize, "getDialect").mockReturnValue(dialect);
		const row = DbRoom.build({ ...attributes("dialect-room"), prevQueue: [source] });
		row.setDataValue("listCurrentSource" as keyof RoomAttributes, source as never);
		const find = vi.spyOn(DbRoom, "findAll").mockResolvedValue([row]);
		expect((await getPermanentRoomList())[0].currentSource).toEqual(source);
		expect(find.mock.calls[0][0]?.attributes).toContainEqual(projection);
	});
});
