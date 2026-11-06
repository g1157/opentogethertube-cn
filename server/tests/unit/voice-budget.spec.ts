import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { conf } from "../../ott-config.js";
import {
	type VoiceBudgetStore,
	decideVoiceJoin,
	endpointUsageKey,
	getChannelStates,
	getVoiceUsageSnapshot,
	isRelayAllowedNow,
	recordUsage,
	resetUsage,
	selectRelayChannel,
	setVoiceBudgetStore,
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
const CHANNELS = JSON.stringify([
	{ id: "a", kind: "static", monthlyLimitMb: 700_000 },
	{ id: "b", kind: "static", monthlyLimitMb: 700_000 },
]);
const MB = 1_000_000;
const GB = 1_000_000_000;

function endpointKey(channelId: string, endpointId: string): string {
	return `${channelId}\u0000${endpointId}`;
}

class MemoryStore implements VoiceBudgetStore {
	estimated = new Map<string, number>();
	actual = new Map<string, number>();
	fail = false;

	async getEndpointEstimatedBytes(channelId: string, endpointId: string): Promise<number> {
		if (this.fail) {
			throw new Error("redis unavailable");
		}
		return this.estimated.get(endpointKey(channelId, endpointId)) ?? 0;
	}

	async addEndpointEstimatedBytes(
		channelId: string,
		endpointId: string,
		bytes: number,
	): Promise<void> {
		const key = endpointKey(channelId, endpointId);
		this.estimated.set(key, (this.estimated.get(key) ?? 0) + bytes);
	}

	async getEndpointActualBytes(channelId: string, endpointId: string): Promise<number | null> {
		if (this.fail) {
			throw new Error("redis unavailable");
		}
		return this.actual.get(endpointKey(channelId, endpointId)) ?? null;
	}

	async resetUsage(): Promise<void> {
		this.estimated.clear();
		this.actual.clear();
	}
}

describe("voice relay channels", () => {
	const store = new MemoryStore();
	const previous = {
		turn: "",
		channels: "",
		cloudflareKeyId: "",
		cloudflareApiToken: "",
		maxParticipants: 0,
		maxRooms: 0,
		bitrate: 0,
	};

	beforeAll(() => {
		previous.turn = conf.get("voice.turn_ice_servers");
		previous.channels = conf.get("voice.turn_channels");
		previous.cloudflareKeyId = conf.get("voice.cloudflare_turn.key_id");
		previous.cloudflareApiToken = conf.get("voice.cloudflare_turn.api_token");
		previous.maxParticipants = conf.get("voice.max_participants_per_room");
		previous.maxRooms = conf.get("voice.max_concurrent_rooms");
		previous.bitrate = conf.get("voice.audio_bitrate_kbps");
		setVoiceBudgetStore(store);
	});

	afterAll(() => {
		setVoiceBudgetStore(null);
		conf.set("voice.turn_ice_servers", previous.turn);
		conf.set("voice.turn_channels", previous.channels);
		conf.set("voice.cloudflare_turn.key_id", previous.cloudflareKeyId);
		conf.set("voice.cloudflare_turn.api_token", previous.cloudflareApiToken);
		conf.set("voice.max_participants_per_room", previous.maxParticipants);
		conf.set("voice.max_concurrent_rooms", previous.maxRooms);
		conf.set("voice.audio_bitrate_kbps", previous.bitrate);
	});

	beforeEach(() => {
		store.estimated.clear();
		store.actual.clear();
		store.fail = false;
		logger.error.mockClear();
		vi.unstubAllGlobals();
		conf.set("voice.turn_ice_servers", TURN);
		conf.set("voice.turn_channels", CHANNELS);
		conf.set("voice.cloudflare_turn.key_id", "");
		conf.set("voice.cloudflare_turn.api_token", "");
		conf.set("voice.max_participants_per_room", 6);
		conf.set("voice.max_concurrent_rooms", 0);
		conf.set("voice.audio_bitrate_kbps", 40);
	});

	it("names usage keys by UTC month, channel and endpoint", () => {
		expect(endpointUsageKey("cf", "a", new Date(Date.UTC(2026, 8, 13)))).toBe(
			"voice:relay-bytes:2026-09:cf:a",
		);
	});

	it("accrues only rooms assigned to an endpoint", async () => {
		// 6 participants at 40 kbps over 3 hours: 6*5 streams * 40 kbit/s * 10800 s / 8 bit per byte.
		await recordUsage([{ participants: 6, channelId: "cf", endpointId: "a" }], 10800);
		expect(store.estimated.get(endpointKey("cf", "a"))).toBe(1_620_000_000);
		expect(store.estimated.get(endpointKey("cf", "b"))).toBeUndefined();

		await recordUsage([{ participants: 6, channelId: "cf", endpointId: null }], 10800);
		expect(store.estimated.get(endpointKey("cf", "a"))).toBe(1_620_000_000);
	});

	it("ignores rooms with fewer than two participants", async () => {
		await recordUsage(
			[
				{ participants: 0, channelId: "cf", endpointId: "a" },
				{ participants: 1, channelId: "cf", endpointId: "a" },
			],
			3600,
		);
		expect(store.estimated.size).toBe(0);
	});

	it("reports each endpoint's estimate, actual and remaining cap", async () => {
		store.estimated.set(endpointKey("a", "static"), 100 * MB);
		store.actual.set(endpointKey("a", "static"), 200 * MB);
		store.estimated.set(endpointKey("b", "static"), 700_000 * MB);
		const states = await getChannelStates();
		expect(states).toHaveLength(2);
		expect(states[0]).toMatchObject({
			id: "a",
			limitMb: 700_000,
			estimatedMb: 100,
			actualMb: 200,
			usageMb: 200,
			allowed: true,
		});
		expect(states[0].endpoints[0]).toMatchObject({
			channelId: "a",
			endpointId: "static",
			limitMb: 700_000,
			actualMb: 200,
			allowed: true,
		});
		expect(states[1]).toMatchObject({
			id: "b",
			estimatedMb: 700_000,
			actualMb: null,
			usageMb: 700_000,
			allowed: false,
		});
	});

	it("prefers the least-used channel with free quota", async () => {
		store.estimated.set(endpointKey("a", "static"), 100 * MB);
		store.estimated.set(endpointKey("b", "static"), 0);
		const selection = await selectRelayChannel();
		expect(selection?.channel.id).toBe("b");
	});

	it("balances equal-usage channels across rooms", async () => {
		const first = await selectRelayChannel();
		const second = await selectRelayChannel();
		expect(new Set([first?.channel.id, second?.channel.id]).size).toBe(2);
	});

	it("skips a channel once its endpoint cap is reached", async () => {
		store.estimated.set(endpointKey("a", "static"), 700_000 * MB);
		store.estimated.set(endpointKey("b", "static"), 0);
		expect((await selectRelayChannel())?.channel.id).toBe("b");
	});

	it("returns no channel when every endpoint cap is reached", async () => {
		store.estimated.set(endpointKey("a", "static"), 700_000 * MB);
		store.estimated.set(endpointKey("b", "static"), 700_000 * MB);
		expect(await selectRelayChannel()).toBeNull();
		expect(await isRelayAllowedNow()).toBe(false);
	});

	it("uses actual analytics instead of the local estimate for the cap", async () => {
		store.estimated.set(endpointKey("a", "static"), 0);
		store.actual.set(endpointKey("a", "static"), 700_000 * MB);
		store.actual.set(endpointKey("b", "static"), 0);
		expect((await selectRelayChannel())?.channel.id).toBe("b");
	});

	it("stays on one account until it fails, then fails over in order", async () => {
		const stickyChannels = JSON.stringify([
			{
				id: "sticky",
				kind: "cloudflare",
				keys: [
					{
						id: "a",
						keyId: "sticky-key-a",
						apiToken: "token-a",
						monthlyLimitMb: 700_000,
					},
					{
						id: "b",
						keyId: "sticky-key-b",
						apiToken: "token-b",
						monthlyLimitMb: 700_000,
					},
				],
			},
		]);
		conf.set("voice.turn_ice_servers", "");
		conf.set("voice.turn_channels", stickyChannels);
		const fetchMock = vi.fn().mockResolvedValue({
			ok: true,
			status: 200,
			json: async () => ({
				iceServers: [
					{
						urls: ["turn:turn.cloudflare.com:3478?transport=udp"],
						username: "u",
						credential: "c",
					},
				],
			}),
		} as unknown as Response);
		vi.stubGlobal("fetch", fetchMock);

		const first = await selectRelayChannel();
		const second = await selectRelayChannel();
		expect(first?.endpoint?.id).toBe("a");
		expect(second?.endpoint?.id).toBe("a");
		expect(fetchMock).toHaveBeenCalledTimes(1);
		vi.unstubAllGlobals();

		const failoverChannels = JSON.stringify([
			{
				id: "failover",
				kind: "cloudflare",
				keys: [
					{
						id: "a",
						keyId: "failover-key-a",
						apiToken: "token-a",
						monthlyLimitMb: 700_000,
					},
					{
						id: "b",
						keyId: "failover-key-b",
						apiToken: "token-b",
						monthlyLimitMb: 700_000,
					},
				],
			},
		]);
		conf.set("voice.turn_channels", failoverChannels);
		const failoverFetch = vi.fn(async (url: string | URL | Request) => {
			const href = String(url);
			if (href.includes("failover-key-a")) {
				return { ok: false, status: 500, json: async () => ({}) } as unknown as Response;
			}
			return {
				ok: true,
				status: 200,
				json: async () => ({
					iceServers: [
						{
							urls: ["turn:turn.cloudflare.com:3478?transport=udp"],
							username: "u",
							credential: "c",
						},
					],
				}),
			} as unknown as Response;
		});
		vi.stubGlobal("fetch", failoverFetch);
		const selection = await selectRelayChannel();
		expect(selection?.endpoint?.id).toBe("b");
		expect(failoverFetch).toHaveBeenCalledTimes(2);
		vi.unstubAllGlobals();
	});

	it("caps each account separately inside one Cloudflare channel", async () => {
		const cappedChannels = JSON.stringify([
			{
				id: "capped",
				kind: "cloudflare",
				keys: [
					{
						id: "a",
						keyId: "capped-key-a",
						apiToken: "token-a",
						monthlyLimitMb: 700_000,
					},
					{
						id: "b",
						keyId: "capped-key-b",
						apiToken: "token-b",
						monthlyLimitMb: 700_000,
					},
				],
			},
		]);
		conf.set("voice.turn_ice_servers", "");
		conf.set("voice.turn_channels", cappedChannels);
		store.actual.set(endpointKey("capped", "a"), 700_000 * MB);
		store.actual.set(endpointKey("capped", "b"), 0);
		const fetchMock = vi.fn().mockResolvedValue({
			ok: true,
			status: 200,
			json: async () => ({
				iceServers: [
					{
						urls: ["turn:turn.cloudflare.com:3478?transport=udp"],
						username: "u",
						credential: "c",
					},
				],
			}),
		} as unknown as Response);
		vi.stubGlobal("fetch", fetchMock);

		const selection = await selectRelayChannel();
		expect(selection?.endpoint?.id).toBe("b");
		expect(store.actual.get(endpointKey("capped", "a"))).toBe(700_000 * MB);
		vi.unstubAllGlobals();
	});

	it("fails closed when endpoint usage cannot be read", async () => {
		store.fail = true;
		expect(await isRelayAllowedNow()).toBe(false);
		expect(await selectRelayChannel()).toBeNull();
		expect(logger.error).toHaveBeenCalled();
	});

	it("keeps capacity admission while relay is selected separately", async () => {
		const decision = await decideVoiceJoin({
			roomParticipants: 1,
			roomAlreadyInVoice: true,
			voiceRoomCount: 1,
		});
		expect(decision).toEqual({ allowed: true, includeRelay: true });
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

	it("allows joins without relay when no channel is configured", async () => {
		conf.set("voice.turn_ice_servers", "");
		conf.set("voice.turn_channels", "");
		expect(await isRelayAllowedNow()).toBe(false);
		const decision = await decideVoiceJoin({
			roomParticipants: 1,
			roomAlreadyInVoice: true,
			voiceRoomCount: 1,
		});
		expect(decision).toEqual({ allowed: true, includeRelay: false });
	});

	it("reports per-account usage, caps and cost for reconciliation", async () => {
		const snapshotChannels = JSON.stringify([
			{
				id: "cf-snap",
				kind: "cloudflare",
				keys: [
					{ id: "a", keyId: "snap-key-a", apiToken: "token-a", monthlyLimitMb: 700_000 },
					{ id: "b", keyId: "snap-key-b", apiToken: "token-b", monthlyLimitMb: 700_000 },
				],
			},
		]);
		conf.set("voice.turn_ice_servers", "");
		conf.set("voice.turn_channels", snapshotChannels);
		store.actual.set(endpointKey("cf-snap", "a"), GB);
		store.actual.set(endpointKey("cf-snap", "b"), 0);
		const snapshot = await getVoiceUsageSnapshot();
		expect(snapshot).toMatchObject({
			enabled: conf.get("voice.enabled"),
			relayConfigured: true,
			relayAllowed: true,
			monthlyUsageMb: 1000,
			softBudgetMb: 0,
			hardBudgetMb: 0,
			estimatedMonthlyCostUsd: 0.05,
		});
		expect(snapshot.channels).toHaveLength(1);
		expect(snapshot.channels[0]).toMatchObject({
			id: "cf-snap",
			limitMb: 1_400_000,
			usageMb: 1000,
			allowed: true,
		});
		expect(snapshot.channels[0].endpoints).toHaveLength(2);
		expect(snapshot.channels[0].endpoints[0]).toMatchObject({
			channelId: "cf-snap",
			endpointId: "a",
			limitMb: 700_000,
			actualMb: 1000,
			allowed: true,
		});
	});

	it("clears the estimated and actual counters", async () => {
		store.estimated.set(endpointKey("a", "static"), 1);
		store.actual.set(endpointKey("a", "static"), 1);
		await resetUsage();
		expect(store.estimated.size).toBe(0);
		expect(store.actual.size).toBe(0);
	});
});
