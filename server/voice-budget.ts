import type { VoiceDeniedReason } from "ott-common/models/messages.js";
import { conf } from "./ott-config.js";
import { getLogger } from "./logger.js";
import { redisClient } from "./redisclient.js";
import {
	getChannelRelayIceServers,
	getTurnChannels,
	hasRelayConfigured,
	isVoiceEnabled,
	type RelaySelection,
	type TurnChannel,
} from "./voice.js";

const log = getLogger("voice-budget");

/** Cloudflare Realtime publishes $0.05 per GB egress; used only to show an estimated cost. */
const RELAY_USD_PER_GB = 0.05;
const BYTES_PER_MB = 1_000_000;
const BYTES_PER_GB = 1_000_000_000;

/**
 * Per-account accounting. `estimated` is accrued from room participant counts whenever a room is
 * assigned an endpoint; `actual` is written by the Cloudflare analytics cron and takes precedence
 * for the cap, so direct traffic is not charged against an account.
 */
export interface VoiceBudgetStore {
	getEndpointEstimatedBytes(channelId: string, endpointId: string): Promise<number>;
	addEndpointEstimatedBytes(channelId: string, endpointId: string, bytes: number): Promise<void>;
	getEndpointActualBytes(channelId: string, endpointId: string): Promise<number | null>;
	resetUsage(): Promise<void>;
}

function monthKey(now = new Date()): string {
	const month = String(now.getUTCMonth() + 1).padStart(2, "0");
	return `${now.getUTCFullYear()}-${month}`;
}

export function endpointUsageKey(channelId: string, endpointId: string, now = new Date()): string {
	return `voice:relay-bytes:${monthKey(now)}:${channelId}:${endpointId}`;
}

export function actualEndpointUsageKey(
	channelId: string,
	endpointId: string,
	now = new Date(),
): string {
	return `voice:cloudflare-egress:${monthKey(now)}:${channelId}:${endpointId}`;
}

/** Keeps two months, so a previous month's counter can never be read as the current one. */
const USAGE_TTL_SECONDS = 60 * 60 * 24 * 62;

function parseBytes(raw: string | null | undefined): number | null {
	if (!raw) {
		return null;
	}
	const parsed = Number.parseInt(raw, 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

export const redisBudgetStore: VoiceBudgetStore = {
	async getEndpointEstimatedBytes(channelId, endpointId) {
		return parseBytes(await redisClient.get(endpointUsageKey(channelId, endpointId))) ?? 0;
	},
	async addEndpointEstimatedBytes(channelId, endpointId, bytes) {
		if (bytes <= 0) {
			return;
		}
		const key = endpointUsageKey(channelId, endpointId);
		await redisClient.incrBy(key, Math.round(bytes));
		await redisClient.expire(key, USAGE_TTL_SECONDS);
	},
	async getEndpointActualBytes(channelId, endpointId) {
		return parseBytes(await redisClient.get(actualEndpointUsageKey(channelId, endpointId)));
	},
	async resetUsage() {
		const keys: string[] = [];
		for (const channel of getTurnChannels()) {
			for (const endpoint of channel.endpoints) {
				keys.push(
					endpointUsageKey(channel.id, endpoint.id),
					actualEndpointUsageKey(channel.id, endpoint.id),
				);
			}
		}
		if (keys.length > 0) {
			await redisClient.del(keys);
		}
	},
};

let store: VoiceBudgetStore = redisBudgetStore;

/** Test seam. Pass null to restore the Redis-backed store. */
export function setVoiceBudgetStore(next: VoiceBudgetStore | null): void {
	store = next ?? redisBudgetStore;
}

export interface VoiceEndpointState {
	channelId: string;
	endpointId: string;
	limitMb: number;
	estimatedMb: number;
	actualMb: number | null;
	usageMb: number;
	remainingMb: number;
	allowed: boolean;
}

export interface VoiceChannelState {
	id: string;
	kind: "cloudflare" | "static";
	/** Sum of the endpoint caps; endpoints inside a channel do not share it. */
	limitMb: number;
	estimatedMb: number;
	actualMb: number | null;
	usageMb: number;
	remainingMb: number;
	allowed: boolean;
	endpoints: VoiceEndpointState[];
}

/** Actual analytics win over the local estimate; a missing actual key falls back to the estimate. */
export async function getChannelStates(): Promise<VoiceChannelState[]> {
	const channels = getTurnChannels();
	const states: VoiceChannelState[] = [];
	for (const channel of channels) {
		const endpoints: VoiceEndpointState[] = [];
		for (const endpoint of channel.endpoints) {
			let estimatedBytes = 0;
			let actualBytes: number | null = null;
			let readable = true;
			try {
				estimatedBytes = await store.getEndpointEstimatedBytes(channel.id, endpoint.id);
			} catch (e) {
				log.error(
					`Unable to read estimated relay usage for ${channel.id}/${endpoint.id}: ${e}`,
				);
				readable = false;
			}
			try {
				actualBytes = await store.getEndpointActualBytes(channel.id, endpoint.id);
			} catch (e) {
				log.error(
					`Unable to read actual relay usage for ${channel.id}/${endpoint.id}: ${e}`,
				);
				readable = false;
			}
			const usageBytes = actualBytes ?? estimatedBytes;
			const limitBytes = endpoint.monthlyLimitMb * BYTES_PER_MB;
			endpoints.push({
				channelId: channel.id,
				endpointId: endpoint.id,
				limitMb: endpoint.monthlyLimitMb,
				estimatedMb: estimatedBytes / BYTES_PER_MB,
				actualMb: actualBytes === null ? null : actualBytes / BYTES_PER_MB,
				usageMb: usageBytes / BYTES_PER_MB,
				remainingMb: Math.max(0, (limitBytes - usageBytes) / BYTES_PER_MB),
				allowed: readable && usageBytes < limitBytes,
			});
		}
		const usageMb = endpoints.reduce((sum, endpoint) => sum + endpoint.usageMb, 0);
		const estimatedMb = endpoints.reduce((sum, endpoint) => sum + endpoint.estimatedMb, 0);
		const actualMb = endpoints.some(endpoint => endpoint.actualMb !== null)
			? endpoints.reduce(
					(sum, endpoint) => sum + (endpoint.actualMb ?? endpoint.estimatedMb),
					0,
				)
			: null;
		const limitMb = endpoints.reduce((sum, endpoint) => sum + endpoint.limitMb, 0);
		states.push({
			id: channel.id,
			kind: channel.kind,
			limitMb,
			estimatedMb,
			actualMb,
			usageMb,
			remainingMb: Math.max(0, limitMb - usageMb),
			allowed: endpoints.some(endpoint => endpoint.allowed),
			endpoints,
		});
	}
	return states;
}

// Rotate equal-usage channels so two rooms joining in the same tick do not both pick the first.
let channelCursor = 0;
// Within one channel, stay on the current endpoint until it fails or reaches its own cap.
const activeEndpoints = new Map<string, string>();

/**
 * Pick a channel with an endpoint that still has free quota. Endpoints inside a channel are sticky
 * failover targets in configured order: account #1 carries the traffic until it is unavailable or
 * reaches its own 700 GB cap, then account #2 takes over.
 */
export async function selectRelayChannel(): Promise<RelaySelection | null> {
	const channels = getTurnChannels();
	if (channels.length === 0) {
		return null;
	}
	const states = await getChannelStates();
	const available = channels
		.map(channel => ({ channel, state: states.find(state => state.id === channel.id) }))
		.filter(
			(entry): entry is { channel: TurnChannel; state: VoiceChannelState } =>
				entry.state?.allowed === true,
		)
		.sort((a, b) => a.state.usageMb - b.state.usageMb);
	if (available.length === 0) {
		return null;
	}
	// Balance equally-used channels; a clearly least-used channel is always preferred.
	const minUsage = available[0].state.usageMb;
	const leastUsed = available.filter(entry => entry.state.usageMb === minUsage);
	const start = channelCursor % leastUsed.length;
	const orderedChannels = [
		...leastUsed.slice(start),
		...leastUsed.slice(0, start),
		...available.filter(entry => entry.state.usageMb !== minUsage),
	];
	for (const entry of orderedChannels) {
		const channel = entry.channel;
		const stateById = new Map(
			entry.state.endpoints.map(endpoint => [endpoint.endpointId, endpoint]),
		);
		const activeEndpointId = activeEndpoints.get(channel.id);
		const orderedEndpoints = activeEndpointId
			? [
					...channel.endpoints.filter(endpoint => endpoint.id === activeEndpointId),
					...channel.endpoints.filter(endpoint => endpoint.id !== activeEndpointId),
				]
			: channel.endpoints;
		for (const endpoint of orderedEndpoints) {
			if (stateById.get(endpoint.id)?.allowed !== true) {
				continue;
			}
			const iceServers = await getChannelRelayIceServers(channel.id, endpoint.id);
			if (iceServers.length > 0) {
				activeEndpoints.set(channel.id, endpoint.id);
				channelCursor++;
				return { channel, endpoint };
			}
		}
	}
	return null;
}

/** Whether at least one endpoint still has free quota; does not fetch credentials. */
export async function isRelayAllowedNow(): Promise<boolean> {
	const states = await getChannelStates();
	return states.some(channel => channel.endpoints.some(endpoint => endpoint.allowed));
}

export interface VoiceJoinDecision {
	allowed: boolean;
	reason?: VoiceDeniedReason;
	includeRelay: boolean;
}

export async function decideVoiceJoin(input: {
	roomParticipants: number;
	roomAlreadyInVoice: boolean;
	voiceRoomCount: number;
}): Promise<VoiceJoinDecision> {
	const maxParticipants = conf.get("voice.max_participants_per_room");
	if (maxParticipants > 0 && input.roomParticipants >= maxParticipants) {
		return { allowed: false, reason: "room-full", includeRelay: false };
	}
	const maxRooms = conf.get("voice.max_concurrent_rooms");
	if (maxRooms > 0 && !input.roomAlreadyInVoice && input.voiceRoomCount >= maxRooms) {
		return { allowed: false, reason: "too-many-rooms", includeRelay: false };
	}
	return { allowed: true, includeRelay: hasRelayConfigured() };
}

export interface VoiceRoomUsage {
	participants: number;
	channelId: string | null;
	endpointId: string | null;
}

/**
 * Accrue the estimated relayed volume for one tick. Only rooms with an assigned endpoint
 * contribute; a direct-only room consumes no account quota.
 */
export async function recordUsage(
	rooms: Iterable<VoiceRoomUsage>,
	tickSeconds: number,
): Promise<void> {
	const bitrateKbps = conf.get("voice.audio_bitrate_kbps");
	const perEndpoint = new Map<string, { channelId: string; endpointId: string; bytes: number }>();
	for (const room of rooms) {
		if (room.participants < 2 || room.channelId === null || room.endpointId === null) {
			continue;
		}
		const bytes =
			(room.participants * (room.participants - 1) * bitrateKbps * 1000 * tickSeconds) / 8;
		const key = `${room.channelId}\u0000${room.endpointId}`;
		const existing = perEndpoint.get(key);
		if (existing) {
			existing.bytes += bytes;
		} else {
			perEndpoint.set(key, {
				channelId: room.channelId,
				endpointId: room.endpointId,
				bytes,
			});
		}
	}
	if (perEndpoint.size === 0) {
		return;
	}
	try {
		for (const { channelId, endpointId, bytes } of perEndpoint.values()) {
			await store.addEndpointEstimatedBytes(channelId, endpointId, bytes);
		}
	} catch (e) {
		log.error(`Unable to record voice relay usage: ${e}`);
	}
}

export interface VoiceEndpointSnapshot extends VoiceEndpointState {}

export interface VoiceChannelSnapshot extends VoiceChannelState {}

export interface VoiceUsageSnapshot {
	enabled: boolean;
	relayConfigured: boolean;
	relayAllowed: boolean;
	monthlyUsageMb: number | null;
	softBudgetMb: number;
	hardBudgetMb: number;
	estimatedMonthlyCostUsd: number | null;
	channels: VoiceChannelSnapshot[];
}

/** Backs the operator-facing status route, for reconciling the estimate against the real bill. */
export async function getVoiceUsageSnapshot(): Promise<VoiceUsageSnapshot> {
	const states = await getChannelStates();
	const usageBytes = states.reduce((sum, channel) => sum + channel.usageMb * BYTES_PER_MB, 0);
	return {
		enabled: isVoiceEnabled(),
		relayConfigured: hasRelayConfigured(),
		relayAllowed: states.some(channel => channel.endpoints.some(endpoint => endpoint.allowed)),
		monthlyUsageMb: usageBytes / BYTES_PER_MB,
		softBudgetMb: 0,
		hardBudgetMb: 0,
		estimatedMonthlyCostUsd:
			Math.round((usageBytes / BYTES_PER_GB) * RELAY_USD_PER_GB * 10000) / 10000,
		channels: states,
	};
}

/** Test helper: clears the current month's counters. */
export async function resetUsage(): Promise<void> {
	await store.resetUsage();
}
