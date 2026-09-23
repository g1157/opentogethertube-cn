import { describe, expect, it } from "vitest";
import ChatEmojiPanel from "@/components/ChatEmojiPanel.vue";
import { EMOJI_GROUPS, EMOJI_QUICK } from "@/util/chat-emoji";
import { mountComponent } from "./component-test-utils";

describe("chat emoji panel", () => {
	it("offers the quick reactions and every group entry", () => {
		const { wrapper } = mountComponent(ChatEmojiPanel);
		expect(wrapper.findAll('[data-cy="chat-emoji-quick"]')).toHaveLength(EMOJI_QUICK.length);
		const items = EMOJI_GROUPS.reduce((sum, group) => sum + group.emoji.length, 0);
		expect(wrapper.findAll('[data-cy="chat-emoji-item"]')).toHaveLength(items);
	});

	it("labels the groups in the active locale", () => {
		const { wrapper } = mountComponent(ChatEmojiPanel);
		for (const label of ["笑脸", "手势", "动物", "食物", "活动", "符号"]) {
			expect(wrapper.text()).toContain(label);
		}
	});

	it("reports a quick reaction and a group entry", async () => {
		const selected: string[] = [];
		const { wrapper } = mountComponent(ChatEmojiPanel, {
			attrs: { onSelect: (emoji: string) => selected.push(emoji) },
		});
		await wrapper.findAll('[data-cy="chat-emoji-quick"]')[1].trigger("click");
		await wrapper.findAll('[data-cy="chat-emoji-item"]')[0].trigger("click");
		expect(selected).toEqual([EMOJI_QUICK[1], EMOJI_GROUPS[0].emoji[0]]);
	});

	it("refuses the mousedown default so the composer keeps focus", () => {
		const { wrapper } = mountComponent(ChatEmojiPanel);
		const button = wrapper.findAll("button")[0];
		const event = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
		button.element.dispatchEvent(event);
		expect(event.defaultPrevented).toBe(true);
	});
});
