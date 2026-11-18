import { afterEach, describe, expect, it, vi } from "vitest";
import dns from "node:dns/promises";
import axios from "axios";
import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import {
	assertPublicMediaUrl,
	isPrivateAddress,
	RunFfprobe,
	StreamFfprobe,
} from "../../../ffprobe.js";
import { getSubtitleFormatFromUrl, isPublicSubtitleUrl } from "ott-common/subtitles.js";
import { girigiriTrackPath } from "../../../api/danmaku.js";

const PRIVATE_OR_LOCAL = /private|local/i;
const PROTOCOL_ERROR = /protocol/i;

describe("outbound address guard", () => {
	it.each([
		"0.0.0.0",
		"10.0.0.1",
		"10.255.255.255",
		"100.64.0.1",
		"127.0.0.1",
		"169.254.169.254",
		"172.16.0.1",
		"172.31.255.255",
		"192.168.1.1",
		"192.0.0.1",
		"198.18.0.1",
		"224.0.0.1",
		"255.255.255.255",
		"::",
		"::1",
		"fc00::1",
		"fd00::1",
		"fe80::1",
		"ff02::1",
		"::ffff:127.0.0.1",
		"::ffff:7f00:1",
		// IPv4-embedded transition formats can reach loopback on a NAT64/6to4 host.
		"64:ff9b::7f00:1",
		"2002:7f00:1::",
		// Deprecated site-local space is still local on existing hosts.
		"fec0::1",
	])("treats %s as private or local", address => {
		expect(isPrivateAddress(address)).toBe(true);
	});

	it.each([
		"8.8.8.8",
		"1.1.1.1",
		"93.184.216.34",
		"2001:4860:4860::8888",
		"2606:4700:4700::1111",
	])("treats %s as public", address => {
		expect(isPrivateAddress(address)).toBe(false);
	});
});

describe("assertPublicMediaUrl", () => {
	afterEach(() => {
		vi.unstubAllEnvs();
		vi.restoreAllMocks();
		vi.useRealTimers();
	});

	it.each([
		"http://127.0.0.1/",
		"http://169.254.169.254/latest/meta-data/",
		"http://[::1]/",
		"http://0x7f000001/",
		"http://2130706433/",
		"http://017700000001/",
		"http://localhost/",
		"file:///etc/passwd",
		"gopher://127.0.0.1:6379/_INFO",
	])("rejects %s", async url => {
		vi.stubEnv("NODE_ENV", "production");
		await expect(assertPublicMediaUrl(url)).rejects.toThrow();
	});

	it("accepts a literal public address", async () => {
		vi.stubEnv("NODE_ENV", "production");
		await expect(assertPublicMediaUrl("http://8.8.8.8/")).resolves.toBeUndefined();
	});

	it("bounds a DNS lookup that never settles", async () => {
		vi.stubEnv("NODE_ENV", "production");
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		vi.spyOn(dns, "lookup").mockImplementation(
			() =>
				new Promise(() => {
					// Simulate a resolver that never answers.
				}),
		);
		const checked = expect(
			assertPublicMediaUrl("https://slow.example.com/x.mp4"),
		).rejects.toThrow("Media DNS lookup timed out");
		await vi.advanceTimersByTimeAsync(5000);
		await checked;
		expect(vi.getTimerCount()).toBe(0);
	});

	it("rejects a literal IPv6 loopback without asking DNS to resolve its brackets", async () => {
		vi.stubEnv("NODE_ENV", "production");
		const lookup = vi.spyOn(dns, "lookup").mockImplementation(
			() =>
				new Promise(() => {
					// A literal address must bypass this unresolved lookup.
				}),
		);
		let rejected = false;
		const checked = (async () => {
			try {
				await assertPublicMediaUrl("http://[::1]/");
			} catch {
				rejected = true;
			}
		})();
		await Promise.resolve();
		await Promise.resolve();
		expect(rejected).toBe(true);
		expect(lookup).not.toHaveBeenCalled();
		await checked;
	});

	it.each([
		["NAT64", "64:ff9b::7f00:1"],
		["6to4", "2002:7f00:1::"],
		["site-local", "fec0::1"],
	])("rejects a hostname that resolves into %s space", async (_label, address) => {
		vi.stubEnv("NODE_ENV", "production");
		vi.spyOn(dns, "lookup").mockResolvedValue([{ address, family: 6 }] as any);
		await expect(assertPublicMediaUrl("http://attacker.example/")).rejects.toThrow();
	});

	it("rejects when any resolved address is private", async () => {
		vi.stubEnv("NODE_ENV", "production");
		vi.spyOn(dns, "lookup").mockResolvedValue([
			{ address: "93.184.216.34", family: 4 },
			{ address: "10.0.0.1", family: 4 },
		] as any);
		await expect(assertPublicMediaUrl("http://attacker.example/")).rejects.toThrow();
	});
});

describe("redirect handling in the download strategies", () => {
	afterEach(() => {
		vi.unstubAllEnvs();
		vi.restoreAllMocks();
	});

	it("starts ffprobe with the validated final URL instead of replaying the original redirect", async () => {
		vi.stubEnv("NODE_ENV", "production");
		vi.spyOn(dns, "lookup").mockResolvedValue([{ address: "93.184.216.34", family: 4 }] as any);
		const finalUrl = "https://cdn.example.com/final.mp4";
		vi.spyOn(axios, "get")
			.mockResolvedValueOnce({
				status: 302,
				headers: { location: finalUrl },
				data: { destroy: vi.fn() },
			} as any)
			.mockResolvedValueOnce({
				status: 200,
				headers: {},
				data: { destroy: vi.fn() },
			} as any);
		const child = Object.assign(new EventEmitter(), {
			stdout: new EventEmitter(),
			stderr: new EventEmitter(),
			kill: vi.fn(),
		});
		const spawn = vi.spyOn(childProcess, "spawn").mockImplementation(() => {
			queueMicrotask(() => {
				child.stdout.emit("data", Buffer.from("{}"));
				child.emit("close", 0);
			});
			return child as unknown as childProcess.ChildProcessWithoutNullStreams;
		});

		await expect(
			new RunFfprobe().getFileInfo("https://example.com/start.mp4"),
		).resolves.toEqual({});
		const args = spawn.mock.calls[0][1] as string[];
		expect(args[args.indexOf("-i") + 1]).toBe(finalUrl);
	});

	it("validates every redirect hop before issuing the next request", async () => {
		vi.stubEnv("NODE_ENV", "production");
		vi.spyOn(dns, "lookup").mockImplementation(async (host: any) => {
			const value = String(host);
			if (value === "attacker.example") {
				return [{ address: "93.184.216.34", family: 4 }] as any;
			}
			return [{ address: value, family: 4 }] as any;
		});
		const get = vi.spyOn(axios, "get").mockResolvedValue({
			status: 302,
			headers: { location: "http://169.254.169.254/latest/meta-data/" },
			data: { destroy: vi.fn() },
		} as any);

		await expect(
			new StreamFfprobe().getFileInfo("http://attacker.example/x.mp4"),
		).rejects.toThrow(PRIVATE_OR_LOCAL);
		expect(get).toHaveBeenCalledTimes(1);
	});

	it("resolves redirects before handing the URL to ffprobe", async () => {
		vi.stubEnv("NODE_ENV", "production");
		vi.spyOn(dns, "lookup").mockImplementation(async (host: any) => {
			const value = String(host);
			if (value === "attacker.example") {
				return [{ address: "93.184.216.34", family: 4 }] as any;
			}
			return [{ address: value, family: 4 }] as any;
		});
		vi.spyOn(axios, "get").mockResolvedValue({
			status: 302,
			headers: { location: "http://169.254.169.254/latest/meta-data/" },
			data: { destroy: vi.fn() },
		} as any);
		const spawn = vi.spyOn(childProcess, "spawn");

		await expect(new RunFfprobe().getFileInfo("http://attacker.example/x.mp4")).rejects.toThrow(
			PRIVATE_OR_LOCAL,
		);
		expect(spawn).not.toHaveBeenCalled();
	});

	it("rejects a redirect to a non-HTTP protocol", async () => {
		vi.stubEnv("NODE_ENV", "production");
		vi.spyOn(dns, "lookup").mockResolvedValue([{ address: "93.184.216.34", family: 4 }] as any);
		const get = vi.spyOn(axios, "get").mockResolvedValue({
			status: 302,
			headers: { location: "file:///etc/passwd" },
			data: { destroy: vi.fn() },
		} as any);

		await expect(
			new StreamFfprobe().getFileInfo("http://attacker.example/x.mp4"),
		).rejects.toThrow(PROTOCOL_ERROR);
		expect(get).toHaveBeenCalledTimes(1);
	});
});

describe("subtitle URL guard", () => {
	it("accepts a public HTTPS link", () => {
		expect(isPublicSubtitleUrl("https://example.com/subs.vtt")).toBe(true);
		expect(isPublicSubtitleUrl("http://example.com/subs.ass")).toBe(true);
	});

	it.each([
		"http://127.0.0.1/subs.vtt",
		"http://192.168.1.10/subs.vtt",
		"http://169.254.169.254/subs.vtt",
		"http://[::1]/subs.vtt",
		"http://localhost/subs.vtt",
		"http://foo.local/subs.vtt",
		"http://foo.internal/subs.vtt",
		"http://user:pass@example.com/subs.vtt",
		"file:///etc/passwd.vtt",
		"ftp://example.com/subs.vtt",
	])("rejects %s", url => {
		expect(isPublicSubtitleUrl(url)).toBe(false);
	});

	it("is bounded by the URL length", () => {
		expect(isPublicSubtitleUrl(`https://example.com/${"x".repeat(2048)}.vtt`)).toBe(false);
	});

	it("is deliberately syntactic; the room layer resolves the host", () => {
		// Room.assertUsableSubtitleUrl calls assertPublicMediaUrl after this check, which is
		// what rejects a public-looking name that resolves to loopback.
		expect(isPublicSubtitleUrl("http://127.0.0.1.nip.io/subs.vtt")).toBe(true);
	});
});

describe("subtitle format detection", () => {
	it.each([
		["https://example.com/a.vtt", "vtt"],
		["https://example.com/a.ASS", "ass"],
		["https://example.com/a.ssa?x=1", "ass"],
		["https://example.com/a.mp4", null],
		["not a url", null],
		["https://example.com/no-extension", null],
	])("maps %s to %s", (url, expected) => {
		expect(getSubtitleFormatFromUrl(url)).toBe(expected);
	});
});

describe("girigiri track path allowlist", () => {
	it("builds a track path only for the girigiri hosts", () => {
		expect(girigiriTrackPath("https://ana.girigirilove.com/a/b/01.mp4")).toBe(
			"https://danmu.girigirilove.com/a/b/01.xml",
		);
		expect(girigiriTrackPath("https://ana.girigirilove.com/a/CHT/b/01.mp4")).toBe(
			"https://danmu.girigirilove.com/a/CHS/b/01.xml",
		);
		expect(girigiriTrackPath("https://ana.girigirilove.com/a/b/index.m3u8")).toBe(
			"https://ana.girigirilove.com/a/b.xml",
		);
	});

	it.each([
		"https://evil.example/a.mp4",
		"https://girigirilove.com.evil.example/a.mp4",
		"https://evilgirigirilove.com/a.mp4",
		"javascript:alert(1)",
		"https://ana.girigirilove.com/no-extension",
		"not a url",
	])("rejects %s", url => {
		expect(girigiriTrackPath(url)).toBeNull();
	});
});
