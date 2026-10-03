import { describe, expect, it } from "vitest";
import { nextTick } from "vue";
import ThemeSwitcher from "@/components/navbar/ThemeSwitcher.vue";
import { ALL_THEMES } from "@/stores/settings";
import { flush, mountComponent } from "./component-test-utils";

describe("theme switcher", () => {
	it("offers every theme from the navbar and applies the picked one", async () => {
		const { wrapper, store } = mountComponent(ThemeSwitcher);
		await wrapper.get('[data-cy="theme-switcher"]').trigger("click");
		await flush();
		await nextTick();

		const options = document.querySelectorAll('[data-cy^="theme-option-"]');
		expect(options).toHaveLength(ALL_THEMES.length);

		(document.querySelector('[data-cy="theme-option-mint"]') as HTMLElement).click();
		await flush();
		expect(store.state.settings.theme).toBe("mint");
	});
});
