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

interface CloudflareTurnConfig {
	keyId: string;
	apiToken: string;
	ttlSeconds: number;
}

interface CloudflareTurnCache {
	keyId: string;
	ttlSeconds: number;
	iceServers: RtcIceServer[];
	refreshAt: number;
	expiresAt: number;
}

let cloudflareTurnCache: CloudflareTurnCache | null = null;
let cloudflareTurnFetch: Promise<RtcIceServer[]> | null = null;
let cloudflareTurnFailure: { keyId: string; until: number } | null = null;

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

export function isCloudflareTurnConfigured(): boolean {
	const config = getCloudflareTurnConfig();
	return config.keyId.length > 0 && config.apiToken.length > 0;
}

function getCloudflareTurnConfig(): CloudflareTurnConfig {
	const keyId = (conf.get("voice.cloudflare_turn.key_id") ?? "").trim();
	const apiToken = (conf.get("voice.cloudflare_turn.api_token") ?? "").trim();
	const configuredTtl = Number(conf.get("voice.cloudflare_turn.ttl_seconds"));
	const effectiveTtl = Number.isFinite(configuredTtl)
		? configuredTtl
		: CLOUDFLARE_TURN_DEFAULT_TTL_SECONDS;
	const ttlSeconds = Math.min(
		Math.max(effectiveTtl, CLOUDFLARE_TURN_MIN_TTL_SECONDS),
		CLOUDFLARE_TURN_MAX_TTL_SECONDS,
	);
	return { keyId, apiToken, ttlSeconds };
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

async function fetchCloudflareTurnIceServers(
	config: CloudflareTurnConfig,
): Promise<RtcIceServer[]> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), CLOUDFLARE_TURN_TIMEOUT_MS);
	try {
		const response = await fetch(
			`${CLOUDFLARE_TURN_CREDENTIALS_URL}/${encodeURIComponent(
				config.keyId,
			)}/credentials/generate-ice-servers`,
			{
				method: "POST",
				headers: {
					Authorization: `Bearer ${config.apiToken}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({ ttl: config.ttlSeconds }),
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

async function refreshCloudflareTurnCache(config: CloudflareTurnConfig): Promise<RtcIceServer[]> {
	if (cloudflareTurnFetch) {
		return cloudflareTurnFetch;
	}
	const fetchPromise = (async () => {
		try {
			const iceServers = await fetchCloudflareTurnIceServers(config);
			const now = Date.now();
			cloudflareTurnCache = {
				keyId: config.keyId,
				ttlSeconds: config.ttlSeconds,
				iceServers,
				refreshAt: now + config.ttlSeconds * 1000 * CLOUDFLARE_TURN_REFRESH_RATIO,
				expiresAt: now + config.ttlSeconds * 1000,
			};
			cloudflareTurnFailure = null;
			return iceServers;
		} catch (e) {
			log.warn(`Cloudflare TURN credentials are unavailable: ${e}`);
			cloudflareTurnFailure = {
				keyId: config.keyId,
				until: Date.now() + CLOUDFLARE_TURN_FAILURE_COOLDOWN_MS,
			};
			const cache = cloudflareTurnCache;
			if (cache && cache.keyId === config.keyId && cache.expiresAt > Date.now()) {
				return cache.iceServers;
			}
			return [];
		} finally {
			cloudflareTurnFetch = null;
		}
	})();
	cloudflareTurnFetch = fetchPromise;
	return fetchPromise;
}

async function getCloudflareTurnIceServers(): Promise<RtcIceServer[]> {
	const config = getCloudflareTurnConfig();
	if (config.keyId.length === 0 || config.apiToken.length === 0) {
		return [];
	}
	const now = Date.now();
	const cache = cloudflareTurnCache;
	const cacheMatches =
		cache !== null && cache.keyId === config.keyId && cache.ttlSeconds === config.ttlSeconds;
	if (cacheMatches && now < cache.refreshAt) {
		return cache.iceServers;
	}
	if (cacheMatches && now < cache.expiresAt) {
		// Keep using the still-valid credential while a fresh one is fetched in the background.
		void refreshCloudflareTurnCache(config);
		return cache.iceServers;
	}
	if (cloudflareTurnFailure?.keyId === config.keyId && now < cloudflareTurnFailure.until) {
		return [];
	}
	return refreshCloudflareTurnCache(config);
}

/**
 * Relay candidates. Cloudflare's short-lived credentials are preferred when configured; a static
 * `VOICE_TURN_ICE_SERVERS` list (for example a self-hosted coturn) remains the fallback. An empty
 * list is valid: the deployment then only supports direct connections.
 */
export async function getRelayIceServers(): Promise<RtcIceServer[]> {
	if (isCloudflareTurnConfigured()) {
		const cloudflareIceServers = await getCloudflareTurnIceServers();
		if (cloudflareIceServers.length > 0) {
			return cloudflareIceServers;
		}
	}
	return getStaticRelayIceServers();
}

export function hasRelayConfigured(): boolean {
	return isCloudflareTurnConfigured() || getStaticRelayIceServers().length > 0;
}

/**
 * The list handed to clients. Withholding relay candidates is the cost brake: direct connections
 * keep working for free, while peers that would need a relay simply fail to connect.
 */
export async function getVoiceIceServers(includeRelay: boolean): Promise<RtcIceServer[]> {
	const direct = getDirectIceServers();
	if (!includeRelay) {
		return direct;
	}
	return [...direct, ...(await getRelayIceServers())];
}
