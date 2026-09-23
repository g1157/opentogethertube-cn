import { describe, expect, it } from "vitest";
import { EMOJI_GROUPS, EMOJI_QUICK, insertEmoji } from "@/util/chat-emoji";

describe("chat emoji data", () => {
	it("offers quick reactions and groups that the panel can render", () => {
		expect(EMOJI_QUICK.length).toBeGreaterThan(0);
		expect(EMOJI_GROUPS.length).toBeGreaterThan(0);
		for (const emoji of EMOJI_QUICK) {
			expect(emoji.length).toBeGreaterThan(0);
		}
	});

	it("keeps the groups uniquely identified and non-empty", () => {
		const ids = EMOJI_GROUPS.map(group => group.id);
		expect(new Set(ids).size).toBe(ids.length);
		for (const group of EMOJI_GROUPS) {
			expect(group.emoji.length).toBeGreaterThan(0);
			for (const emoji of group.emoji) {
				expect(emoji.length).toBeGreaterThan(0);
			}
		}
	});
});

describe("insertEmoji", () => {
	it("inserts at the caret", () => {
		const result = insertEmoji("ab", "👍", { start: 1, end: 1 });
		expect(result.value).toBe("a👍b");
		expect(result.caret).toBe(1 + "👍".length);
	});

	it("replaces the selected text", () => {
		const result = insertEmoji("hello world", "🔥", { start: 6, end: 11 });
		expect(result.value).toBe("hello 🔥");
		expect(result.caret).toBe(6 + "🔥".length);
	});

	it("appends when the field has no selection to read", () => {
		const result = insertEmoji("draft", "🎉", null);
		expect(result.value).toBe("draft🎉");
		expect(result.caret).toBe("draft🎉".length);
	});

	it("inserts into an empty draft", () => {
		expect(insertEmoji("", "😀", { start: 0, end: 0 }).value).toBe("😀");
	});

	it("clamps a selection that outlives the value", () => {
		// A re-render or an IME commit can leave a caret position behind the text.
		const result = insertEmoji("ab", "👌", { start: 99, end: 120 });
		expect(result.value).toBe("ab👌");
		expect(result.caret).toBe("ab👌".length);
	});

	it("ignores an inverted selection", () => {
		const result = insertEmoji("abc", "✅", { start: 2, end: 0 });
		expect(result.value).toBe("ab✅c");
		expect(result.caret).toBe(2 + "✅".length);
	});
});
