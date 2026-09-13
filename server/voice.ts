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

/**
 * Relay candidates. An empty list is a valid configuration: it means this deployment only supports
 * direct connections, which cost nothing but fail behind restrictive NAT.
 */
export function getRelayIceServers(): RtcIceServer[] {
	return parseIceServers(conf.get("voice.turn_ice_servers"), "VOICE_TURN_ICE_SERVERS", []);
}

export function hasRelayConfigured(): boolean {
	return getRelayIceServers().length > 0;
}

/**
 * The list handed to clients. Withholding relay candidates is the cost brake: direct connections
 * keep working for free, while peers that would need a relay simply fail to connect.
 */
export function getVoiceIceServers(includeRelay: boolean): RtcIceServer[] {
	return includeRelay
		? [...getDirectIceServers(), ...getRelayIceServers()]
		: getDirectIceServers();
}
