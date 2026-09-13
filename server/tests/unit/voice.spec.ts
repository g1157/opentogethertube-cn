import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { conf } from "../../ott-config.js";
import {
	getDirectIceServers,
	getRelayIceServers,
	getVoiceIceServers,
	hasRelayConfigured,
	isVoiceEnabled,
} from "../../voice.js";

const logger = vi.hoisted(() => ({
	error: vi.fn(),
	warn: vi.fn(),
	info: vi.fn(),
	debug: vi.fn(),
}));
vi.mock("../../logger.js", () => ({ getLogger: () => logger }));

const DEFAULT_STUN = ["stun:stun.l.google.com:19302", "stun:stun.cloudflare.com:3478"];
const TURN = JSON.stringify([
	{ urls: "turn:turn.example.test:3478", username: "user", credential: "secret" },
]);

describe("voice configuration", () => {
	let previousIce: string;
	let previousTurn: string;
	let previousEnabled: boolean;

	beforeAll(() => {
		previousIce = conf.get("voice.ice_servers");
		previousTurn = conf.get("voice.turn_ice_servers");
		previousEnabled = conf.get("voice.enabled");
	});

	afterAll(() => {
		conf.set("voice.ice_servers", previousIce);
		conf.set("voice.turn_ice_servers", previousTurn);
		conf.set("voice.enabled", previousEnabled);
	});

	it("is disabled unless explicitly enabled", () => {
		conf.set("voice.enabled", false);
		expect(isVoiceEnabled()).toBe(false);
		conf.set("voice.enabled", true);
		expect(isVoiceEnabled()).toBe(true);
	});

	it("falls back to STUN defaults when nothing is configured", () => {
		conf.set("voice.ice_servers", "");
		expect(getDirectIceServers().map(server => server.urls)).toEqual(DEFAULT_STUN);
	});

	it("parses configured direct ICE servers", () => {
		conf.set("voice.ice_servers", JSON.stringify([{ urls: "stun:stun.example.test:3478" }]));
		expect(getDirectIceServers().map(server => server.urls)).toEqual([
			"stun:stun.example.test:3478",
		]);
	});

	it("has no relay servers unless configured", () => {
		conf.set("voice.turn_ice_servers", "");
		expect(getRelayIceServers()).toEqual([]);
		expect(hasRelayConfigured()).toBe(false);
	});

	it("withholds relay servers when asked, keeping direct servers", () => {
		conf.set("voice.ice_servers", "");
		conf.set("voice.turn_ice_servers", TURN);
		expect(hasRelayConfigured()).toBe(true);
		expect(getVoiceIceServers(false).map(server => server.urls)).toEqual(DEFAULT_STUN);
		const withRelay = getVoiceIceServers(true);
		expect(withRelay).toHaveLength(DEFAULT_STUN.length + 1);
		expect(withRelay.at(-1)).toMatchObject({ username: "user", credential: "secret" });
	});

	it("degrades to STUN defaults on malformed JSON instead of throwing", () => {
		conf.set("voice.ice_servers", "{ not json");
		expect(getDirectIceServers().map(server => server.urls)).toEqual(DEFAULT_STUN);
		expect(logger.error).toHaveBeenCalled();
	});

	it("rejects entries that are missing urls", () => {
		conf.set("voice.ice_servers", JSON.stringify([{ username: "user" }]));
		expect(getDirectIceServers().map(server => server.urls)).toEqual(DEFAULT_STUN);
		expect(logger.error).toHaveBeenCalled();
	});

	it("rejects an empty array rather than handing clients nothing", () => {
		conf.set("voice.ice_servers", "[]");
		expect(getDirectIceServers().map(server => server.urls)).toEqual(DEFAULT_STUN);
	});

	it("treats malformed relay configuration as no relay at all", () => {
		conf.set("voice.turn_ice_servers", "{ not json");
		expect(getRelayIceServers()).toEqual([]);
		expect(hasRelayConfigured()).toBe(false);
	});
});
