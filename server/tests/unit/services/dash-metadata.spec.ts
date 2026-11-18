import { afterEach, describe, expect, it } from "vitest";
import {
	MAX_DASH_XML_DEPTH,
	MAX_DASH_XML_ELEMENTS,
	parseDashMetadata,
} from "../../../services/parsing/dash-metadata.js";

describe("bounded DASH metadata parsing", () => {
	let immediate: ReturnType<typeof setImmediate> | undefined;
	afterEach(() => {
		clearImmediate(immediate);
	});

	it("supports namespaces, inherited dimensions and multiple video representations", async () => {
		const metadata = await parseDashMetadata(`
<d:MPD xmlns:d="urn:mpeg:DASH:schema:MPD:2011" mediaPresentationDuration="PT60S">
  <d:Period>
    <d:AdaptationSet contentType="video" width="1920" height="1080">
      <d:Representation bandwidth="4300000"/>
      <d:Representation bandwidth="2100000" width="1280" height="720"/>
    </d:AdaptationSet>
    <d:AdaptationSet contentType="audio">
      <d:Representation bandwidth="9999999" width="8000" height="4000"/>
    </d:AdaptationSet>
  </d:Period>
  <d:ProgramInformation><d:Title><![CDATA[Review <video>]]></d:Title></d:ProgramInformation>
</d:MPD>`);
		expect(metadata).toEqual({
			dynamic: false,
			duration: "PT60S",
			title: "Review <video>",
			width: 1920,
			height: 1080,
			topBandwidth: 4_300_000,
			topResolution: "1920x1080",
		});
	});

	it.each([
		'<MPD mediaPresentationDuration="PT60S"><Period></MPD>',
		'<MPD mediaPresentationDuration="PT60S"/><MPD/>',
		'<MPD xmlns="urn:other"/>',
		'<MPD mediaPresentationDuration="PT60S" mediaPresentationDuration="PT5S"/>',
		'<!DOCTYPE MPD SYSTEM "https://example.com/metadata.dtd"><MPD/>',
	])("rejects invalid or unsupported XML: %s", async xml => {
		await expect(parseDashMetadata(xml)).rejects.toThrow();
	});

	it("rejects excessive nesting before growing an unbounded element stack", async () => {
		const depth = MAX_DASH_XML_DEPTH + 1;
		await expect(
			parseDashMetadata(`<MPD>${"<Period>".repeat(depth)}${"</Period>".repeat(depth)}</MPD>`),
		).rejects.toThrow();
	});

	it("rejects too many elements even when the response fits the byte limit", async () => {
		await expect(
			parseDashMetadata(`<MPD>${"<Period/>".repeat(MAX_DASH_XML_ELEMENTS)}</MPD>`),
		).rejects.toThrow();
	});

	it("rejects too many attributes and an oversized title", async () => {
		const attributes = Array.from({ length: 70 }, (_value, index) => `a${index}="x"`).join(" ");
		await expect(parseDashMetadata(`<MPD ${attributes}/>`)).rejects.toThrow();
		await expect(
			parseDashMetadata(
				`<MPD><ProgramInformation><Title>${"x".repeat(9000)}</Title></ProgramInformation></MPD>`,
			),
		).rejects.toThrow();
	});

	it("lets an event-loop task run while parsing a multi-chunk manifest", async () => {
		let ran = false;
		immediate = setImmediate(() => {
			ran = true;
		});
		const metadata = await parseDashMetadata(
			`<MPD mediaPresentationDuration="PT60S"><!--${"x".repeat(64 * 1024)}--></MPD>`,
		);
		expect(metadata.duration).toBe("PT60S");
		expect(ran).toBe(true);
	});
});
