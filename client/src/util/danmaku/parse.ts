/** A comment from a Bilibili-format danmaku XML file. */
export interface DanmakuItem {
	/** Media time in seconds at which the comment appears. */
	time: number;
	mode: DanmakuMode;
	/** CSS color; white unless the comment carries a custom one. */
	color: string;
	text: string;
}

export type DanmakuMode = "scroll" | "top" | "bottom";

const DEFAULT_COLOR = "#ffffff";
const COLOR_MASK = 0xffffff;

/**
 * Bilibili's `p` attribute is `time,mode,fontSize,color,sendTimestamp,pool,userId,row`.
 * Advanced (7) and code (8) comments have no equivalent here and are dropped.
 */
function parseMode(value: number): DanmakuMode | null {
	switch (value) {
		case 1:
		case 2:
		case 3:
		case 6:
			return "scroll";
		case 4:
			return "bottom";
		case 5:
			return "top";
		default:
			return null;
	}
}

export function parseDanmakuXml(xml: string): DanmakuItem[] {
	const doc = new DOMParser().parseFromString(xml, "text/xml");
	const nodes = doc.getElementsByTagName("d");
	const items: DanmakuItem[] = [];
	for (const node of Array.from(nodes)) {
		const attribute = node.getAttribute("p");
		if (!attribute) {
			continue;
		}
		const fields = attribute.split(",");
		const time = Number.parseFloat(fields[0] ?? "");
		const mode = parseMode(Number.parseInt(fields[1] ?? "", 10));
		if (!Number.isFinite(time) || mode === null) {
			continue;
		}
		const text = node.textContent ?? "";
		if (text.length === 0) {
			continue;
		}
		const rawColor = Number.parseInt(fields[3] ?? "", 10);
		const color = Number.isFinite(rawColor)
			? `#${(rawColor & COLOR_MASK).toString(16).padStart(6, "0")}`
			: DEFAULT_COLOR;
		items.push({ time, mode, color, text });
	}
	// Scheduling and seeking both binary-search this list.
	items.sort((a, b) => a.time - b.time);
	return items;
}
