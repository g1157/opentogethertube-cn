import { describe, expect, it } from "vitest";
import { toastModule, type ToastState } from "@/stores/toast";
import { ToastStyle } from "@/models/toast";

describe("toast queue", () => {
	it("keeps a bounded history and drops the oldest notices", () => {
		const state: ToastState = { notifications: [] };
		for (let index = 0; index < 100; index++) {
			toastModule.mutations!.ADD_TOAST(state, {
				content: `notice-${index}`,
				style: ToastStyle.Neutral,
			});
		}
		expect(state.notifications).toHaveLength(30);
		expect(state.notifications[0].content).toBe("notice-70");
		expect(state.notifications.at(-1)?.content).toBe("notice-99");
	});
});
