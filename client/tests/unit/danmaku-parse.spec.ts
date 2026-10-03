import { describe, expect, it } from "vitest";
import { parseDanmakuXml } from "@/util/danmaku/parse";

const SAMPLE = `<?xml version="1.0" encoding="UTF-8"?>
<i>
	<chatserver>chat.bilibili.com</chatserver>
	<mission>0</mission>
	<d p="0,1,25,16711680,1412878811,0,61f94885,0">红字滚动</d>
	<d p="12.5,5,25,65280,1413001515,0,9865e823,0">顶部绿字</d>
	<d p="13,4,25,16777215,1413001538,0,9865e823,0">底部白字</d>
	<d p="14,6,25,16777215,1413000000,0,abcdef,0">逆向滚动</d>
	<d p="15,7,25,16777215,1413000000,0,abcdef,0">高级弹幕</d>
	<d p="16,8,25,16777215,1413000000,0,abcdef,0">代码弹幕</d>
	<d p="bad,1,25,16777215,1413000000,0,abcdef,0">坏时间</d>
	<d p="20,1,25,16777215,1413000000,0,abcdef,0"></d>
</i>`;

describe("parseDanmakuXml", () => {
	it("reads Bilibili XML into comments sorted by time", () => {
		const items = parseDanmakuXml(SAMPLE);
		expect(items.map(item => item.text)).toEqual([
			"红字滚动",
			"顶部绿字",
			"底部白字",
			"逆向滚动",
		]);
		expect(items[0]).toEqual({
			time: 0,
			mode: "scroll",
			color: "#ff0000",
			text: "红字滚动",
		});
		expect(items[1]).toEqual({
			time: 12.5,
			mode: "top",
			color: "#00ff00",
			text: "顶部绿字",
		});
		expect(items[2].mode).toBe("bottom");
		// Mode 6 is a reverse scroll; it rides the ordinary scroll lanes here.
		expect(items[3].mode).toBe("scroll");
	});

	it("returns nothing for a malformed or empty document", () => {
		expect(parseDanmakuXml("<html><body>404</body></html>")).toEqual([]);
		expect(parseDanmakuXml("")).toEqual([]);
	});
});
