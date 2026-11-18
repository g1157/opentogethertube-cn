import { performance } from "node:perf_hooks";
import { setImmediate as yieldEventLoop } from "node:timers/promises";
import { SaxesParser, type SaxesTagNS } from "saxes";
import { BadApiArgumentException } from "../../exceptions.js";
import { MAX_MANIFEST_BYTES } from "./manifest-fetch.js";

export const MAX_DASH_XML_DEPTH = 64;
export const MAX_DASH_XML_ELEMENTS = 20_000;
export const DASH_PARSE_BUDGET_MS = 500;
const MAX_ATTRIBUTES = 64;
const MAX_TITLE_LENGTH = 8192;
const XML_CHUNK_LENGTH = 16 * 1024;
const DASH_NAMESPACE = "urn:mpeg:DASH:schema:MPD:2011";

export interface DashMetadata {
	duration?: string;
	dynamic: boolean;
	title?: string;
	width?: number;
	height?: number;
	topBandwidth: number;
	topResolution?: string;
}

interface ElementFrame {
	local: string;
	uri: string;
	width?: number;
	height?: number;
	contentType?: string;
	mimeType?: string;
}

function rejectManifest(reason: string): never {
	throw new BadApiArgumentException("manifest", reason);
}

function attribute(tag: SaxesTagNS, name: string): string | undefined {
	const value = tag.attributes[name];
	return value?.uri === "" ? value.value : undefined;
}

function dimension(value: string | undefined): number | undefined {
	const parsed = Number(value);
	return Number.isInteger(parsed) && parsed > 0 && parsed <= 65_536 ? parsed : undefined;
}

/** Read only preview metadata, without constructing a DOM or expanding a segment timeline. */
export async function parseDashMetadata(text: string): Promise<DashMetadata> {
	if (Buffer.byteLength(text, "utf8") > MAX_MANIFEST_BYTES) {
		rejectManifest("DASH manifest exceeds the size limit");
	}
	const metadata: DashMetadata = { dynamic: false, topBandwidth: 0 };
	const stack: ElementFrame[] = [];
	const parser = new SaxesParser({ xmlns: true, position: false });
	let elements = 0;
	let attributes = 0;
	let titlePriority = 0;
	let activeTitle:
		| { frame: ElementFrame; priority: number; length: number; parts: string[] }
		| undefined;
	let rootSeen = false;

	parser.on("error", () => rejectManifest("Invalid DASH XML"));
	parser.on("doctype", () => rejectManifest("DASH document types are not supported"));
	parser.on("opentagstart", () => {
		if (stack.length >= MAX_DASH_XML_DEPTH || ++elements > MAX_DASH_XML_ELEMENTS) {
			rejectManifest("DASH XML exceeds the structure limit");
		}
		attributes = 0;
	});
	parser.on("attribute", () => {
		if (++attributes > MAX_ATTRIBUTES) {
			rejectManifest("DASH XML exceeds the attribute limit");
		}
	});
	parser.on("opentag", tag => {
		const parent = stack.at(-1);
		const frame: ElementFrame = {
			local: tag.local,
			uri: tag.uri,
			width: dimension(attribute(tag, "width")) ?? parent?.width,
			height: dimension(attribute(tag, "height")) ?? parent?.height,
			contentType: attribute(tag, "contentType") ?? parent?.contentType,
			mimeType: attribute(tag, "mimeType") ?? parent?.mimeType,
		};
		if (!parent) {
			if (rootSeen || tag.local !== "MPD" || (tag.uri !== "" && tag.uri !== DASH_NAMESPACE)) {
				rejectManifest("Expected a DASH MPD root");
			}
			rootSeen = true;
			metadata.duration = attribute(tag, "mediaPresentationDuration");
			metadata.dynamic = attribute(tag, "type") === "dynamic";
		}
		const inDashNamespace = tag.uri === stack[0]?.uri;
		if (
			inDashNamespace &&
			tag.local === "Representation" &&
			parent?.local === "AdaptationSet" &&
			parent.uri === tag.uri &&
			stack.length === 3 &&
			stack[1].local === "Period" &&
			stack[1].uri === tag.uri &&
			frame.contentType !== "audio" &&
			!frame.mimeType?.startsWith("audio/")
		) {
			if (frame.width && frame.height && (!metadata.width || frame.width > metadata.width)) {
				metadata.width = frame.width;
				metadata.height = frame.height;
			}
			const bandwidth = Number(attribute(tag, "bandwidth"));
			if (Number.isSafeInteger(bandwidth) && bandwidth > metadata.topBandwidth) {
				metadata.topBandwidth = bandwidth;
				metadata.topResolution =
					frame.width && frame.height ? `${frame.width}x${frame.height}` : undefined;
			}
		}
		if (inDashNamespace && tag.local === "Title" && parent?.uri === tag.uri) {
			const priority =
				parent.local === "ProgramInformation" && stack.length === 2
					? 2
					: parent.local === "Representation" && stack.length === 4
						? 1
						: 0;
			if (priority > titlePriority) {
				activeTitle = { frame, priority, length: 0, parts: [] };
			}
		}
		stack.push(frame);
	});
	const appendTitle = (part: string) => {
		if (!activeTitle) {
			return;
		}
		activeTitle.length += part.length;
		if (activeTitle.length > MAX_TITLE_LENGTH) {
			rejectManifest("DASH title exceeds the text limit");
		}
		activeTitle.parts.push(part);
	};
	parser.on("text", appendTitle);
	parser.on("cdata", appendTitle);
	parser.on("closetag", () => {
		const frame = stack.pop();
		if (activeTitle && activeTitle.frame === frame) {
			const title = activeTitle.parts.join("").trim();
			if (title) {
				metadata.title = title;
				titlePriority = activeTitle.priority;
			}
			activeTitle = undefined;
		}
	});

	const started = performance.now();
	for (let offset = 0; offset < text.length; offset += XML_CHUNK_LENGTH) {
		parser.write(text.slice(offset, offset + XML_CHUNK_LENGTH));
		if (performance.now() - started > DASH_PARSE_BUDGET_MS) {
			rejectManifest("DASH XML exceeds the parsing time budget");
		}
		if (offset + XML_CHUNK_LENGTH < text.length) {
			await yieldEventLoop();
		}
	}
	parser.close();
	if (!rootSeen) {
		rejectManifest("Expected a DASH MPD root");
	}
	return metadata;
}
