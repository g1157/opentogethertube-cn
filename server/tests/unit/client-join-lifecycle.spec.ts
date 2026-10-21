import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClientInfo, OttWebsocketError } from "ott-common/models/types.js";
import { Role } from "ott-common/models/types.js";
import { ok } from "ott-common/result.js";
import { Client, ClientJoinStatus } from "../../client.js";
import clientmanager from "../../clientmanager.js";
import { Room, RoomUser } from "../../room.js";
import roommanager from "../../roommanager.js";
import tokens from "../../auth/tokens.js";
import type { SessionInfo } from "../../auth/tokens.js";
import { RoomRequestType } from "ott-common/models/messages.js";
import { buildClients } from "../../redisclient.js";

class JoiningGuest extends Client {
	sendRaw = vi.fn();
	get clientType() {
		return "test";
	}
	kick(_code: OttWebsocketError): void {
		this.emit("disconnect", this);
	}
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>(_resolve => {
		resolve = _resolve;
	});
	return { promise, resolve };
}

describe("disconnects while joining a room", () => {
	let room: Room;
	const clients: JoiningGuest[] = [];
	const settle = () => new Promise<void>(resolve => setImmediate(resolve));

	beforeAll(async () => {
		await buildClients();
	});
	beforeEach(() => {
		room = new Room({ name: "cancelled-first-viewer", isTemporary: true });
		room.currentSource = { service: "direct", id: "episode.mp4", length: 600 };
		room.playbackPosition = 125;
		room.resumeOnNextJoin = true;
		vi.spyOn(room, "publish").mockResolvedValue(undefined);
		vi.spyOn(roommanager, "getRoom").mockResolvedValue(ok(room));
		vi.spyOn(tokens, "getSessionInfo").mockResolvedValue({
			isLoggedIn: false,
			username: "guest",
		});
	});
	afterEach(async () => {
		for (const client of clients.splice(0)) {
			// A disconnect during the test may already have removed the connection.
			if (clientmanager.getClient(client.id)) {
				client.emit("disconnect", client);
			}
		}
		await settle();
		room.throttledSync.cancel();
		room.saveStateToRedisDebounced.cancel();
		vi.restoreAllMocks();
	});

	function authenticate(name: string) {
		const client = new JoiningGuest(room.name);
		clients.push(client);
		client.token = `test-${name}`;
		client.session = { isLoggedIn: false, username: name };
		client.joinStatus = ClientJoinStatus.Joined;
		clientmanager.addClient(client);
		client.emit("auth", client, client.token, client.session);
		return client;
	}

	it("does not start a join or send state if the socket closed while room lookup was pending", async () => {
		const lookup = deferred<ReturnType<typeof ok<Room>>>();
		vi.mocked(roommanager.getRoom).mockReturnValueOnce(lookup.promise);
		const join = vi.spyOn(room, "joinRoom");
		const client = authenticate("first");
		client.emit("disconnect", client);
		lookup.resolve(ok(room));
		await settle();
		expect(join).not.toHaveBeenCalled();
		expect(client.sendRaw).not.toHaveBeenCalled();
		expect(room.realusers).toEqual([]);
		expect(clientmanager.getClientsInRoom(room.name)).toEqual([]);
		expect(room.playbackPreparation).toBeNull();
	});

	it("sends the first full sync with a held position for an older playing empty-room snapshot", async () => {
		await room.play();
		const previousPosition = room.realPlaybackPosition;
		const client = authenticate("first");
		await vi.waitFor(() => expect(room.getUser(client.id)).toBeDefined());
		const firstSync = JSON.parse(client.sendRaw.mock.calls[0][0]);
		expect(firstSync).toMatchObject({ action: "sync", isPlaying: false });
		expect(firstSync.playbackPosition).toBeCloseTo(previousPosition, 0);
		expect(room.playbackPreparation?.clientId).toBe(client.id);
		expect(room.isPlaying).toBe(false);
	});

	it("cleans a delayed identity lookup before it can leave a disconnected first preparer", async () => {
		const lookupStarted = deferred<void>();
		const finishLookup = deferred<void>();
		const updateInfo = RoomUser.prototype.updateInfo;
		vi.spyOn(RoomUser.prototype, "updateInfo").mockImplementationOnce(async function (
			this: RoomUser,
			info: ClientInfo,
		) {
			lookupStarted.resolve();
			await finishLookup.promise;
			await updateInfo.call(this, info);
		});
		const leave = vi.spyOn(room, "leaveRoom");
		const first = authenticate("first");
		await lookupStarted.promise;
		first.emit("disconnect", first);
		const second = authenticate("second");
		await vi.waitFor(() => expect(room.getUser(second.id)).toBeDefined());
		const preparation = room.playbackPreparation!;
		expect(preparation.clientId).toBe(second.id);
		finishLookup.resolve();
		await vi.waitFor(() =>
			expect(leave).toHaveBeenCalledWith(
				expect.anything(),
				expect.objectContaining({ clientId: first.id }),
			),
		);
		await settle();
		expect(room.realusers.map(user => user.id)).toEqual([second.id]);
		expect(clientmanager.getClientsInRoom(room.name).map(client => client.id)).toEqual([
			second.id,
		]);
		expect(room.playbackPreparation).toEqual(preparation);
		expect(first.sendRaw.mock.calls.map(([message]) => JSON.parse(message).action)).toEqual([
			"sync",
		]);
		expect(room.realPlaybackPosition).toBe(125);
		expect(room.isPlaying).toBe(false);
	});

	it("does not announce a viewer who refreshes the page as leaving and joining", async () => {
		const client = authenticate("first");
		await vi.waitFor(() => expect(room.getUser(client.id)).toBeDefined());
		const eventTypes = () =>
			vi
				.mocked(room.publish)
				.mock.calls.map(call => (call[0] as { request?: { type?: number } }).request?.type)
				.filter(type => type !== undefined);

		// The first arrival is announced.
		expect(eventTypes()).toContain(RoomRequestType.JoinRequest);

		// A refresh: the socket closes and a new one joins with the same session token.
		await room.leaveRoom(
			{ type: RoomRequestType.LeaveRequest },
			{ clientId: client.id, role: Role.UnregisteredUser, username: "first" },
		);
		await settle();
		// The leave event waits: nobody has been told anything yet.
		expect(eventTypes()).not.toContain(RoomRequestType.LeaveRequest);

		const second = new JoiningGuest(room.name);
		clients.push(second);
		second.token = client.token ?? "test-first";
		second.session = client.session ?? { isLoggedIn: false, username: "first" };
		second.joinStatus = ClientJoinStatus.Joined;
		clientmanager.addClient(second);
		second.emit("auth", second, second.token, second.session);
		await vi.waitFor(() => expect(room.getUser(second.id)).toBeDefined());
		await settle();

		// Neither the leave nor the second join is announced.
		expect(eventTypes()).not.toContain(RoomRequestType.LeaveRequest);
		expect(eventTypes().filter(type => type === RoomRequestType.JoinRequest)).toHaveLength(1);
	});

	it("announces a viewer who really leaves", async () => {
		const client = authenticate("first");
		await vi.waitFor(() => expect(room.getUser(client.id)).toBeDefined());
		vi.mocked(room.publish).mockClear();

		await room.leaveRoom(
			{ type: RoomRequestType.LeaveRequest },
			{ clientId: client.id, role: Role.UnregisteredUser, username: "first" },
		);
		// The event waits a moment before the room tells the others.
		await vi.waitFor(
			() => {
				const types = vi
					.mocked(room.publish)
					.mock.calls.map(
						call => (call[0] as { request?: { type?: number } }).request?.type,
					);
				expect(types).toContain(RoomRequestType.LeaveRequest);
			},
			{ timeout: 8000 },
		);
	}, 10000);

	it("gives a re-authenticated viewer their new identity without leaving the room", async () => {
		const client = authenticate("first");
		await vi.waitFor(() => expect(room.getUser(client.id)).toBeDefined());
		expect(room.getUser(client.id)?.isLoggedIn).toBe(false);
		expect(room.getRole(room.getUser(client.id))).toBe(Role.UnregisteredUser);

		// A login rotates the token and turns the guest into an account. The socket
		// re-authenticates in place, so the viewer keeps their seat and picks up the
		// new role without a reload.
		const session: SessionInfo = { isLoggedIn: true, user_id: 4242 };
		vi.mocked(tokens.getSessionInfo).mockResolvedValue(session);
		client.session = session;
		client.emit("reauth", client, "user-token", session);
		await settle();

		const user = room.getUser(client.id);
		expect(user?.isLoggedIn).toBe(true);
		expect(room.getRole(user)).toBe(Role.RegisteredUser);
		expect(room.realusers).toHaveLength(1);
		const sent = client.sendRaw.mock.calls.map(([message]) => JSON.parse(message));
		expect(sent.some(msg => msg.action === "sync")).toBe(true);
	});

	it("preserves resume intent if the only connecting viewer leaves during identity lookup", async () => {
		const lookupStarted = deferred<void>();
		const finishLookup = deferred<void>();
		const updateInfo = RoomUser.prototype.updateInfo;
		vi.spyOn(RoomUser.prototype, "updateInfo").mockImplementationOnce(async function (
			this: RoomUser,
			info: ClientInfo,
		) {
			lookupStarted.resolve();
			await finishLookup.promise;
			await updateInfo.call(this, info);
		});
		const leave = vi.spyOn(room, "leaveRoom");
		const first = authenticate("first");
		await lookupStarted.promise;
		first.emit("disconnect", first);
		finishLookup.resolve();
		await vi.waitFor(() => expect(leave).toHaveBeenCalledOnce());
		await settle();
		expect(room.realusers).toEqual([]);
		expect(room.playbackPreparation).toBeNull();
		expect(room.resumeOnNextJoin).toBe(true);
		const second = authenticate("second");
		await vi.waitFor(() => expect(room.playbackPreparation?.clientId).toBe(second.id));
		expect(room.playbackPreparation?.position).toBe(125);
	});
});
