import { describe, expect, it } from "vitest";
import { generateGuestNickname } from "../../nicknames.js";
import {
	CHINESE_NICKNAME_NOUNS,
	CHINESE_NICKNAME_PREFIXES,
	generateChineseNickname,
} from "ott-common/nicknames.js";

const ENGLISH_NAME = /^[a-z]+(_[a-z]+)+$/;

describe("guest nicknames", () => {
	it("gives Chinese clients a Chinese nickname", () => {
		const name = generateGuestNickname("zh-CN,zh;q=0.9,en;q=0.8");

		expect(CHINESE_NICKNAME_PREFIXES.some(prefix => name.startsWith(prefix))).toBe(true);
		expect(CHINESE_NICKNAME_NOUNS.some(noun => name.endsWith(noun))).toBe(true);
	});

	it("keeps the upstream English generator for other languages", () => {
		expect(generateGuestNickname("en-US,en;q=0.9")).toMatch(ENGLISH_NAME);
		expect(generateGuestNickname(undefined)).toMatch(ENGLISH_NAME);
		expect(generateGuestNickname(null)).toMatch(ENGLISH_NAME);
	});

	it("varies between calls", () => {
		const names = new Set(Array.from({ length: 40 }, () => generateGuestNickname("zh")));
		expect(names.size).toBeGreaterThan(5);
	});

	it("uses the whole dictionary instead of a fixed pair", () => {
		const random = createSequence([0, 0, 0.999, 0.999]);
		const first = generateChineseNickname(random);
		const second = generateChineseNickname(random);

		expect(first).toBe(`${CHINESE_NICKNAME_PREFIXES[0]}${CHINESE_NICKNAME_NOUNS[0]}`);
		expect(second).toBe(
			`${CHINESE_NICKNAME_PREFIXES[CHINESE_NICKNAME_PREFIXES.length - 1]}${
				CHINESE_NICKNAME_NOUNS[CHINESE_NICKNAME_NOUNS.length - 1]
			}`,
		);
	});
});

function createSequence(values: number[]): () => number {
	let index = 0;
	return () => values[index++ % values.length];
}
