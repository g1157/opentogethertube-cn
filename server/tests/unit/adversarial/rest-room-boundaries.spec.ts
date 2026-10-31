import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { main } from "../../../app.js";
import roommanager from "../../../roommanager.js";
import { UnloadReason } from "../../../generated.js";
import { Visibility } from "ott-common/models/types.js";

describe("REST room and auth boundaries", () => {
	let app: any;
	let ipSequence = 0;
	const createdRooms = new Set<string>();
	const nextIp = () => `10.20.${Math.floor(ipSequence / 250)}.${(ipSequence++ % 250) + 1}`;

	async function tokenFor(): Promise<string> {
		const response = await request(app).get("/api/auth/grant").set("X-Forwarded-For", nextIp());
		expect(response.status).toBe(200);
		expect(typeof response.body.token).toBe("string");
		return response.body.token;
	}

	async function createRoom(name: string, visibility: Visibility = Visibility.Public) {
		await roommanager.createRoom({
			name,
			isTemporary: true,
			visibility,
		});
		createdRooms.add(name);
	}

	beforeAll(async () => {
		app = (await main()).app;
		app.set("trust proxy", 1);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	afterAll(async () => {
		for (const name of createdRooms) {
			try {
				await roommanager.unloadRoom(name, UnloadReason.Admin);
			} catch {
				// Already unloaded or never loaded.
			}
		}
	});

	it("rejects invalid room-create bodies with 400", async () => {
		const token = await tokenFor();
		for (const body of [
			{ name: "ab" },
			{ name: "x".repeat(33) },
			{ name: "list" },
			{ name: "valid-name", title: "a\nb" },
			{ name: "valid-name", password: "123" },
		]) {
			const response = await request(app)
				.post("/api/room/create")
				.set("X-Forwarded-For", nextIp())
				.set("Authorization", `Bearer ${token}`)
				.send(body);
			expect(response.status, JSON.stringify(body)).toBe(400);
		}
	});

	it("does not let a guest set a room password", async () => {
		const name = `adv-password-${Date.now()}`;
		await createRoom(name);
		const token = await tokenFor();

		const response = await request(app)
			.patch(`/api/room/${name}/password`)
			.set("X-Forwarded-For", nextIp())
			.set("Authorization", `Bearer ${token}`)
			.send({ password: "abcd" });

		expect(response.status).not.toBe(200);
		expect([400, 401, 403]).toContain(response.status);
	});

	it("requires a password for a new private room", async () => {
		const token = await tokenFor();
		const name = `adv-private-create-${Date.now()}`;

		const refused = await request(app)
			.post("/api/room/create")
			.set("X-Forwarded-For", nextIp())
			.set("Authorization", `Bearer ${token}`)
			.send({ name, visibility: Visibility.Private });
		expect(refused.status).toBe(400);

		const created = await request(app)
			.post("/api/room/create")
			.set("X-Forwarded-For", nextIp())
			.set("Authorization", `Bearer ${token}`)
			.send({ name, visibility: Visibility.Private, password: "abcd" });
		expect(created.status).toBe(201);
		createdRooms.add(name);

		const locked = await request(app)
			.get(`/api/room/${name}`)
			.set("X-Forwarded-For", nextIp())
			.set("Authorization", `Bearer ${token}`);
		expect(locked.status).toBe(401);

		const unlocked = await request(app)
			.post(`/api/room/${name}/password`)
			.set("X-Forwarded-For", nextIp())
			.set("Authorization", `Bearer ${token}`)
			.send({ password: "abcd" });
		expect(unlocked.status).toBe(200);

		const visible = await request(app)
			.get(`/api/room/${name}`)
			.set("X-Forwarded-For", nextIp())
			.set("Authorization", `Bearer ${token}`);
		expect(visible.status).toBe(200);
	});

	it("returns 404 for an unknown room", async () => {
		const token = await tokenFor();
		const response = await request(app)
			.get(`/api/room/does-not-exist-${Date.now()}`)
			.set("X-Forwarded-For", nextIp())
			.set("Authorization", `Bearer ${token}`);
		expect(response.status).toBe(404);
	});

	it("rejects a malformed queue add before touching a room", async () => {
		const token = await tokenFor();
		const response = await request(app)
			.post("/api/room/whatever/queue")
			.set("X-Forwarded-For", nextIp())
			.set("Authorization", `Bearer ${token}`)
			.send({});
		expect(response.status).toBe(400);
	});

	it("does not expose process metrics to a spoofed client address", async () => {
		for (const path of ["/api/status/metrics", "/api/status/voice"]) {
			const response = await request(app).get(path).set("X-Forwarded-For", "10.0.0.1");
			expect(response.status, path).toBe(403);
		}
	});

	it("requires the admin key for announcements", async () => {
		const missing = await request(app)
			.post("/api/announce")
			.set("X-Forwarded-For", nextIp())
			.send({ text: "hello" });
		expect(missing.status).toBe(400);

		const wrong = await request(app)
			.post("/api/announce")
			.set("X-Forwarded-For", nextIp())
			.set("apikey", "not-the-key")
			.send({ text: "hello" });
		expect(wrong.status).toBe(400);
	});

	it("rejects an invalid API key on the room list", async () => {
		const response = await request(app)
			.get("/api/room/list")
			.set("X-Forwarded-For", nextIp())
			.set("apikey", "not-the-key");
		expect(response.status).toBe(400);
	});

	it("does not pollute Object.prototype through a login body", async () => {
		const response = await request(app)
			.post("/api/user/login")
			.set("X-Forwarded-For", nextIp())
			.set("Content-Type", "application/json")
			.send('{"__proto__":{"polluted":true},"user":"nobody","password":"wrong"}');
		expect([400, 401, 429]).toContain(response.status);
		expect(({} as any).polluted).toBeUndefined();
	});

	it("rejects an oversized login body", async () => {
		const response = await request(app)
			.post("/api/user/login")
			.set("X-Forwarded-For", nextIp())
			.set("Content-Type", "application/json")
			.send(JSON.stringify({ user: "nobody", password: "x".repeat(200_000) }));
		expect([400, 413]).toContain(response.status);
	});

	// A room created before the password rule (or through the internal manager) keeps its
	// old "listed nowhere, reachable by name" behavior. New API rooms cannot be created
	// this way, so the gap cannot grow.
	it("keeps a legacy passwordless private room reachable until it gets a password", async () => {
		const name = `adv-private-${Date.now()}`;
		await createRoom(name, Visibility.Private);
		const token = await tokenFor();

		const response = await request(app)
			.get(`/api/room/${name}`)
			.set("X-Forwarded-For", nextIp())
			.set("Authorization", `Bearer ${token}`);
		expect(response.status).toBe(200);
	});
});
