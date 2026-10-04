import { ref } from "vue";

/**
 * State shared between the danmaku layer (which owns loading and drawing) and the
 * controls that configure it: whether the current source has a track, and which video
 * the settings are acting on (the manual match binds an episode to that URL).
 */
const available = ref(false);
const currentVideoUrl = ref("");

export function useDanmaku() {
	return { available, currentVideoUrl };
}
