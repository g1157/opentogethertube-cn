import { describe, it, expect } from "vitest";
import {
	getSubtitleFormatFromUrl,
	isPublicSubtitleUrl,
	MAX_SUBTITLE_URL_LENGTH,
	SUBTITLE_CONTENT_TYPES,
} from "../../subtitles.js";

describe("getSubtitleFormatFromUrl", () => {
	it("recognizes .vtt", () => {
		expect(getSubtitleFormatFromUrl("https://example.com/subs.vtt")).toEqual("vtt");
	});

	it("recognizes .ass", () => {
		expect(getSubtitleFormatFromUrl("https://example.com/subs.ass")).toEqual("ass");
	});

	it("recognizes .ssa", () => {
		expect(getSubtitleFormatFromUrl("https://example.com/subs.ssa")).toEqual("ass");
	});

	it("is case-insensitive", () => {
		expect(getSubtitleFormatFromUrl("https://example.com/subs.ASS")).toEqual("ass");
	});

	it("ignores query strings", () => {
		expect(getSubtitleFormatFromUrl("https://example.com/subs.vtt?token=abc")).toEqual("vtt");
	});

	it("returns null for unsupported extensions", () => {
		expect(getSubtitleFormatFromUrl("https://example.com/subs.srt")).toBeNull();
	});

	it("returns null for invalid URLs", () => {
		expect(getSubtitleFormatFromUrl("not a url")).toBeNull();
	});
});

describe("isPublicSubtitleUrl", () => {
	it("accepts public https and http links", () => {
		expect(isPublicSubtitleUrl("https://example.com/subs.vtt")).toBe(true);
		expect(isPublicSubtitleUrl("http://cdn.example.com/a/b/subs.ass")).toBe(true);
	});

	it.each([
		"ftp://example.com/subs.vtt",
		"https://127.0.0.1/subs.vtt",
		"https://192.168.1.10/subs.vtt",
		"https://[::1]/subs.vtt",
		"https://localhost/subs.vtt",
		"https://subs.local/subs.vtt",
		"https://user:pass@example.com/subs.vtt",
		"https://example/subs.vtt",
		"not a url",
	])("rejects %s", value => {
		expect(isPublicSubtitleUrl(value)).toBe(false);
	});

	it("rejects a URL longer than the shared limit", () => {
		const base = "https://example.com/";
		const long = base + "a".repeat(MAX_SUBTITLE_URL_LENGTH);
		expect(isPublicSubtitleUrl(long)).toBe(false);
	});
});

describe("SUBTITLE_CONTENT_TYPES", () => {
	it("maps text/vtt to vtt", () => {
		expect(SUBTITLE_CONTENT_TYPES["text/vtt"]).toEqual("vtt");
	});

	it("maps text/x-ssa to ass", () => {
		expect(SUBTITLE_CONTENT_TYPES["text/x-ssa"]).toEqual("ass");
	});
});
