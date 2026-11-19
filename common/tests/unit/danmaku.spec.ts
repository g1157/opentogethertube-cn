import { describe, expect, it } from "vitest";
import { assertDanmakuTrack, DANMAKU_MAX_COMMENTS, DANMAKU_MAX_XML_BYTES } from "../../danmaku.js";

describe("danmaku track preflight", () => {
	it("accepts normal comments, escaped text and a plain XML declaration", () => {
		expect(() =>
			assertDanmakuTrack('<?xml version="1.0"?><i><d p="1,1">&lt;hello&gt;</d></i>'),
		).not.toThrow();
	});

	it("rejects oversized XML before a document is constructed", () => {
		expect(() => assertDanmakuTrack(" ".repeat(DANMAKU_MAX_XML_BYTES + 1))).toThrow(
			"byte limit",
		);
	});

	it.each(["DOCTYPE", "ENTITY"])("rejects %s declarations", declaration => {
		expect(() => assertDanmakuTrack("<!" + declaration + " i><i></i>")).toThrow("declarations");
	});

	it("bounds comment count before parsing and accepts the exact limit", () => {
		const limit = "<d/>".repeat(DANMAKU_MAX_COMMENTS);
		expect(() => assertDanmakuTrack(limit)).not.toThrow();
		expect(() => assertDanmakuTrack(limit + "<d/>")).toThrow("comment limit");
	});
});

describe("danmaku lexical boundaries", () => {
	it("does not interpret comment or CDATA text as entity declarations", () => {
		const xml = '<i><!-- <!DOCTYPE example> --><d p="1,1"><![CDATA[<!ENTITY hello>]]></d></i>';
		expect(() => assertDanmakuTrack(xml)).not.toThrow();
	});

	it("only counts real elements, not CDATA, comments or processing instructions", () => {
		const text = "<d/>".repeat(DANMAKU_MAX_COMMENTS + 1);
		for (const xml of [
			"<i><![CDATA[" + text + "]]></i>",
			"<i><!--" + text + "--></i>",
			"<?example " + text + "?><i/>",
		]) {
			expect(() => assertDanmakuTrack(xml)).not.toThrow();
		}
	});

	it("still rejects a declaration that follows a skipped comment", () => {
		expect(() =>
			assertDanmakuTrack('<!-- safe --><!DOCTYPE i [<!ENTITY x "text">]><i/>'),
		).toThrow("declarations");
	});

	it("measures UTF-8 bytes rather than string code units", () => {
		const text = "\u4e2d".repeat(Math.floor(DANMAKU_MAX_XML_BYTES / 3));
		expect(() => assertDanmakuTrack(text)).not.toThrow();
		expect(() => assertDanmakuTrack(text + "\u4e2d")).toThrow("byte limit");
	});
});
