import { computed, ref } from "vue";

/** Darkest the simulated panel brightness goes; below this the picture is unwatchable. */
export const MIN_PLAYER_BRIGHTNESS = 0.2;

const brightness = ref(1);

/**
 * Simulated panel brightness (1 = untouched), driven by the fullscreen swipe on a phone.
 * Deliberately session-only: a stray swipe must not leave the picture dark after a reload,
 * so this value never reaches the settings store or localStorage.
 */
export function usePlayerBrightness() {
	return {
		brightness,
		/** Opacity of the black scrim standing in for the dimmed panel. */
		dimmerOpacity: computed(() => Math.min(1, Math.max(0, 1 - brightness.value))),
		setBrightness(value: number) {
			brightness.value = Number.isFinite(value)
				? Math.min(1, Math.max(MIN_PLAYER_BRIGHTNESS, value))
				: 1;
		},
	};
}
