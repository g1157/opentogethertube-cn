import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Client, ClientJoinStatus } from "../../client.js";
import clientmanager from "../../clientmanager.js";
import roommanager from "../../roommanager.js";
import { Room } from "../../room.js";
import { buildClients } from "../../redisclient.js";
import tokens from "../../auth/tokens.js";
import * as voice from "../../voice.js";
import * as budget from "../../voice-budget.js";
import { conf } from "../../ott-config.js";
import { ok } from "ott-common/result.js";
import type { OttWebsocketError } from "ott-common/models/types.js";

class VoiceGuest extends Client {
	sendRaw = vi.fn();
	get clientType() {
		return "test";
	}
	kick(_code: OttWebsocketError) {
		this.emit("disconnect", this);
	}
}

describe("voice admission lifecycle", () => {
	let room: Room;
	const clients: VoiceGuest[] = [];
	let limits: { participants: number; rooms: number };
	const settle = () => new Promise<void>(resolve => setImmediate(resolve));
	beforeAll(async () => {
		await buildClients();
	});
	beforeEach(() => {
		limits = {
			participants: conf.get("voice.max_participants_per_room"),
			rooms: conf.get("voice.max_concurrent_rooms"),
		};
		conf.set("voice.max_participants_per_room", 1);
		conf.set("voice.max_concurrent_rooms", 0);
		room = new Room({ name: "voice-admission-room", isTemporary: true });
		vi.spyOn(room, "publish").mockResolvedValue(undefined);
		vi.spyOn(roommanager, "getRoom").mockResolvedValue(ok(room));
		vi.spyOn(tokens, "getSessionInfo").mockResolvedValue({
			isLoggedIn: false,
			username: "guest",
		});
		vi.spyOn(tokens, "validate").mockResolvedValue(true);
		vi.spyOn(voice, "isVoiceEnabled").mockReturnValue(true);
		vi.spyOn(voice, "getVoiceIceServers").mockResolvedValue([]);
		vi.spyOn(budget, "selectRelayChannel").mockResolvedValue(null);
	});
	afterEach(async () => {
		for (const client of clients.splice(0)) {
			client.emit("disconnect", client);
		}
		await settle();
		room.throttledSync.cancel();
		room.saveStateToRedisDebounced.cancel();
		conf.set("voice.max_participants_per_room", limits.participants);
		conf.set("voice.max_concurrent_rooms", limits.rooms);
		vi.restoreAllMocks();
	});
	function authenticate() {
		const client = new VoiceGuest(room.name);
		clients.push(client);
		client.token = `test-${client.id}`;
		client.session = { isLoggedIn: false, username: "guest" };
		client.joinStatus = ClientJoinStatus.Joined;
		clientmanager.addClient(client);
		client.emit("auth", client, client.token, client.session);
		return client;
	}
	const messages = (client: VoiceGuest) =>
		client.sendRaw.mock.calls.map(([text]) => JSON.parse(text));

	it("does not admit voice before a pending room lookup and member join finish", async () => {
		let release!: (result: ReturnType<typeof ok<Room>>) => void;
		vi.mocked(roommanager.getRoom).mockReturnValueOnce(
			new Promise(resolve => {
				release = resolve;
			}),
		);
		const decide = vi.spyOn(budget, "decideVoiceJoin");
		const client = authenticate();
		client.emit("message", client, { action: "voice", joined: true });
		try {
			await settle();
			expect(decide).not.toHaveBeenCalled();
		} finally {
			release(ok(room));
			await settle();
		}
		expect(decide).toHaveBeenCalledOnce();
	});

	it("keeps the participant cap when two members join voice in the same event-loop turn", async () => {
		const first = authenticate();
		const second = authenticate();
		await settle();
		first.emit("message", first, { action: "voice", joined: true });
		second.emit("message", second, { action: "voice", joined: true });
		await settle();
		const all = [...messages(first), ...messages(second)].filter(
			message => message.action === "voice",
		);
		expect(all.some(message => message.denied === "room-full")).toBe(true);
		expect(all.every(message => message.participants.length <= 1)).toBe(true);
	});

	it("shares one relay selection while two admitted participants await credentials", async () => {
		conf.set("voice.max_participants_per_room", 0);
		const first = authenticate();
		const second = authenticate();
		await settle();
		let release!: (selection: null) => void;
		vi.mocked(budget.selectRelayChannel).mockReturnValue(
			new Promise(resolve => {
				release = resolve;
			}),
		);
		first.emit("message", first, { action: "voice", joined: true });
		second.emit("message", second, { action: "voice", joined: true });
		try {
			await settle();
			expect(budget.selectRelayChannel).toHaveBeenCalledOnce();
		} finally {
			release(null);
			await settle();
		}
	});
});
