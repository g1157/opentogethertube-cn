import { reactive } from "vue";
import type { PlaybackSyncMetrics } from "./playback-sync";

/**
 * The live sync engine's counters, mirrored into a module ref by the room for the playback
 * details panel. The rate-bend preference itself lives in the settings store, so a viewer's
 * choice is remembered per device.
 */
export const syncMetrics = reactive<PlaybackSyncMetrics>({
	rateWrites: 0,
	deadlineSeeks: 0,
	maxAbsDrift: 0,
});
