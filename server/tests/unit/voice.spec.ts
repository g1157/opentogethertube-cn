import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { conf } from "../../ott-config.js";
import {
	getDirectIceServers,
	getRelayIceServers,
	getVoiceIceServers,
	hasRelayConfigured,
	isCloudflareTurnConfigured,
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

function mockCloudflareResponse(iceServers: unknown, status = 200) {
	const fetchMock = vi.fn().mockResolvedValue({
		ok: status >= 200 && status < 300,
		status,
		json: async () => ({ iceServers }),
	} as unknown as Response);
	vi.stubGlobal("fetch", fetchMock);
	return fetchMock;
}

function cloudflareIceServers() {
	return [
		{ urls: ["stun:stun.cloudflare.com:3478"] },
		{
			urls: [
				"turn:turn.cloudflare.com:3478?transport=udp",
				"turn:turn.cloudflare.com:53?transport=udp",
				"turns:turn.cloudflare.com:443?transport=tcp",
			],
			username: "cf-user",
			credential: "cf-secret",
		},
	];
}

describe("voice configuration", () => {
	const previous = {
		ice: "",
		turn: "",
		channels: "",
		enabled: false,
		cloudflareKeyId: "",
		cloudflareApiToken: "",
		cloudflareTtl: 0,
	};

	beforeAll(() => {
		previous.ice = conf.get("voice.ice_servers");
		previous.turn = conf.get("voice.turn_ice_servers");
		previous.channels = conf.get("voice.turn_channels");
		previous.enabled = conf.get("voice.enabled");
		previous.cloudflareKeyId = conf.get("voice.cloudflare_turn.key_id");
		previous.cloudflareApiToken = conf.get("voice.cloudflare_turn.api_token");
		previous.cloudflareTtl = conf.get("voice.cloudflare_turn.ttl_seconds");
	});

	afterAll(() => {
		conf.set("voice.ice_servers", previous.ice);
		conf.set("voice.turn_ice_servers", previous.turn);
		conf.set("voice.turn_channels", previous.channels);
		conf.set("voice.enabled", previous.enabled);
		conf.set("voice.cloudflare_turn.key_id", previous.cloudflareKeyId);
		conf.set("voice.cloudflare_turn.api_token", previous.cloudflareApiToken);
		conf.set("voice.cloudflare_turn.ttl_seconds", previous.cloudflareTtl);
	});

	beforeEach(() => {
		vi.unstubAllGlobals();
		logger.error.mockClear();
		logger.warn.mockClear();
		conf.set("voice.ice_servers", "");
		conf.set("voice.turn_ice_servers", "");
		conf.set("voice.turn_channels", "");
		conf.set("voice.cloudflare_turn.key_id", "");
		conf.set("voice.cloudflare_turn.api_token", "");
		conf.set("voice.cloudflare_turn.ttl_seconds", 86_400);
	});

	it("is disabled unless explicitly enabled", () => {
		conf.set("voice.enabled", false);
		expect(isVoiceEnabled()).toBe(false);
		conf.set("voice.enabled", true);
		expect(isVoiceEnabled()).toBe(true);
	});

	it("falls back to STUN defaults when nothing is configured", () => {
		expect(getDirectIceServers().map(server => server.urls)).toEqual(DEFAULT_STUN);
	});

	it("parses configured direct ICE servers", () => {
		conf.set("voice.ice_servers", JSON.stringify([{ urls: "stun:stun.example.test:3478" }]));
		expect(getDirectIceServers().map(server => server.urls)).toEqual([
			"stun:stun.example.test:3478",
		]);
	});

	it("has no relay servers unless configured", async () => {
		expect(await getRelayIceServers()).toEqual([]);
		expect(hasRelayConfigured()).toBe(false);
		expect(isCloudflareTurnConfigured()).toBe(false);
	});

	it("withholds relay servers when asked, keeping direct servers", async () => {
		conf.set("voice.turn_ice_servers", TURN);
		expect(hasRelayConfigured()).toBe(true);
		expect((await getVoiceIceServers(false)).map(server => server.urls)).toEqual(DEFAULT_STUN);
		const withRelay = await getVoiceIceServers(true);
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

	it("treats malformed relay configuration as no relay at all", async () => {
		conf.set("voice.turn_ice_servers", "{ not json");
		expect(await getRelayIceServers()).toEqual([]);
		expect(hasRelayConfigured()).toBe(false);
	});

	it("mints Cloudflare TURN credentials and filters the browser-blocked port 53", async () => {
		conf.set("voice.cloudflare_turn.key_id", "cf-success-1");
		conf.set("voice.cloudflare_turn.api_token", "cf-token");
		conf.set("voice.cloudflare_turn.ttl_seconds", 3600);
		const fetchMock = mockCloudflareResponse(cloudflareIceServers());

		const relay = await getRelayIceServers();
		expect(relay).toHaveLength(1);
		expect(relay[0]).toMatchObject({ username: "cf-user", credential: "cf-secret" });
		expect(relay[0].urls).toEqual([
			"turn:turn.cloudflare.com:3478?transport=udp",
			"turns:turn.cloudflare.com:443?transport=tcp",
		]);
		expect(hasRelayConfigured()).toBe(true);

		const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(url).toBe(
			"https://rtc.live.cloudflare.com/v1/turn/keys/cf-success-1/credentials/generate-ice-servers",
		);
		expect(init.method).toBe("POST");
		expect(init.headers).toMatchObject({ Authorization: "Bearer cf-token" });
		expect(JSON.parse(init.body as string)).toEqual({ ttl: 3600 });

		const all = await getVoiceIceServers(true);
		expect(all).toHaveLength(DEFAULT_STUN.length + 1);
	});

	it("reuses a cached Cloudflare credential", async () => {
		conf.set("voice.cloudflare_turn.key_id", "cf-cache-1");
		conf.set("voice.cloudflare_turn.api_token", "cf-token");
		conf.set("voice.cloudflare_turn.ttl_seconds", 3600);
		const fetchMock = mockCloudflareResponse(cloudflareIceServers());

		await getRelayIceServers();
		await getRelayIceServers();
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("falls back to the static relay list when Cloudflare fails", async () => {
		conf.set("voice.turn_ice_servers", TURN);
		conf.set("voice.cloudflare_turn.key_id", "cf-fail-1");
		conf.set("voice.cloudflare_turn.api_token", "cf-token");
		mockCloudflareResponse([], 500);

		const relay = await getRelayIceServers();
		expect(relay).toHaveLength(1);
		expect(relay[0]).toMatchObject({ username: "user", credential: "secret" });
		expect(logger.warn).toHaveBeenCalled();
	});

	it("clamps the Cloudflare credential TTL to the supported range", async () => {
		conf.set("voice.cloudflare_turn.key_id", "cf-ttl-low");
		conf.set("voice.cloudflare_turn.api_token", "cf-token");
		conf.set("voice.cloudflare_turn.ttl_seconds", 0);
		const lowFetch = mockCloudflareResponse(cloudflareIceServers());
		await getRelayIceServers();
		const [, lowInit] = lowFetch.mock.calls[0] as [string, RequestInit];
		expect(JSON.parse(lowInit.body as string)).toEqual({ ttl: 300 });

		conf.set("voice.cloudflare_turn.key_id", "cf-ttl-high");
		conf.set("voice.cloudflare_turn.ttl_seconds", 999_999);
		const highFetch = mockCloudflareResponse(cloudflareIceServers());
		await getRelayIceServers();
		const [, highInit] = highFetch.mock.calls[0] as [string, RequestInit];
		expect(JSON.parse(highInit.body as string)).toEqual({ ttl: 172_800 });
	});

	it("treats a Cloudflare response without TURN entries as relay unavailable", async () => {
		conf.set("voice.cloudflare_turn.key_id", "cf-stun-only");
		conf.set("voice.cloudflare_turn.api_token", "cf-token");
		mockCloudflareResponse([{ urls: ["stun:stun.cloudflare.com:3478"] }]);

		expect(await getRelayIceServers()).toEqual([]);
		expect(hasRelayConfigured()).toBe(true);
	});
});
