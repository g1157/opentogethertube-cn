import assert from "node:assert/strict";
import { after, before, it } from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Miniflare, convertV4MiniflareOptions, Response, Log, LogLevel } from "miniflare";

const root = fileURLToPath(new URL("../", import.meta.url));
const origin = "https://preview.example.org";
const mediaOrigin = "https://media.example.org";
const RANGE = /^bytes=(\d+)-(\d+)$/;
const NO_STORE = /no-store/;
const SECURE_COOKIE = /ott_edge_preview_token=.*; HttpOnly; SameSite=Lax;.*; Secure/;
const R = {
	play: 2,
	skip: 3,
	seek: 4,
	add: 5,
	remove: 6,
	order: 7,
	vote: 8,
	promote: 9,
	chat: 11,
	settings: 13,
	playNow: 14,
	shuffle: 15,
	speed: 16,
	kick: 18,
	update: 19,
	temporary: 20,
};
let mf;
let persistence;
let db;
let grants = 0;
let outboundCalls = [];
let slowGate;
let slowStarted;

function box(type, payload) {
	const header = Buffer.alloc(8);
	header.writeUInt32BE(payload.length + 8);
	header.write(type, 4);
	return Buffer.concat([header, payload]);
}
const time = Buffer.alloc(24);
time.writeUInt32BE(1000, 12);
time.writeUInt32BE(120_000, 16);
const handler = Buffer.alloc(24);
handler.write("vide", 8);
const mp4 = Buffer.concat([
	box("ftyp", Buffer.from("isom0000isom")),
	box("mdat", Buffer.alloc(8192)),
	box("moov", Buffer.concat([box("mvhd", time), box("trak", box("mdia", box("hdlr", handler)))])),
]);
const largeIndexMp4 = Buffer.concat([
	box("ftyp", Buffer.from("isom0000isom")),
	box("mdat", Buffer.alloc(8192)),
	box(
		"moov",
		Buffer.concat([
			box("mvhd", time),
			box(
				"trak",
				box(
					"mdia",
					Buffer.concat([
						box("hdlr", handler),
						box("minf", Buffer.alloc(3 * 1024 * 1024)),
					]),
				),
			),
		]),
	),
]);
const audioHandler = Buffer.from(handler);
audioHandler.write("soun", 8);
const longTime = Buffer.alloc(32);
longTime[0] = 1;
longTime.writeUInt32BE(1000, 20);
longTime.writeBigUInt64BE(1421090n, 24);
const audioTrack = box(
	"trak",
	box(
		"mdia",
		Buffer.concat([box("hdlr", audioHandler), box("minf", Buffer.alloc(3 * 1024 * 1024))]),
	),
);
const metadataFixtures = new Map([
	["/large-index.mp4", largeIndexMp4],
	["/audio-only.mp4", box("moov", Buffer.concat([box("mvhd", longTime), audioTrack]))],
	[
		"/audio-first.mp4",
		box(
			"moov",
			Buffer.concat([
				box("mvhd", longTime),
				audioTrack,
				box("trak", box("mdia", box("hdlr", handler))),
			]),
		),
	],
	["/bad-box.mp4", box("moov", Buffer.from([0, 0, 255, 255, 109, 118, 104, 100]))],
]);

async function outbound(request) {
	const url = new URL(request.url);
	outboundCalls.push({ url: url.href, range: request.headers.get("range") });
	if (url.origin !== mediaOrigin) {
		throw new Error(`Unexpected outbound request: ${url.origin}`);
	}
	if (url.pathname === "/private.mp4") {
		return new Response(null, {
			status: 302,
			headers: { Location: "http://127.0.0.1/private.mp4" },
		});
	}
	if (url.pathname === "/redirect.m3u8") {
		return new Response(null, { status: 302, headers: { Location: "/moved/master.m3u8" } });
	}
	if (url.pathname === "/moved/master.m3u8") {
		return new Response("#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=400000\nchild.m3u8\n");
	}
	if (url.pathname === "/oversized.m3u8") {
		return new Response(
			`#EXTM3U\n#EXTINF:1,\none.ts\n#${"x".repeat(2 * 1024 * 1024)}\n#EXT-X-ENDLIST\n`,
		);
	}
	if (url.pathname === "/invalid.json") {
		return new Response("{");
	}
	if (url.pathname === "/zero.json") {
		return new Response(
			JSON.stringify({
				title: "Empty",
				duration: 0,
				sources: [
					{ url: `${mediaOrigin}/one.mp4`, contentType: "video/mp4", quality: 720 },
				],
			}),
		);
	}
	if (url.pathname === "/master.m3u8") {
		return new Response("#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=400000\nchild/vod.m3u8\n");
	}
	if (url.pathname.endsWith(".m3u8")) {
		return new Response(
			"#EXTM3U\n#EXTINF:6.5,\none.ts\n#EXTINF:5.5,\ntwo.ts\n#EXT-X-ENDLIST\n",
		);
	}
	if (url.pathname.endsWith(".mpd")) {
		return new Response('<MPD mediaPresentationDuration="PT1M30S"><Period /></MPD>');
	}
	if (url.pathname.endsWith(".json")) {
		return new Response(
			JSON.stringify({
				title: "Fixture manifest",
				duration: 120,
				sources: [
					{ url: `${mediaOrigin}/one.mp4`, contentType: "video/mp4", quality: 720 },
				],
			}),
		);
	}
	if (url.pathname === "/slow.mp4") {
		slowStarted?.resolve();
		await slowGate?.promise;
	}
	if (url.pathname === "/broken.mp4") {
		return new Response("not a movie", { status: 404 });
	}
	const range = RANGE.exec(request.headers.get("range") ?? "");
	const file = metadataFixtures.get(url.pathname) ?? mp4;
	if (!range || url.pathname === "/no-range.mp4") {
		return new Response(file, { headers: { "Content-Length": String(file.length) } });
	}
	const start = Number(range[1]);
	const end = Math.min(Number(range[2]), file.length - 1);
	return new Response(file.subarray(start, end + 1), {
		status: 206,
		headers: {
			"Content-Range": `bytes ${url.pathname === "/bad-range.mp4" ? start + 1 : start}-${end}/${file.length}`,
			"Content-Length": String(end - start + 1),
			"Content-Type": "video/mp4",
		},
	});
}

function options() {
	return convertV4MiniflareOptions({
		name: "ott-edge-test",
		modules: true,
		scriptPath: path.join(root, "dist/index.js"),
		compatibilityDate: "2026-09-08",
		compatibilityFlags: ["nodejs_compat"],
		bindings: {
			OTT_INSTANCE_ID: "test",
			OTT_CLIENT_REVISION: "test-revision",
			ROOM_IDLE_SECONDS: "2",
		},
		d1Databases: { DB: "test-database" },
		durableObjects: {
			ROOMS: { className: "RoomObject", useSQLite: true },
			MAINTENANCE: { className: "MaintenanceObject", useSQLite: true },
		},
		resourcePersistencePath: persistence,
		unsafeInspectDurableObjects: true,
		outboundService: outbound,
		serviceBindings: { ASSETS: () => new Response("test asset") },
		cf: false,
		telemetry: { enabled: false },
		log: new Log(LogLevel.ERROR),
	});
}

before(async () => {
	persistence = await mkdtemp(path.join(tmpdir(), "ott-edge-test-"));
	mf = new Miniflare(options());
	await mf.ready;
	db = await mf.getD1Database("DB");
	const migration = await readFile(path.join(root, "migrations/0001_initial.sql"), "utf8");
	await db.batch(
		migration
			.split(";")
			.map(statement => statement.trim())
			.filter(Boolean)
			.map(statement => db.prepare(statement)),
	);
});
after(async () => {
	await mf?.dispose();
	if (persistence) {
		await rm(persistence, { recursive: true, force: true });
	}
});

async function request(route, token, method = "GET", body, headers = {}) {
	return mf.dispatchFetch(`${origin}/api${route}`, {
		method,
		headers: {
			...(token ? { Authorization: `Bearer ${token}` } : {}),
			...(body === undefined ? {} : { "Content-Type": "application/json" }),
			...headers,
		},
		...(body === undefined ? {} : { body: JSON.stringify(body) }),
	});
}
async function identity() {
	const response = await request("/auth/grant", null, "GET", undefined, {
		"CF-Connecting-IP": `203.0.113.${++grants}`,
	});
	assert.equal(response.status, 200);
	return (await response.json()).token;
}
async function create(t, token, options = {}) {
	const name = `test-${crypto.randomUUID().slice(0, 12)}`;
	const response = await request("/room/create", token, "POST", {
		name,
		isTemporary: false,
		visibility: "unlisted",
		...options,
	});
	assert.equal(response.status, 201, JSON.stringify(await response.json()));
	t.after(async () => {
		await request(`/room/${name}`, token, "DELETE");
	});
	return name;
}

class Peer {
	messages = [];
	cursor = 0;
	listeners = new Set();
	state = {};
	users = [];
	id;
	closed;
	constructor(socket) {
		this.socket = socket;
		socket.addEventListener("message", event => {
			if (event.data === "pong") {
				return;
			}
			const message = JSON.parse(event.data);
			this.messages.push(message);
			if (message.action === "sync") {
				Object.assign(this.state, message);
			}
			if (message.action === "you") {
				this.id = message.info.id;
			}
			if (message.action === "user" && message.update.kind === "init") {
				this.users = message.update.value;
			}
			for (const callback of this.listeners) {
				callback();
			}
		});
		socket.addEventListener("close", event => {
			this.closed = event.code;
			for (const callback of this.listeners) {
				callback();
			}
		});
		socket.accept();
	}
	send(message) {
		const start = this.messages.length;
		this.socket.send(JSON.stringify(message));
		return start;
	}
	req(type, fields = {}) {
		return this.send({ action: "req", request: { type, ...fields } });
	}
	async wait(predicate, start = this.cursor) {
		return new Promise((resolve, reject) => {
			const timeout = setTimeout(() => {
				this.listeners.delete(check);
				reject(
					new Error(
						`Message not received; close=${this.closed}; received=${JSON.stringify(this.messages.slice(start))}`,
					),
				);
			}, 5000);
			const check = () => {
				const index = this.messages.findIndex(
					(message, index) => index >= start && predicate(message),
				);
				if (index < 0) {
					return;
				}
				clearTimeout(timeout);
				this.listeners.delete(check);
				this.cursor = index + 1;
				resolve(this.messages[index]);
			};
			this.listeners.add(check);
			check();
		});
	}
	close() {
		try {
			this.socket.close(1000, "test complete");
		} catch {
			/* Already closed by the server. */
		}
	}
	async waitClosed() {
		if (this.closed !== undefined) {
			return this.closed;
		}
		return new Promise((resolve, reject) => {
			const timeout = setTimeout(() => {
				this.listeners.delete(check);
				reject(new Error("Socket did not close"));
			}, 5000);
			const check = () => {
				if (this.closed === undefined) {
					return;
				}
				clearTimeout(timeout);
				this.listeners.delete(check);
				resolve(this.closed);
			};
			this.listeners.add(check);
			check();
		});
	}
}
async function connect(t, name, token) {
	const response = await request(`/room/${name}`, null, "GET", undefined, {
		Upgrade: "websocket",
		Origin: origin,
	});
	assert.equal(response.status, 101);
	const peer = new Peer(response.webSocket);
	t.after(() => peer.close());
	peer.send({ action: "auth", token });
	await peer.wait(message => message.action === "sync" && message.name === name);
	return peer;
}
async function add(name, token, file = "one.mp4") {
	const service = file.endsWith(".m3u8") ? "hls" : file.endsWith(".mpd") ? "dash" : "direct";
	const response = await request(`/room/${name}/queue`, token, "POST", {
		service,
		id: `${mediaOrigin}/${file}`,
	});
	assert.equal(response.status, 200, JSON.stringify(await response.json()));
}

it("maintenance starts from a request and cleans only expired D1 records through its own alarm", async () => {
	const expiry = Date.now() + 60_000;
	await db.batch([
		db.prepare("INSERT INTO sessions VALUES ('expired-session', 'old', 'old', 1)"),
		db
			.prepare("INSERT INTO sessions VALUES ('current-session', 'current', 'current', ?)")
			.bind(expiry),
		db.prepare("INSERT INTO media_cache VALUES ('expired-media', '{}', 1)"),
		db.prepare("INSERT INTO media_cache VALUES ('current-media', '{}', ?)").bind(expiry),
		db.prepare("INSERT INTO rate_limits VALUES ('expired-limit', 1, 1)"),
		db.prepare("INSERT INTO rate_limits VALUES ('current-limit', 1, ?)").bind(expiry),
		db.prepare(
			"INSERT INTO rooms (name, instance_id, owner_id, title, visibility, is_temporary, queue_mode, expires_at, created_at) VALUES ('orphaned-room', 'never-initialized', 'old', 'Orphan', 'unlisted', 1, 'manual', 1, 1)",
		),
	]);
	assert.equal((await request("/status")).status, 200);
	let expired = 1;
	for (let attempt = 0; attempt < 30 && expired; attempt++) {
		await new Promise(resolve => setTimeout(resolve, 100));
		expired = (
			await db
				.prepare(
					"SELECT (SELECT COUNT(*) FROM sessions WHERE token_hash = 'expired-session') + (SELECT COUNT(*) FROM rooms WHERE name = 'orphaned-room') AS count",
				)
				.first()
		).count;
	}
	assert.equal(expired, 0);
	assert.equal(
		(
			await db
				.prepare(
					"SELECT COUNT(*) AS count FROM media_cache WHERE cache_key = 'expired-media'",
				)
				.first()
		).count,
		0,
	);
	assert.equal(
		(
			await db
				.prepare(
					"SELECT COUNT(*) AS count FROM rate_limits WHERE limit_key = 'expired-limit'",
				)
				.first()
		).count,
		0,
	);
	assert.equal(
		(
			await db
				.prepare(
					"SELECT COUNT(*) AS count FROM sessions WHERE token_hash = 'current-session'",
				)
				.first()
		).count,
		1,
	);
	assert.equal(
		(
			await db
				.prepare(
					"SELECT COUNT(*) AS count FROM media_cache WHERE cache_key = 'current-media'",
				)
				.first()
		).count,
		1,
	);
	assert.equal(
		(
			await db
				.prepare(
					"SELECT COUNT(*) AS count FROM rate_limits WHERE limit_key = 'current-limit'",
				)
				.first()
		).count,
		1,
	);
});

it("health and asset routing return the expected version without caching API data", async () => {
	const health = await request("/status");
	assert.equal(health.status, 200);
	assert.equal((await health.json()).backend, "cloudflare");
	assert.match(health.headers.get("Cache-Control"), NO_STORE);
	assert.deepEqual(await (await request("/status/version")).json(), {
		revision: "test-revision",
	});
	assert.equal(await (await mf.dispatchFetch(origin)).text(), "test asset");
});

it("grant reuses a valid bearer identity and issues a secure isolated cookie", async () => {
	const token = await identity();
	const response = await request("/auth/grant", token);
	assert.equal((await response.json()).token, token);
	assert.match(response.headers.get("Set-Cookie"), SECURE_COOKIE);
	const user = await request("/user", null, "GET", undefined, {
		Cookie: `ott_edge_preview_token=${token}`,
	});
	assert.equal(user.status, 200);
	assert.equal((await user.json()).loggedIn, false);
	const row = await db
		.prepare("SELECT token_hash FROM sessions WHERE token_hash = ?")
		.bind(token)
		.first();
	assert.equal(row, null, "plaintext bearer tokens are not stored");
});

it("missing identities, cross-site origins, malformed JSON and oversized requests are rejected", async () => {
	assert.equal((await request("/room/create", null, "POST", { name: "absent" })).status, 401);
	const token = await identity();
	assert.equal(
		(
			await request(
				"/room/create",
				token,
				"POST",
				{ name: "cross-site" },
				{ Origin: "https://other.example.org" },
			)
		).status,
		403,
	);
	assert.equal(
		(await request("/auth/grant", null, "GET", undefined, { "Sec-Fetch-Site": "cross-site" }))
			.status,
		403,
	);
	const broken = await mf.dispatchFetch(`${origin}/api/room/create`, {
		method: "POST",
		headers: { Authorization: `Bearer ${token}` },
		body: "{",
	});
	assert.equal(broken.status, 400);
	assert.equal(
		(
			await request("/room/create", token, "POST", {
				name: "long-body",
				description: "x".repeat(66000),
			})
		).status,
		413,
	);
});

it("concurrent creation reserves one canonical room and rejects unsupported settings", async t => {
	const owner = await identity();
	const name = `race-${crypto.randomUUID().slice(0, 8)}`;
	const responses = await Promise.all(
		[name, name.toUpperCase()].map(value =>
			request("/room/create", owner, "POST", { name: value }),
		),
	);
	assert.deepEqual(responses.map(response => response.status).sort(), [201, 409]);
	t.after(() => request(`/room/${name}`, owner, "DELETE"));
	assert.equal((await request("/room/create", owner, "POST", { name: "LIST" })).status, 400);
	assert.equal(
		(
			await request("/room/create", owner, "POST", {
				name: "private-room",
				visibility: "private",
			})
		).status,
		400,
	);
	assert.equal(
		(await request("/room/create", owner, "POST", { name: "dj-room", queueMode: "dj" })).status,
		400,
	);
});

it("public discovery, guest ownership and deletion respect room boundaries", async t => {
	const owner = await identity();
	const stranger = await identity();
	const publicRoom = await create(t, owner, { visibility: "public" });
	const unlisted = await create(t, owner);
	const list = await (await request("/room/list", stranger)).json();
	assert.ok(list.some(room => room.name === publicRoom));
	assert.ok(!list.some(room => room.name === unlisted));
	const owned = await (await request("/user/owned-rooms", owner)).json();
	assert.deepEqual(owned.data.map(room => room.name).sort(), [publicRoom, unlisted].sort());
	assert.equal((await request(`/room/${unlisted}`, stranger, "DELETE")).status, 403);
	assert.equal((await request(`/room/${unlisted}`, owner, "DELETE")).status, 200);
	assert.equal((await request(`/room/${unlisted}`, owner)).status, 404);
});

it("MP4 tail indexes, HLS variants, DASH and custom manifests produce bounded metadata and cache hits", async () => {
	const owner = await identity();
	for (const [file, service, length] of [
		["metadata.mp4", "direct", 120],
		["master.m3u8", "hls", 12],
		["vod.mpd", "dash", 90],
		["custom.json", "direct", 120],
	]) {
		const route = `/data/previewAdd?input=${encodeURIComponent(`${mediaOrigin}/${file}`)}`;
		const response = await request(route, owner);
		assert.equal(response.status, 200, JSON.stringify(await response.clone().json()));
		const video = (await response.json()).result[0];
		assert.equal(video.service, service);
		assert.equal(video.length, length);
		const count = outboundCalls.length;
		assert.equal((await request(route, owner)).status, 200);
		assert.equal(outboundCalls.length, count, "cache avoids repeated external probes");
	}
	assert.ok(outboundCalls.some(call => call.range?.startsWith("bytes=8220-")));
});

it("MP4 metadata skips large sample tables and reuses already fetched box headers", async () => {
	const owner = await identity();
	const before = outboundCalls.length;
	const response = await request(
		`/data/previewAdd?input=${encodeURIComponent(`${mediaOrigin}/large-index.mp4`)}`,
		owner,
	);
	assert.equal(response.status, 200);
	const data = await response.json();
	assert.equal(data.result[0].length, 120);
	assert.equal(data.result[0].mime, "video/mp4");
	const calls = outboundCalls.slice(before);
	assert.equal(calls.length, 2, "one file header read and one tail metadata read");
	assert.ok(
		calls.every(call => {
			const [, start, end] = RANGE.exec(call.range);
			return Number(end) - Number(start) + 1 <= 4096;
		}),
	);
});

it("MP4 sparse metadata reads handle 64-bit durations and audio before video", async () => {
	const owner = await identity();
	for (const [file, mime] of [
		["audio-only.mp4", "audio/mp4"],
		["audio-first.mp4", "video/mp4"],
	]) {
		const before = outboundCalls.length;
		const response = await request(
			`/data/previewAdd?input=${encodeURIComponent(`${mediaOrigin}/${file}`)}`,
			owner,
		);
		assert.equal(response.status, 200);
		const data = await response.json();
		assert.equal(data.result[0].length, 1421.09);
		assert.equal(data.result[0].mime, mime);
		assert.ok(outboundCalls.length - before <= 2);
	}
});

it("invalid range responses, failed media and redirects to private addresses are rejected", async () => {
	const owner = await identity();
	for (const input of [
		`${mediaOrigin}/bad-range.mp4`,
		`${mediaOrigin}/bad-box.mp4`,
		`${mediaOrigin}/no-range.mp4`,
		`${mediaOrigin}/private.mp4`,
		`${mediaOrigin}/broken.mp4`,
		"http://127.0.0.1/video.mp4",
		"http://[::1]/video.mp4",
		"https://localhost/video.mp4",
		"https://user:password@media.example.org/one.mp4",
		"javascript:alert(1)",
	]) {
		assert.equal(
			(await request(`/data/previewAdd?input=${encodeURIComponent(input)}`, owner)).status,
			400,
			input,
		);
	}
});

it("redirected HLS uses the final manifest location and rejects oversized or invalid manifests", async () => {
	const owner = await identity();
	const redirected = await request(
		`/data/previewAdd?input=${encodeURIComponent(`${mediaOrigin}/redirect.m3u8`)}`,
		owner,
	);
	assert.equal(redirected.status, 200);
	assert.ok(outboundCalls.some(call => call.url === `${mediaOrigin}/moved/child.m3u8`));
	for (const file of ["oversized.m3u8", "invalid.json", "zero.json"]) {
		assert.equal(
			(
				await request(
					`/data/previewAdd?input=${encodeURIComponent(`${mediaOrigin}/${file}`)}`,
					owner,
				)
			).status,
			400,
			file,
		);
	}
});

it("pending sockets cannot see room state and invalid or expired credentials close with the auth code", async t => {
	const owner = await identity();
	const name = await create(t, owner);
	const response = await request(`/room/${name}`, null, "GET", undefined, {
		Upgrade: "websocket",
	});
	const unauthenticated = new Peer(response.webSocket);
	t.after(() => unauthenticated.close());
	const a = await connect(t, name, owner);
	a.req(R.chat, { text: "authenticated-only" });
	await a.wait(message => message.action === "chat");
	assert.equal(unauthenticated.messages.length, 0);
	unauthenticated.send({ action: "auth", token: "a".repeat(64) });
	assert.equal(await unauthenticated.waitClosed(), 4004);
	const expired = await identity();
	const hash = Buffer.from(
		await crypto.subtle.digest("SHA-256", new TextEncoder().encode(expired)),
	).toString("hex");
	await db.prepare("UPDATE sessions SET expires_at = 1 WHERE token_hash = ?").bind(hash).run();
	const second = await request(`/room/${name}`, null, "GET", undefined, { Upgrade: "websocket" });
	const peer = new Peer(second.webSocket);
	t.after(() => peer.close());
	peer.send({ action: "auth", token: expired });
	assert.equal(await peer.waitClosed(), 4004);
});

it("malformed frames are reported safely and oversized frames close without crashing the room", async t => {
	const owner = await identity();
	const name = await create(t, owner);
	const a = await connect(t, name, owner);
	const start = a.messages.length;
	a.socket.send("{");
	await a.wait(message => message.action === "eventcustom", start);
	a.socket.send("x".repeat(65537));
	assert.equal(await a.waitClosed(), 1009);
	const b = await connect(t, name, owner);
	assert.equal(b.state.name, name);
});

it("nickname changes reach every tab of the identity and roles survive reconnection", async t => {
	const owner = await identity();
	const guest = await identity();
	const name = await create(t, owner);
	const a = await connect(t, name, owner);
	const b = await connect(t, name, guest);
	const c = await connect(t, name, guest);
	assert.equal((await request("/user", guest, "POST", { username: "测试观众" })).status, 200);
	const renamed = c.messages.length;
	b.send({ action: "notify", message: "usernameChanged" });
	await c.wait(
		message => message.action === "user" && message.update.value?.name === "测试观众",
		renamed,
	);
	const promoted = b.messages.length;
	a.req(R.promote, { targetClientId: b.id, role: 3 });
	await b.wait(
		message =>
			message.action === "user" &&
			message.update.value?.id === b.id &&
			message.update.value.role === 3,
		promoted,
	);
	b.close();
	c.close();
	await new Promise(resolve => setTimeout(resolve, 60));
	const rejoined = await connect(t, name, guest);
	assert.equal(rejoined.users.find(user => user.id === rejoined.id).role, 3);
	assert.equal(rejoined.users.find(user => user.id === rejoined.id).name, "测试观众");
});

it("kick protects the owner, removes a guest and updates membership", async t => {
	const owner = await identity();
	const guest = await identity();
	const name = await create(t, owner);
	const a = await connect(t, name, owner);
	const b = await connect(t, name, guest);
	const denied = b.req(R.kick, { clientId: a.id });
	await b.wait(message => message.action === "eventcustom", denied);
	a.req(R.kick, { clientId: b.id });
	assert.equal(await b.waitClosed(), 4005);
	assert.equal((await (await request(`/room/${name}`, owner)).json()).users.length, 1);
});

it("slow media probing does not block pause and late socket commands cannot act after departure", async t => {
	const owner = await identity();
	const guest = await identity();
	const name = await create(t, owner);
	const a = await connect(t, name, owner);
	const b = await connect(t, name, guest);
	await add(name, owner);
	await a.wait(message => message.action === "sync" && message.currentSource);
	slowGate = Promise.withResolvers();
	slowStarted = Promise.withResolvers();
	t.after(() => slowGate.resolve());
	a.req(R.playNow, { video: { service: "direct", id: `${mediaOrigin}/slow.mp4` } });
	await slowStarted.promise;
	const paused = b.req(R.play, { state: false });
	await b.wait(message => message.action === "sync" && message.isPlaying === false, paused);
	a.close();
	await a.waitClosed();
	slowGate.resolve();
	// A round trip after metadata finishes observes any incorrectly applied late command.
	await new Promise(resolve => setTimeout(resolve, 80));
	const c = await connect(t, name, owner);
	assert.equal(c.state.currentSource.id, `${mediaOrigin}/one.mp4`);
	assert.equal(c.state.isPlaying, false);
});

it("a batch of expensive probes shares a request budget and cannot partially modify the queue", async t => {
	const owner = await identity();
	const name = await create(t, owner);
	const before = outboundCalls.length;
	const response = await request(`/room/${name}/queue`, owner, "POST", {
		videos: Array.from({ length: 10 }, (_, index) => ({
			service: "direct",
			id: `${mediaOrigin}/budget-${index}.mp4`,
		})),
	});
	assert.equal(response.status, 400);
	assert.ok(outboundCalls.length - before <= 16);
	assert.deepEqual((await (await request(`/room/${name}`, owner)).json()).queue, []);
});

it("deleted names can be reused with a new object and no old playback or permissions", async t => {
	const owner = await identity();
	const name = await create(t, owner);
	const a = await connect(t, name, owner);
	await add(name, owner);
	await a.wait(message => message.action === "sync" && message.currentSource);
	const old = await db.prepare("SELECT instance_id FROM rooms WHERE name = ?").bind(name).first();
	assert.equal((await request(`/room/${name}`, owner, "DELETE")).status, 200);
	assert.equal(await a.waitClosed(), 4003);
	assert.equal(
		(await request("/room/create", owner, "POST", { name, isTemporary: false })).status,
		201,
	);
	const fresh = await db
		.prepare("SELECT instance_id FROM rooms WHERE name = ?")
		.bind(name)
		.first();
	assert.notEqual(fresh.instance_id, old.instance_id);
	const b = await connect(t, name, owner);
	assert.equal(b.state.currentSource, null);
	assert.deepEqual(b.state.queue, []);
});

it("two viewers receive the same source, play/pause, seek, speed and chat updates", async t => {
	const owner = await identity();
	const guest = await identity();
	const name = await create(t, owner);
	const a = await connect(t, name, owner);
	const b = await connect(t, name, guest);
	assert.equal(a.users.find(user => user.id === a.id).role, -1);
	assert.equal(b.users.find(user => user.id === b.id).role, 0);
	await add(name, owner);
	await a.wait(
		message => message.action === "sync" && message.currentSource?.id.endsWith("one.mp4"),
	);
	await b.wait(
		message => message.action === "sync" && message.currentSource?.id.endsWith("one.mp4"),
	);
	let start = b.messages.length;
	a.req(R.play, { state: false });
	await b.wait(message => message.action === "sync" && message.isPlaying === false, start);
	start = b.messages.length;
	a.req(R.seek, { value: 42 });
	assert.equal(
		(
			await b.wait(
				message => message.action === "sync" && message.playbackPosition === 42,
				start,
			)
		).playbackPosition,
		42,
	);
	start = b.messages.length;
	a.req(R.speed, { speed: 1.5 });
	await b.wait(message => message.action === "sync" && message.playbackSpeed === 1.5, start);
	start = b.messages.length;
	a.req(R.chat, { text: "同步测试" });
	assert.equal((await b.wait(message => message.action === "chat", start)).text, "同步测试");
	const state = await (await request(`/room/${name}`, owner)).json();
	assert.equal(state.users.length, 2);
	assert.equal(
		state.action,
		undefined,
		"room settings API does not leak sync-only fields into form submissions",
	);
});

it("queue edits accept the existing frontend shape, including clearing subtitles", async t => {
	const owner = await identity();
	const name = await create(t, owner);
	const peer = await connect(t, name, owner);
	await add(name, owner);
	await add(name, owner, "second.mp4");
	const video = { service: "direct", id: `${mediaOrigin}/second.mp4` };
	assert.equal(
		(
			await request(`/room/${name}/queue`, owner, "PATCH", {
				...video,
				subtitleUrl: `${mediaOrigin}/captions.vtt`,
			})
		).status,
		200,
	);
	let state = await (await request(`/room/${name}`, owner)).json();
	assert.equal(state.queue[0].subtitleUrl, `${mediaOrigin}/captions.vtt`);
	assert.equal(
		(await request(`/room/${name}/queue`, owner, "PATCH", { ...video, subtitleUrl: "" }))
			.status,
		200,
	);
	state = await (await request(`/room/${name}`, owner)).json();
	assert.equal(state.queue[0].subtitleUrl, undefined);
	const start = peer.messages.length;
	peer.req(R.playNow, { video });
	await peer.wait(
		message => message.action === "sync" && message.currentSource?.id === video.id,
		start,
	);
	assert.equal(peer.state.queue[0].id, `${mediaOrigin}/one.mp4`);
});

it("owner permissions apply to HTTP and WebSocket controls without blocking unchanged grants", async t => {
	const owner = await identity();
	const guest = await identity();
	const name = await create(t, owner);
	const a = await connect(t, name, owner);
	const b = await connect(t, name, guest);
	const state = await (await request(`/room/${name}`, owner)).json();
	assert.equal(
		(
			await request(`/room/${name}`, guest, "PATCH", {
				title: "Guest title",
				grants: state.grants,
			})
		).status,
		200,
	);
	assert.equal(
		(await request(`/room/${name}`, guest, "PATCH", { grants: [[0, 0]] })).status,
		403,
	);
	await add(name, owner);
	assert.equal(
		(await request(`/room/${name}`, owner, "PATCH", { grants: [[0, 128]] })).status,
		200,
	);
	assert.equal(
		(
			await request(`/room/${name}/queue`, guest, "POST", {
				service: "direct",
				id: `${mediaOrigin}/second.mp4`,
			})
		).status,
		403,
	);
	const start = b.req(R.seek, { value: 80 });
	await b.wait(
		message => message.action === "eventcustom" && message.text.includes("权限"),
		start,
	);
	const ownerStart = a.req(R.seek, { value: 12 });
	await a.wait(
		message => message.action === "sync" && message.playbackPosition >= 12,
		ownerStart,
	);
});

it("hibernation retains sockets, roles and playback without duplicating membership", async t => {
	const owner = await identity();
	const guest = await identity();
	const name = await create(t, owner);
	const a = await connect(t, name, owner);
	const b = await connect(t, name, guest);
	await add(name, owner);
	await a.wait(message => message.action === "sync" && message.currentSource);
	const row = await db.prepare("SELECT instance_id FROM rooms WHERE name = ?").bind(name).first();
	await mf.unsafeEvictDurableObject("ott-edge-test", "RoomObject", {
		name: row.instance_id,
		webSockets: "hibernate",
	});
	const start = b.messages.length;
	a.req(R.seek, { value: 25 });
	await b.wait(message => message.action === "sync" && message.playbackPosition >= 25, start);
	assert.equal((await (await request(`/room/${name}`, owner)).json()).users.length, 2);
	assert.equal(a.closed, undefined);
	assert.equal(b.closed, undefined);
});

it("leaving an active room pauses it and only the assigned viewer's matching preparation resumes playback", async t => {
	const owner = await identity();
	const name = await create(t, owner);
	const a = await connect(t, name, owner);
	await add(name, owner);
	await a.wait(message => message.action === "sync" && message.currentSource);
	const start = a.req(R.seek, { value: 42 });
	await a.wait(message => message.action === "sync" && message.playbackPosition >= 42, start);
	a.close();
	await new Promise(resolve => setTimeout(resolve, 60));
	const b = await connect(t, name, owner);
	assert.equal(b.state.isPlaying, false);
	const preparation = b.state.playbackPreparation;
	assert.ok(preparation);
	assert.equal(preparation.clientId, b.id);
	assert.ok(Math.abs(preparation.position - 42) < 1);
	b.send({
		action: "status",
		status: "ready",
		playbackPrepared: { id: "stale", position: preparation.position },
	});
	await b.wait(message => message.action === "user");
	assert.equal(b.state.isPlaying, false);
	const preparedStart = b.send({
		action: "status",
		status: "ready",
		playbackPrepared: { id: preparation.id, position: preparation.position },
	});
	await b.wait(
		message =>
			message.action === "sync" &&
			message.isPlaying === true &&
			message.playbackPreparation === null,
		preparedStart,
	);
});

it("playback completion advances the queue through an alarm without another client command", async t => {
	const owner = await identity();
	const name = await create(t, owner);
	const a = await connect(t, name, owner);
	const b = await connect(t, name, await identity());
	await add(name, owner);
	await add(name, owner, "auto-next.mp4");
	let start = a.req(R.play, { state: false });
	await a.wait(message => message.action === "sync" && message.isPlaying === false, start);
	start = a.req(R.seek, { value: 119.8 });
	await a.wait(message => message.action === "sync" && message.playbackPosition === 119.8, start);
	const nextAtA = a.messages.length;
	const nextAtB = b.messages.length;
	a.req(R.play, { state: true });
	const changed = message =>
		message.action === "sync" && message.currentSource?.id.endsWith("auto-next.mp4");
	await a.wait(changed, nextAtA);
	await b.wait(changed, nextAtB);
	assert.deepEqual(b.state.queue, []);
	assert.equal(b.state.isPlaying, true);
	assert.ok(b.state.playbackPosition < 1);
});

it("manual pause remains paused on re-entry and a temporary speed restores when its owner leaves", async t => {
	const owner = await identity();
	const name = await create(t, owner);
	const a = await connect(t, name, owner);
	await add(name, owner);
	await a.wait(message => message.action === "sync" && message.currentSource);
	let start = a.req(R.temporary, {
		action: "start",
		gestureId: "gesture-1",
		video: { service: "direct", id: `${mediaOrigin}/one.mp4` },
	});
	await a.wait(message => message.action === "sync" && message.playbackSpeed === 2, start);
	start = a.req(R.play, { state: false });
	await a.wait(message => message.action === "sync" && message.isPlaying === false, start);
	a.close();
	await new Promise(resolve => setTimeout(resolve, 60));
	const b = await connect(t, name, owner);
	assert.equal(b.state.playbackSpeed, 1);
	assert.equal(b.state.isPlaying, false);
	assert.equal(b.state.playbackPreparation, null);
});

it("temporary rooms expire through alarms while permanent rooms retain their queue", async t => {
	const owner = await identity();
	const temporary = await create(t, owner, { isTemporary: true });
	const permanent = await create(t, owner);
	await add(permanent, owner);
	await add(permanent, owner, "second.mp4");
	await new Promise(resolve => setTimeout(resolve, 2400));
	assert.equal((await request(`/room/${temporary}`, owner)).status, 404);
	const row = await db.prepare("SELECT name FROM rooms WHERE name = ?").bind(temporary).first();
	assert.equal(row, null);
	const peer = await connect(t, permanent, owner);
	assert.equal(peer.state.currentSource.id, `${mediaOrigin}/one.mp4`);
	assert.equal(peer.state.queue.length, 1);
	assert.equal(peer.state.isPlaying, false);
	assert.ok(peer.state.playbackPreparation);
});

it("a full runtime restart retains D1 identities and durable room state", async t => {
	const owner = await identity();
	const name = await create(t, owner);
	const a = await connect(t, name, owner);
	await add(name, owner);
	await add(name, owner, "second.mp4");
	let start = a.req(R.play, { state: false });
	await a.wait(message => message.action === "sync" && message.isPlaying === false, start);
	start = a.req(R.seek, { value: 31 });
	await a.wait(message => message.action === "sync" && message.playbackPosition === 31, start);
	await mf.dispose();
	mf = new Miniflare(options());
	await mf.ready;
	db = await mf.getD1Database("DB");
	assert.equal((await request("/user", owner)).status, 200);
	const b = await connect(t, name, owner);
	assert.equal(b.state.isPlaying, false);
	assert.equal(b.state.playbackPosition, 31);
	assert.equal(b.state.queue.length, 1);
	assert.equal(b.users.find(user => user.id === b.id).role, -1);
});
