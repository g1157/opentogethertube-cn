import { ref } from "vue";

/**
 * State shared between the danmaku layer (which owns loading and drawing) and the
 * controls that configure it: whether the current source has a track, how many comments
 * that track actually holds, and which video the settings are acting on (the manual match
 * binds an episode to that URL).
 */
const available = ref(false);
const loadedCount = ref(0);
const currentVideoUrl = ref("");

export function useDanmaku() {
	return { available, loadedCount, currentVideoUrl };
}
