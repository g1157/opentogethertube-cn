import { describe, expect, it } from "vitest";
import { nextTick } from "vue";
import VueSlider from "vue-slider-component";
import VolumeControl from "@/components/controls/VolumeControl.vue";
import { i18n } from "@/i18n";
import { flush, mountComponent } from "./component-test-utils";

/**
 * The volume icon used to be a bare `<i>` with a click handler: not focusable, no name
 * for a screen reader, and the slider next to it announced "slider, no name". Every
 * control here has to carry its own name instead of relying on the hover tooltip.
 */
describe("volume control names", () => {
	it("names the mute button after the action it performs", async () => {
		const { wrapper } = mountComponent(VolumeControl);
		await flush();

		const button = wrapper.get('[data-cy="volume-toggle"]');
		expect(button.attributes("aria-label")).toBe("静音");

		await button.trigger("click");
		await flush();

		expect(wrapper.get('[data-cy="volume-toggle"]').attributes("aria-label")).toBe("取消静音");
	});

	it("names the slider handle and spells out its value", async () => {
		const { wrapper } = mountComponent(VolumeControl);
		await flush();

		wrapper.findComponent(VueSlider).vm.$emit("update:modelValue", 40);
		await nextTick();
		await flush();

		const handle = wrapper.get(".vue-slider-dot");
		expect(handle.attributes("aria-label")).toBe("音量");
		expect(handle.attributes("aria-valuetext")).toBe("40%");
	});

	it("relabels the handle when the language changes", async () => {
		const locale = i18n.global.locale as unknown as string;
		try {
			const { wrapper } = mountComponent(VolumeControl);
			await flush();

			(i18n.global as unknown as { locale: string }).locale = "en";
			await nextTick();
			await flush();

			expect(wrapper.get(".vue-slider-dot").attributes("aria-label")).toBe("Volume");
		} finally {
			(i18n.global as unknown as { locale: string }).locale = locale;
		}
	});
});
