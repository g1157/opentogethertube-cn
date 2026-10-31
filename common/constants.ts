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
