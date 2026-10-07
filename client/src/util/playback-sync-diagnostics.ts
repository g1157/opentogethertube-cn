import { reactive, ref } from "vue";
import type { PlaybackSyncMetrics } from "./playback-sync";

/**
 * Session-only diagnostics for the slow-device investigation
 * (docs/old-device-stutter-2026-10-07.zh-CN.md). The playback details panel shows the
 * counters and flips the A/B switch; nothing here is persisted or synced to the room.
 */

/** Turns rate bending off for this session: the engine then corrects drift with coarser
 * seeks only, which is how the same clip sounds and looks without the continuous
 * re-timing. Reset by a reload, deliberately. */
export const rateBendDisabled = ref(false);

/** The live sync engine's counters, mirrored here by the room for the panel. */
export const syncMetrics = reactive<PlaybackSyncMetrics>({ rateWrites: 0, deadlineSeeks: 0 });
