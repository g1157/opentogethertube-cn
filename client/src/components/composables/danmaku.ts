import { ref } from "vue";

/**
 * Whether the current source has a known danmaku track. The layer derives this from the
 * video URL alone, so the control bar can offer the toggle before anything is fetched.
 */
const available = ref(false);

export function useDanmaku() {
	return { available };
}
