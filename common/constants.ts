import type { Category } from "sponsorblock-api";

export const ANNOUNCEMENT_CHANNEL = "announcement";
export const ROOM_NAME_REGEX = /^[a-z0-9_-]+$/i;
export const USERNAME_LENGTH_MAX = 48;
export const TEMPORARY_PLAYBACK_SPEED = 2;
export const TEMPORARY_PLAYBACK_SPEED_LEASE_MS = 5000;
export const TEMPORARY_PLAYBACK_SPEED_RENEW_MS = 1000;
export const BUFFER_GATE_MAX_WAIT_MS = 15000;
export const BUFFER_GATE_START_GRACE_MS = 2000;
export const BUFFER_GATE_COOLDOWN_MS = 30000;

/**
 * How long a room waits for its foreground viewers to render the first frame and build a
 * small buffer runway before starting the new source. A room never waits indefinitely.
 */
export const PLAYBACK_READY_WAIT_MS = 8000;
/** When nobody is ready, show an explicit start button before this hard fallback fires. */
export const PLAYBACK_HARD_FALLBACK_MS = 20000;
/** A scheduled start gives clients a moment to apply the play command at the same time. */
export const PLAYBACK_START_LEAD_MS = 1000;
/**
 * Buffer runway required before a native player counts as ready. Segmented sources need a
 * little more because the next segment fetch is not instantaneous.
 */
export const PLAYBACK_READY_BUFFER_DIRECT_SECONDS = 3;
export const PLAYBACK_READY_BUFFER_STREAM_SECONDS = 6;
/** A late joiner gets this long to settle before normal hard-seek rules apply. */
export const PLAYBACK_INITIAL_SYNC_COOLDOWN_MS = 8000;
/** During the initial cooldown only a drift this large may force a seek. */
export const PLAYBACK_INITIAL_MAX_DRIFT_SECONDS = 10;
/** Do not hard-seek while a native player has less than this much buffer ahead. */
export const PLAYBACK_MIN_SEEK_BUFFER_SECONDS = 1.5;

export function playbackReadyBufferSeconds(service: string | undefined): number {
	return service === "hls" || service === "dash"
		? PLAYBACK_READY_BUFFER_STREAM_SECONDS
		: PLAYBACK_READY_BUFFER_DIRECT_SECONDS;
}
export const ALL_VIDEO_SERVICES = [
	"youtube",
	"vimeo",
	"direct",
	"hls",
	"dash",
	"tubi",
	"reddit",
	"googledrive",
	"peertube",
	"pluto",
	"invidious",
	"odysee",
	"bilibili",
] as const;
/** Notes are append-only; the per-room cap is the only growth gate. */
export const MAX_NOTES_PER_ROOM = 200;
export const MAX_NOTE_LENGTH = 1000;
/** Chat is a line at a time; the client input already caps at this length. */
export const MAX_CHAT_MESSAGE_LENGTH = 300;
/** A room queue is a session playlist, not a library. Aligned with the edge limit. */
export const MAX_QUEUE_ITEMS = 200;
/** Multi-line adds are a convenience for a series; they must not become a probe fan-out. */
export const MAX_PREVIEW_LINES = 50;
/** Direct links are URLs; every service id fits comfortably below this. */
export const MAX_VIDEO_ID_LENGTH = 2048;
/** Upper bound for a room-clock seek; longer sources can still seek within this. */
export const MAX_SEEK_SECONDS = 24 * 60 * 60;

export const ALL_SKIP_CATEGORIES: Category[] = [
	"sponsor",
	"intro",
	"outro",
	"interaction",
	"selfpromo",
	"music_offtopic",
	"preview",
] as const;
