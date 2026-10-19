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
/**
 * The automatic aggregator probe is otherwise invisible: the settings panel shows the
 * query being matched while it runs, so "nothing happened" and "matched nothing" differ.
 */
const matching = ref(false);
const matchQuery = ref<string | null>(null);

export function useDanmaku() {
	return { available, loadedCount, currentVideoUrl, matching, matchQuery };
}
