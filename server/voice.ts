import type { RtcIceServer } from "ott-common/models/messages.js";
import { conf } from "./ott-config.js";
import { getLogger } from "./logger.js";

const log = getLogger("voice");

/**
 * STUN servers only discover a client's public address; they never relay media, so they cost
 * nothing. Peers behind symmetric NAT or CGNAT cannot connect without a relay, and the hosts below
 * are not reliably reachable from mainland China.
 */
const DEFAULT_DIRECT_ICE_SERVERS: RtcIceServer[] = [
	{ urls: "stun:stun.l.google.com:19302" },
	{ urls: "stun:stun.cloudflare.com:3478" },
];

const CLOUDFLARE_TURN_CREDENTIALS_URL = "https://rtc.live.cloudflare.com/v1/turn/keys";
const CLOUDFLARE_TURN_MIN_TTL_SECONDS = 300;
const CLOUDFLARE_TURN_MAX_TTL_SECONDS = 48 * 60 * 60;
const CLOUDFLARE_TURN_DEFAULT_TTL_SECONDS = 24 * 60 * 60;
/** Refresh before the credential expires so a long call never starts with a stale key. */
const CLOUDFLARE_TURN_REFRESH_RATIO = 0.8;
const CLOUDFLARE_TURN_TIMEOUT_MS = 5000;
/** Do not hammer Cloudflare while its API is failing; keep serving any still-valid cache. */
const CLOUDFLARE_TURN_FAILURE_COOLDOWN_MS = 30_000;
/** Browsers block the alternate TURN port 53; a candidate on it only times out. */
const PORT_53_URL_PATTERN = /:53(?:\?|$)/;

/** Default per-account cap inside a Cloudflare channel; each account gets its own 700 GB. */
export const DEFAULT_CHANNEL_LIMIT_MB = 700_000;

export interface TurnEndpoint {
	id: string;
	/** Cap for this account/key; endpoints inside one channel do not share it. */
	monthlyLimitMb: number;
	keyId?: string;
	apiToken?: string;
	staticIceServers?: RtcIceServer[];
}

export interface TurnChannel {
	id: string;
	kind: "cloudflare" | "static";
	endpoints: TurnEndpoint[];
}

export interface RelaySelection {
	channel: TurnChannel;
	endpoint: TurnEndpoint | null;
}

interface CloudflareTurnCache {
	channelId: string;
	endpointId: string;
	keyId: string;
	ttlSeconds: number;
	iceServers: RtcIceServer[];
	refreshAt: number;
	expiresAt: number;
}

let cachedChannelsKey: string | null = null;
let cachedChannels: TurnChannel[] = [];
const cloudflareCaches = new Map<string, CloudflareTurnCache>();
const cloudflareFetches = new Map<string, Promise<RtcIceServer[]>>();
const cloudflareFailures = new Map<string, { keyId: string; until: number }>();

export function isVoiceEnabled(): boolean {
	return conf.get("voice.enabled");
}

/**
 * Parse a JSON array of ICE servers. A malformed value must not take down every room join, so it
 * degrades to the fallback and logs instead of throwing.
 */
function parseIceServers(raw: string, envName: string, fallback: RtcIceServer[]): RtcIceServer[] {
	const trimmed = (raw ?? "").trim();
	if (!trimmed) {
		return fallback;
	}
	try {
		const parsed: unknown = JSON.parse(trimmed);
		if (!Array.isArray(parsed) || parsed.length === 0) {
			throw new Error("expected a non-empty array");
		}
		return parsed.map(entry => {
			if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
				throw new Error("entry is not an object");
			}
			const urls = (entry as { urls?: unknown }).urls;
			const urlsValid =
				typeof urls === "string" ||
				(Array.isArray(urls) && urls.length > 0 && urls.every(u => typeof u === "string"));
			if (!urlsValid) {
				throw new Error("entry is missing urls");
			}
			return entry as RtcIceServer;
		});
	} catch (e) {
		log.error(`${envName} is invalid, using the fallback instead: ${e}`);
		return fallback;
	}
}

export function getDirectIceServers(): RtcIceServer[] {
	return parseIceServers(
		conf.get("voice.ice_servers"),
		"VOICE_ICE_SERVERS",
		DEFAULT_DIRECT_ICE_SERVERS,
	);
}

function getStaticRelayIceServers(): RtcIceServer[] {
	return parseIceServers(conf.get("voice.turn_ice_servers"), "VOICE_TURN_ICE_SERVERS", []);
}

function getCloudflareTurnTtlSeconds(): number {
	const configuredTtl = Number(conf.get("voice.cloudflare_turn.ttl_seconds"));
	const effectiveTtl = Number.isFinite(configuredTtl)
		? configuredTtl
		: CLOUDFLARE_TURN_DEFAULT_TTL_SECONDS;
	return Math.min(
		Math.max(effectiveTtl, CLOUDFLARE_TURN_MIN_TTL_SECONDS),
		CLOUDFLARE_TURN_MAX_TTL_SECONDS,
	);
}

function parseEndpoints(
	channelId: string,
	value: Record<string, unknown>,
	channelLimitMb: number,
): TurnEndpoint[] {
	const rawKeys = value.keys;
	if (Array.isArray(rawKeys)) {
		if (rawKeys.length === 0) {
			throw new Error(`channel ${channelId} has an empty keys array`);
		}
		const endpoints: TurnEndpoint[] = [];
		const seen = new Set<string>();
		for (const [index, entry] of rawKeys.entries()) {
			if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
				throw new Error(`channel ${channelId} has an invalid key entry`);
			}
			const key = entry as Record<string, unknown>;
			const endpointId =
				typeof key.id === "string" && key.id.trim()
					? key.id.trim()
					: `${channelId}-${index + 1}`;
			const keyId = typeof key.keyId === "string" ? key.keyId.trim() : "";
			const apiToken = typeof key.apiToken === "string" ? key.apiToken.trim() : "";
			if (!keyId || !apiToken) {
				throw new Error(
					`channel ${channelId} endpoint ${endpointId} is missing keyId/apiToken`,
				);
			}
			if (seen.has(endpointId)) {
				throw new Error(`channel ${channelId} has duplicate endpoint id ${endpointId}`);
			}
			seen.add(endpointId);
			const configuredLimit = Number(key.monthlyLimitMb ?? channelLimitMb);
			const monthlyLimitMb =
				Number.isFinite(configuredLimit) && configuredLimit > 0
					? configuredLimit
					: DEFAULT_CHANNEL_LIMIT_MB;
			endpoints.push({ id: endpointId, monthlyLimitMb, keyId, apiToken });
		}
		return endpoints;
	}

	// Backward-compatible single-key channel.
	const keyId = typeof value.keyId === "string" ? value.keyId.trim() : "";
	const apiToken = typeof value.apiToken === "string" ? value.apiToken.trim() : "";
	if (!keyId || !apiToken) {
		throw new Error(`channel ${channelId} is missing keyId/apiToken or keys`);
	}
	return [{ id: "default", monthlyLimitMb: channelLimitMb, keyId, apiToken }];
}

function parseTurnChannels(raw: string): TurnChannel[] {
	const trimmed = (raw ?? "").trim();
	if (trimmed) {
		try {
			const parsed: unknown = JSON.parse(trimmed);
			if (!Array.isArray(parsed) || parsed.length === 0) {
				throw new Error("expected a non-empty array");
			}
			const channels: TurnChannel[] = [];
			const seen = new Set<string>();
			for (const entry of parsed) {
				if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
					throw new Error("entry is not an object");
				}
				const value = entry as Record<string, unknown>;
				const id = typeof value.id === "string" ? value.id.trim() : "";
				if (!id || seen.has(id)) {
					throw new Error(`invalid or duplicate channel id: ${id}`);
				}
				const configuredLimit = Number(value.monthlyLimitMb ?? DEFAULT_CHANNEL_LIMIT_MB);
				const monthlyLimitMb =
					Number.isFinite(configuredLimit) && configuredLimit > 0
						? configuredLimit
						: DEFAULT_CHANNEL_LIMIT_MB;
				const kind = value.kind === "static" ? "static" : "cloudflare";
				if (kind === "cloudflare") {
					channels.push({
						id,
						kind,
						endpoints: parseEndpoints(id, value, monthlyLimitMb),
					});
				} else {
					const staticIceServers = getStaticRelayIceServers();
					if (staticIceServers.length === 0) {
						throw new Error(`static channel ${id} has no VOICE_TURN_ICE_SERVERS`);
					}
					channels.push({
						id,
						kind,
						endpoints: [
							{
								id: "static",
								monthlyLimitMb,
								staticIceServers,
							},
						],
					});
				}
				seen.add(id);
			}
			return channels;
		} catch (e) {
			// A malformed channel list is a configuration error; fail closed rather than silently
			// falling back to a different channel with different billing.
			log.error(`VOICE_TURN_CHANNELS is invalid, disabling relay channels: ${e}`);
			return [];
		}
	}

	const channels: TurnChannel[] = [];
	const keyId = (conf.get("voice.cloudflare_turn.key_id") ?? "").trim();
	const apiToken = (conf.get("voice.cloudflare_turn.api_token") ?? "").trim();
	if (keyId && apiToken) {
		channels.push({
			id: "cloudflare",
			kind: "cloudflare",
			endpoints: [
				{ id: "default", monthlyLimitMb: DEFAULT_CHANNEL_LIMIT_MB, keyId, apiToken },
			],
		});
	}
	const staticIceServers = getStaticRelayIceServers();
	if (staticIceServers.length > 0) {
		channels.push({
			id: "static",
			kind: "static",
			endpoints: [
				{
					id: "static",
					monthlyLimitMb: DEFAULT_CHANNEL_LIMIT_MB,
					staticIceServers,
				},
			],
		});
	}
	return channels;
}

export function getTurnChannels(): TurnChannel[] {
	const raw = conf.get("voice.turn_channels") ?? "";
	// The fallback channel is built from the single Cloudflare/static settings, so those are part
	// of the cache key too; otherwise a config change would keep using the old channel list.
	const cacheKey = [
		raw,
		conf.get("voice.cloudflare_turn.key_id") ?? "",
		conf.get("voice.cloudflare_turn.api_token") ?? "",
		conf.get("voice.turn_ice_servers") ?? "",
	].join("\u0000");
	if (cacheKey === cachedChannelsKey) {
		return cachedChannels;
	}
	cachedChannelsKey = cacheKey;
	cachedChannels = parseTurnChannels(raw);
	return cachedChannels;
}

export function isCloudflareTurnConfigured(): boolean {
	return getTurnChannels().some(
		channel => channel.kind === "cloudflare" && channel.endpoints.length > 0,
	);
}

function iceServerUrls(server: RtcIceServer): string[] {
	return typeof server.urls === "string" ? [server.urls] : server.urls;
}

function isTurnUrl(url: string): boolean {
	return url.startsWith("turn:") || url.startsWith("turns:");
}

/**
 * Browsers are known to block the alternative TURN port 53; keeping it in the list only adds a
 * candidate that times out.
 */
function withoutPort53(urls: string[]): string[] {
	return urls.filter(url => !PORT_53_URL_PATTERN.test(url));
}

function parseIceServerEntry(value: unknown): RtcIceServer | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return null;
	}
	const entry = value as Record<string, unknown>;
	const rawUrls = entry.urls;
	const urlsValid =
		typeof rawUrls === "string" ||
		(Array.isArray(rawUrls) && rawUrls.length > 0 && rawUrls.every(u => typeof u === "string"));
	if (!urlsValid) {
		return null;
	}
	const urls = withoutPort53(typeof rawUrls === "string" ? [rawUrls] : rawUrls);
	if (urls.length === 0) {
		return null;
	}
	const server: RtcIceServer = { urls: urls.length === 1 ? urls[0] : urls };
	if (typeof entry.username === "string") {
		server.username = entry.username;
	}
	if (typeof entry.credential === "string") {
		server.credential = entry.credential;
	}
	return server;
}

/**
 * The Cloudflare response also contains a STUN entry; only TURN entries belong in the relay list
 * because the direct list already covers STUN.
 */
function parseCloudflareIceServers(value: unknown): RtcIceServer[] {
	if (!Array.isArray(value)) {
		return [];
	}
	const servers: RtcIceServer[] = [];
	for (const entry of value) {
		const server = parseIceServerEntry(entry);
		if (server && iceServerUrls(server).some(isTurnUrl)) {
			servers.push(server);
		}
	}
	return servers;
}

function endpointCacheKey(channelId: string, endpointId: string): string {
	return `${channelId}:${endpointId}`;
}

async function fetchCloudflareTurnIceServers(
	channel: TurnChannel,
	endpoint: TurnEndpoint,
	ttlSeconds: number,
): Promise<RtcIceServer[]> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), CLOUDFLARE_TURN_TIMEOUT_MS);
	try {
		const response = await fetch(
			`${CLOUDFLARE_TURN_CREDENTIALS_URL}/${encodeURIComponent(
				endpoint.keyId ?? "",
			)}/credentials/generate-ice-servers`,
			{
				method: "POST",
				headers: {
					Authorization: `Bearer ${endpoint.apiToken ?? ""}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({ ttl: ttlSeconds }),
				signal: controller.signal,
			},
		);
		if (!response.ok) {
			throw new Error(`HTTP ${response.status}`);
		}
		const body: unknown = await response.json();
		const iceServers = parseCloudflareIceServers(
			(body as { iceServers?: unknown } | null)?.iceServers,
		);
		if (iceServers.length === 0) {
			throw new Error("the response contains no TURN servers");
		}
		return iceServers;
	} finally {
		clearTimeout(timer);
	}
}

async function refreshCloudflareTurnCache(
	channel: TurnChannel,
	endpoint: TurnEndpoint,
	ttlSeconds: number,
): Promise<RtcIceServer[]> {
	const cacheKey = endpointCacheKey(channel.id, endpoint.id);
	const existingFetch = cloudflareFetches.get(cacheKey);
	if (existingFetch) {
		return existingFetch;
	}
	const fetchPromise = (async () => {
		try {
			const iceServers = await fetchCloudflareTurnIceServers(channel, endpoint, ttlSeconds);
			const now = Date.now();
			cloudflareCaches.set(cacheKey, {
				channelId: channel.id,
				endpointId: endpoint.id,
				keyId: endpoint.keyId ?? "",
				ttlSeconds,
				iceServers,
				refreshAt: now + ttlSeconds * 1000 * CLOUDFLARE_TURN_REFRESH_RATIO,
				expiresAt: now + ttlSeconds * 1000,
			});
			cloudflareFailures.delete(cacheKey);
			return iceServers;
		} catch (e) {
			log.warn(
				`Cloudflare TURN credentials are unavailable for ${channel.id}/${endpoint.id}: ${e}`,
			);
			cloudflareFailures.set(cacheKey, {
				keyId: endpoint.keyId ?? "",
				until: Date.now() + CLOUDFLARE_TURN_FAILURE_COOLDOWN_MS,
			});
			const cache = cloudflareCaches.get(cacheKey);
			if (cache && cache.keyId === endpoint.keyId && cache.expiresAt > Date.now()) {
				return cache.iceServers;
			}
			return [];
		} finally {
			cloudflareFetches.delete(cacheKey);
		}
	})();
	cloudflareFetches.set(cacheKey, fetchPromise);
	return fetchPromise;
}

async function getCloudflareTurnIceServers(
	channel: TurnChannel,
	endpoint: TurnEndpoint,
): Promise<RtcIceServer[]> {
	const ttlSeconds = getCloudflareTurnTtlSeconds();
	const now = Date.now();
	const cacheKey = endpointCacheKey(channel.id, endpoint.id);
	const cache = cloudflareCaches.get(cacheKey);
	const cacheMatches =
		cache !== undefined && cache.keyId === endpoint.keyId && cache.ttlSeconds === ttlSeconds;
	if (cacheMatches && now < cache.refreshAt) {
		return cache.iceServers;
	}
	if (cacheMatches && now < cache.expiresAt) {
		// Keep using the still-valid credential while a fresh one is fetched in the background.
		void refreshCloudflareTurnCache(channel, endpoint, ttlSeconds);
		return cache.iceServers;
	}
	const failure = cloudflareFailures.get(cacheKey);
	if (failure && failure.keyId === endpoint.keyId && now < failure.until) {
		return [];
	}
	return refreshCloudflareTurnCache(channel, endpoint, ttlSeconds);
}

export function findChannel(channelId: string): TurnChannel | undefined {
	return getTurnChannels().find(channel => channel.id === channelId);
}

export async function getChannelRelayIceServers(
	channelId: string,
	endpointId?: string | null,
): Promise<RtcIceServer[]> {
	const channel = findChannel(channelId);
	if (!channel) {
		return [];
	}
	const endpoint =
		(endpointId
			? channel.endpoints.find(candidate => candidate.id === endpointId)
			: undefined) ?? channel.endpoints[0];
	if (!endpoint) {
		return [];
	}
	if (endpoint.staticIceServers) {
		return endpoint.staticIceServers;
	}
	return getCloudflareTurnIceServers(channel, endpoint);
}

/** First channel/endpoint that can produce credentials; kept for the single-channel callers. */
export async function getRelayIceServers(): Promise<RtcIceServer[]> {
	for (const channel of getTurnChannels()) {
		for (const endpoint of channel.endpoints) {
			const iceServers = await getChannelRelayIceServers(channel.id, endpoint.id);
			if (iceServers.length > 0) {
				return iceServers;
			}
		}
	}
	return [];
}

export function hasRelayConfigured(): boolean {
	return getTurnChannels().length > 0;
}

/** Fetch every channel endpoint's credentials in the background so the first join does not wait. */
export async function warmRelayChannels(): Promise<void> {
	const work: Promise<RtcIceServer[]>[] = [];
	for (const channel of getTurnChannels()) {
		for (const endpoint of channel.endpoints) {
			work.push(getChannelRelayIceServers(channel.id, endpoint.id));
		}
	}
	await Promise.all(work);
}

/**
 * The list handed to clients. Withholding relay candidates is the cost brake: direct connections
 * keep working for free, while peers that would need a relay simply fail to connect.
 */
export async function getVoiceIceServers(
	includeRelay: boolean,
	channelId?: string | null,
	endpointId?: string | null,
): Promise<RtcIceServer[]> {
	const direct = getDirectIceServers();
	if (!includeRelay) {
		return direct;
	}
	if (channelId) {
		const channel = findChannel(channelId);
		if (!channel) {
			return direct;
		}
		return [
			...direct,
			...(await getChannelRelayIceServers(
				channel.id,
				endpointId ?? channel.endpoints[0]?.id ?? null,
			)),
		];
	}
	for (const channel of getTurnChannels()) {
		for (const endpoint of channel.endpoints) {
			const iceServers = await getChannelRelayIceServers(channel.id, endpoint.id);
			if (iceServers.length > 0) {
				return [...direct, ...iceServers];
			}
		}
	}
	return direct;
}
