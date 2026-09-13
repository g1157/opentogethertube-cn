import type { VoiceDeniedReason } from "ott-common/models/messages.js";
import { conf } from "./ott-config.js";
import { getLogger } from "./logger.js";
import { redisClient } from "./redisclient.js";
import { getRelayIceServers, isVoiceEnabled } from "./voice.js";

const log = getLogger("voice-budget");

/** Cloudflare Realtime publishes $0.05 per GB egress; used only to show an estimated cost. */
const RELAY_USD_PER_GB = 0.05;
const BYTES_PER_MB = 1_000_000;
const BYTES_PER_GB = 1_000_000_000;

/**
 * Usage is accounted in estimated relayed bytes, which is the dimension Cloudflare Realtime bills
 * on, so a budget in this unit maps onto the invoice.
 *
 * The estimate assumes every stream is relayed even though direct connections are free, so it is
 * deliberately conservative: the brake engages before the real bill reaches the configured limit.
 */
export interface VoiceBudgetStore {
	getUsageBytes(): Promise<number>;
	addUsageBytes(bytes: number): Promise<void>;
	resetUsage(): Promise<void>;
}

export function usageKey(now = new Date()): string {
	const month = String(now.getUTCMonth() + 1).padStart(2, "0");
	return `voice:relay-bytes:${now.getUTCFullYear()}-${month}`;
}

/** Keeps two months, so a previous month's counter can never be read as the current one. */
const USAGE_TTL_SECONDS = 60 * 60 * 24 * 62;

export const redisBudgetStore: VoiceBudgetStore = {
	async getUsageBytes() {
		const raw = await redisClient.get(usageKey());
		if (!raw) {
			return 0;
		}
		const parsed = Number.parseInt(raw, 10);
		return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
	},
	async addUsageBytes(bytes) {
		if (bytes <= 0) {
			return;
		}
		await redisClient.incrBy(usageKey(), Math.round(bytes));
		await redisClient.expire(usageKey(), USAGE_TTL_SECONDS);
	},
	async resetUsage() {
		await redisClient.del(usageKey());
	},
};

let store: VoiceBudgetStore = redisBudgetStore;

/** Test seam. Pass null to restore the Redis-backed store. */
export function setVoiceBudgetStore(next: VoiceBudgetStore | null): void {
	store = next ?? redisBudgetStore;
}

interface BudgetState {
	usageBytes: number | null;
	includeRelay: boolean;
	exhausted: boolean;
}

/**
 * An unreadable budget is treated as exhausted rather than unlimited. This control exists to stop
 * runaway relay cost, so an uncertain reading must not hand out paid relay candidates. Direct
 * connections keep working either way, because they cost nothing.
 */
async function evaluateBudget(): Promise<BudgetState> {
	if (getRelayIceServers().length === 0) {
		return { usageBytes: 0, includeRelay: false, exhausted: false };
	}
	let usageBytes: number;
	try {
		usageBytes = await store.getUsageBytes();
	} catch (e) {
		log.error(`Unable to read voice relay usage, withholding relay candidates: ${e}`);
		return { usageBytes: null, includeRelay: false, exhausted: true };
	}
	const hardMaxMb = conf.get("voice.monthly_relay_mb_max");
	if (hardMaxMb > 0 && usageBytes >= hardMaxMb * BYTES_PER_MB) {
		return { usageBytes, includeRelay: false, exhausted: true };
	}
	const softMb = conf.get("voice.monthly_relay_mb");
	const includeRelay = !(softMb > 0 && usageBytes >= softMb * BYTES_PER_MB);
	return { usageBytes, includeRelay, exhausted: false };
}

/** Whether relay candidates may be handed out right now. */
export async function isRelayAllowedNow(): Promise<boolean> {
	return (await evaluateBudget()).includeRelay;
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
	const budget = await evaluateBudget();
	if (budget.exhausted) {
		return { allowed: false, reason: "budget", includeRelay: false };
	}
	return { allowed: true, includeRelay: budget.includeRelay };
}

/**
 * Accrue the estimated relayed volume for one tick. Each room contributes one unidirectional audio
 * stream per ordered pair, so a room with N participants carries N * (N - 1) streams.
 */
export async function recordUsage(
	roomParticipantCounts: Iterable<number>,
	tickSeconds: number,
): Promise<void> {
	// Relayed volume only accrues while relay candidates are actually being handed out. Without
	// this guard the estimate would keep climbing after the brake engaged, and could later refuse
	// joins even though no relayed traffic was being billed.
	if (!(await isRelayAllowedNow())) {
		return;
	}
	const bitrateKbps = conf.get("voice.audio_bitrate_kbps");
	let bytes = 0;
	for (const participants of roomParticipantCounts) {
		if (participants < 2) {
			continue;
		}
		const streams = participants * (participants - 1);
		bytes += (streams * bitrateKbps * 1000 * tickSeconds) / 8;
	}
	if (bytes <= 0) {
		return;
	}
	try {
		await store.addUsageBytes(bytes);
	} catch (e) {
		log.error(`Unable to record voice relay usage: ${e}`);
	}
}

export interface VoiceUsageSnapshot {
	enabled: boolean;
	relayConfigured: boolean;
	relayAllowed: boolean;
	monthlyUsageMb: number | null;
	softBudgetMb: number;
	hardBudgetMb: number;
	estimatedMonthlyCostUsd: number | null;
}

/** Backs the operator-facing status route, for reconciling the estimate against the real bill. */
export async function getVoiceUsageSnapshot(): Promise<VoiceUsageSnapshot> {
	const budget = await evaluateBudget();
	const usageMb = budget.usageBytes === null ? null : budget.usageBytes / BYTES_PER_MB;
	return {
		enabled: isVoiceEnabled(),
		relayConfigured: getRelayIceServers().length > 0,
		relayAllowed: budget.includeRelay,
		monthlyUsageMb: usageMb,
		softBudgetMb: conf.get("voice.monthly_relay_mb"),
		hardBudgetMb: conf.get("voice.monthly_relay_mb_max"),
		estimatedMonthlyCostUsd:
			budget.usageBytes === null
				? null
				: Math.round((budget.usageBytes / BYTES_PER_GB) * RELAY_USD_PER_GB * 10000) / 10000,
	};
}

/** Test helper: clears the current month's counter. */
export async function resetUsage(): Promise<void> {
	await store.resetUsage();
}
