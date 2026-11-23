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
	// The drift distribution is reported to the server but not shown in the panel yet; the
	// mirror still has to carry the fields the engine's metrics type declares.
	driftSeconds: [0, 0, 0, 0, 0, 0],
	bendSeconds: 0,
	// The seek-latency estimates are learned per engine instance on the room view; the mirror
	// only has to carry the fields the engine's metrics type declares.
	seekLeadSeconds: 0,
	loadLeadSeconds: 0,
});
