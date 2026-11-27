import { watchEffect, type Ref } from "vue";
import { useI18n } from "vue-i18n";

/** The part of a vue-slider-component instance the helper needs to reach its handle. */
export type SliderInstance = { $el?: HTMLElement } | null | undefined;

/**
 * vue-slider renders its own `role="slider"` handle and forwards no accessible name to
 * it, so a screen reader announces an unnamed slider. The library has no prop for the
 * name either, so the attributes are written onto the handle element itself.
 */
export function setSliderHandleAttrs(slider: SliderInstance, attrs: Record<string, string>): void {
	const handle = slider?.$el?.querySelector?.(".vue-slider-dot");
	if (!handle) {
		return;
	}
	for (const [name, value] of Object.entries(attrs)) {
		if (handle.getAttribute(name) !== value) {
			handle.setAttribute(name, value);
		}
	}
}

/**
 * Keeps the handle of a vue-slider labelled without querying the DOM on every render:
 * the attributes are written once the handle exists and again only when the locale or a
 * value read by `getAttrs` changes. The progress bar re-renders four times a second while
 * a room plays, which is what made the old `onUpdated` query hot-path cost.
 */
export function useSliderHandleAttrs(
	slider: Ref<{ $el?: HTMLElement } | null>,
	getAttrs: () => Record<string, string>,
): void {
	const { locale } = useI18n();

	watchEffect(
		() => {
			// Read the locale explicitly: the label has to follow a language switch even
			// when the attribute getter is not reactive through the legacy composer.
			void locale.value;
			setSliderHandleAttrs(slider.value, getAttrs());
		},
		{ flush: "post" },
	);
}
