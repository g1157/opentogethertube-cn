import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { conf } from "../../ott-config.js";
import {
	type VoiceBudgetStore,
	decideVoiceJoin,
	getVoiceUsageSnapshot,
	isRelayAllowedNow,
	recordUsage,
	setVoiceBudgetStore,
	usageKey,
} from "../../voice-budget.js";

const logger = vi.hoisted(() => ({
	error: vi.fn(),
	warn: vi.fn(),
	info: vi.fn(),
	debug: vi.fn(),
}));
vi.mock("../../logger.js", () => ({ getLogger: () => logger }));

const TURN = JSON.stringify([
	{ urls: "turn:turn.example.test:3478", username: "user", credential: "secret" },
]);
const MB = 1_000_000;
const GB = 1_000_000_000;

class MemoryStore implements VoiceBudgetStore {
	bytes = 0;
	fail = false;
	async getUsageBytes(): Promise<number> {
		if (this.fail) {
			throw new Error("redis unavailable");
		}
		return this.bytes;
	}
	async addUsageBytes(bytes: number): Promise<void> {
		this.bytes += bytes;
	}
	async resetUsage(): Promise<void> {
		this.bytes = 0;
	}
}

describe("voice relay budget", () => {
	const store = new MemoryStore();
	const previous = {
		turn: "",
		soft: 0,
		hard: 0,
		maxParticipants: 0,
		maxRooms: 0,
		bitrate: 0,
	};

	beforeAll(() => {
		previous.turn = conf.get("voice.turn_ice_servers");
		previous.soft = conf.get("voice.monthly_relay_mb");
		previous.hard = conf.get("voice.monthly_relay_mb_max");
		previous.maxParticipants = conf.get("voice.max_participants_per_room");
		previous.maxRooms = conf.get("voice.max_concurrent_rooms");
		previous.bitrate = conf.get("voice.audio_bitrate_kbps");
		setVoiceBudgetStore(store);
	});

	afterAll(() => {
		setVoiceBudgetStore(null);
		conf.set("voice.turn_ice_servers", previous.turn);
		conf.set("voice.monthly_relay_mb", previous.soft);
		conf.set("voice.monthly_relay_mb_max", previous.hard);
		conf.set("voice.max_participants_per_room", previous.maxParticipants);
		conf.set("voice.max_concurrent_rooms", previous.maxRooms);
		conf.set("voice.audio_bitrate_kbps", previous.bitrate);
	});

	beforeEach(() => {
		store.bytes = 0;
		store.fail = false;
		conf.set("voice.turn_ice_servers", TURN);
		conf.set("voice.monthly_relay_mb", 500_000);
		conf.set("voice.monthly_relay_mb_max", 0);
		conf.set("voice.max_participants_per_room", 6);
		conf.set("voice.max_concurrent_rooms", 0);
		conf.set("voice.audio_bitrate_kbps", 40);
	});

	it("names the usage key by UTC month", () => {
		expect(usageKey(new Date(Date.UTC(2026, 8, 13)))).toBe("voice:relay-bytes:2026-09");
	});

	it("accrues the estimated relayed volume for a full mesh", async () => {
		// 6 participants at 40 kbps over 3 hours: 6*5 streams * 40 kbit/s * 10800 s / 8 bit per byte.
		await recordUsage([6], 10800);
		expect(store.bytes).toBe(1_620_000_000);
	});

	it("ignores rooms with fewer than two participants", async () => {
		await recordUsage([0, 1], 3600);
		expect(store.bytes).toBe(0);
	});

	it("stops accruing once relay is withheld, so the estimate cannot run away", async () => {
		store.bytes = 500_000 * MB;
		await recordUsage([6], 3600);
		expect(store.bytes).toBe(500_000 * MB);
	});

	it("allows relay while under the budget", async () => {
		store.bytes = 499_000 * MB;
		expect(await isRelayAllowedNow()).toBe(true);
	});

	it("withholds relay once the budget is reached, but still allows the join", async () => {
		store.bytes = 500_000 * MB;
		expect(await isRelayAllowedNow()).toBe(false);
		const decision = await decideVoiceJoin({
			roomParticipants: 1,
			roomAlreadyInVoice: true,
			voiceRoomCount: 1,
		});
		expect(decision).toEqual({ allowed: true, includeRelay: false });
	});

	it("refuses the join when the optional hard budget is reached", async () => {
		conf.set("voice.monthly_relay_mb_max", 600_000);
		store.bytes = 600_000 * MB;
		const decision = await decideVoiceJoin({
			roomParticipants: 1,
			roomAlreadyInVoice: true,
			voiceRoomCount: 1,
		});
		expect(decision).toEqual({ allowed: false, reason: "budget", includeRelay: false });
	});

	it("refuses when the room is already full", async () => {
		const decision = await decideVoiceJoin({
			roomParticipants: 6,
			roomAlreadyInVoice: true,
			voiceRoomCount: 1,
		});
		expect(decision).toEqual({ allowed: false, reason: "room-full", includeRelay: false });
	});

	it("refuses a new voice room beyond the concurrency limit", async () => {
		conf.set("voice.max_concurrent_rooms", 2);
		const decision = await decideVoiceJoin({
			roomParticipants: 1,
			roomAlreadyInVoice: false,
			voiceRoomCount: 2,
		});
		expect(decision).toEqual({ allowed: false, reason: "too-many-rooms", includeRelay: false });
	});

	it("does not count an already-active voice room against the concurrency limit", async () => {
		conf.set("voice.max_concurrent_rooms", 2);
		const decision = await decideVoiceJoin({
			roomParticipants: 2,
			roomAlreadyInVoice: true,
			voiceRoomCount: 2,
		});
		expect(decision.allowed).toBe(true);
	});

	it("allows joins without relay when no relay server is configured", async () => {
		conf.set("voice.turn_ice_servers", "");
		expect(await isRelayAllowedNow()).toBe(false);
		const decision = await decideVoiceJoin({
			roomParticipants: 1,
			roomAlreadyInVoice: true,
			voiceRoomCount: 1,
		});
		expect(decision).toEqual({ allowed: true, includeRelay: false });
	});

	it("fails closed when usage cannot be read", async () => {
		store.fail = true;
		expect(await isRelayAllowedNow()).toBe(false);
		const decision = await decideVoiceJoin({
			roomParticipants: 1,
			roomAlreadyInVoice: true,
			voiceRoomCount: 1,
		});
		expect(decision).toEqual({ allowed: false, reason: "budget", includeRelay: false });
		expect(logger.error).toHaveBeenCalled();
	});

	it("reports usage, budgets and an estimated cost for reconciliation", async () => {
		store.bytes = GB;
		const snapshot = await getVoiceUsageSnapshot();
		expect(snapshot).toMatchObject({
			enabled: conf.get("voice.enabled"),
			relayConfigured: true,
			relayAllowed: true,
			monthlyUsageMb: 1000,
			softBudgetMb: 500_000,
			hardBudgetMb: 0,
			estimatedMonthlyCostUsd: 0.05,
		});
	});
});
