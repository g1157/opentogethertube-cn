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
] as const;
export const ALL_SKIP_CATEGORIES: Category[] = [
	"sponsor",
	"intro",
	"outro",
	"interaction",
	"selfpromo",
	"music_offtopic",
	"preview",
] as const;
