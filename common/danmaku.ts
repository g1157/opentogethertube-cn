/** Decoded upstream XML budget, independent of compressed Content-Length. */
export const DANMAKU_MAX_XML_BYTES = 8 * 1024 * 1024;
export const DANMAKU_MAX_COMMENTS = 100_000;
export const DANMAKU_MAX_TEXT_LENGTH = 2000;
export const DANMAKU_CACHE_MAX_BYTES = 32 * 1024 * 1024;
export const DANMAKU_MAX_CONCURRENT_DOWNLOADS = 4;

const XML_TEXT_SECTIONS = [
	["<!--", "-->"],
	["<![CDATA[", "]]>"],
	["<?", "?>"],
] as const;
const XML_WHITESPACE = " \t\r\n";

/** Reject pathological tracks with a linear scan before constructing an XML document. */
export function assertDanmakuTrack(xml: string): void {
	if (
		xml.length > DANMAKU_MAX_XML_BYTES ||
		new TextEncoder().encode(xml).byteLength > DANMAKU_MAX_XML_BYTES
	) {
		throw new Error("Danmaku XML exceeds byte limit");
	}
	let position = 0;
	let comments = 0;
	while (position < xml.length) {
		const opening = xml.indexOf("<", position);
		if (opening < 0) {
			break;
		}
		let skippedText = false;
		for (const [start, end] of XML_TEXT_SECTIONS) {
			if (xml.startsWith(start, opening)) {
				const closing = xml.indexOf(end, opening + start.length);
				position = closing < 0 ? xml.length : closing + end.length;
				skippedText = true;
				break;
			}
		}
		if (skippedText) {
			continue;
		}
		if (xml[opening + 1] === "!") {
			let name = opening + 2;
			while (name < xml.length && XML_WHITESPACE.includes(xml[name])) {
				name++;
			}
			if (
				xml.slice(name, name + 7).toUpperCase() === "DOCTYPE" ||
				xml.slice(name, name + 6).toUpperCase() === "ENTITY"
			) {
				throw new Error(
					"Danmaku XML must not contain document type or entity declarations",
				);
			}
		}
		const boundary = xml[opening + 2];
		if (
			xml[opening + 1] === "d" &&
			boundary !== undefined &&
			(XML_WHITESPACE + "/>").includes(boundary)
		) {
			if (++comments > DANMAKU_MAX_COMMENTS) {
				throw new Error("Danmaku XML exceeds comment limit");
			}
		}
		// Attribute text is not markup. Scan each tag once, respecting quoted values.
		position = opening + 1;
		let quote: string | undefined;
		while (position < xml.length) {
			const char = xml[position++];
			if (quote) {
				if (char === quote) {
					quote = undefined;
				}
			} else if (char === '"' || char === "'") {
				quote = char;
			} else if (char === ">") {
				break;
			}
		}
	}
}
