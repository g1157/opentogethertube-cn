import { Role } from "ott-common/models/types";

export default {
	landing: {
		hero: {
			title: "Sail the seas together.",
			description:
				"Real-time synchronized playback. Optional votin' system. Dark theme. No sign up required. All Open Source. It's ne'er been easier t' watch videos together.",
			btns: {
				create: "Create Room",
				browse: "Browse Rooms",
				source: "View Source",
			},
		},
	},
	"client-settings": {
		"audio-boost": "Audio Boost",
		"audio-boost-hint":
			"Boosts supported non-iframe players up to 300%. Sound effects stay as they be.",
		"audio-boost-unsupported": "This player can't be boosted. Sound effects stay as they be.",
	},
	"permissions-editor": {
		title: "Permissions Editor",
		text1: "All permissions granted to less privileged users be automatically granted to more privileged users.",
		text2: "Administrators be granted everythin'. The room owner be automatically an Administrator, and can't be demoted.",
		"viewing-as": "Viewin' as",
		permission: "Permission",
		"group-count": "{count} items",
		groups: {
			playback: "Playback",
			queue: "Queue",
			chat: "Chat",
			room: "Room settings",
			users: "User management",
			advanced: "Advanced: permission delegation",
		},
	},
	roles: {
		[Role.Administrator]: "Admiral",
		[Role.Moderator]: "First Mate",
		[Role.TrustedUser]: "Trusted Matey",
		[Role.RegisteredUser]: "Signed-on Sailor",
		[Role.UnregisteredUser]: "Stowaway",
		[Role.Owner]: "Cap'n",
	},
	permissions: {
		playback: {
			"play-pause": "Play / belay",
			skip: "Skip the current video",
			seek: "Scrub t' and fro",
			speed: "Change playback speed",
		},
		chat: "Send chat messages",
		"manage-queue": {
			add: "Add videos",
			remove: "Remove videos",
			order: "Reorder the queue",
			vote: "Vote on videos",
			"play-now": "Play a video right now",
			edit: "Edit queue items (subtitles)",
		},
		"configure-room": {
			"set-title": "Change the room title",
			"set-description": "Change the room description",
			"set-visibility": "Change room visibility",
			"set-queue-mode": "Change the queue mode",
			other: "Change other room settings",
			"set-danmaku-source": "Set the room danmaku source",
			"set-notes": "Add or remove the room's notes",
			"set-permissions": {
				"for-moderator": "Set first mates' permissions",
				"for-trusted-users": "Set trusted mateys' permissions",
				"for-all-registered-users": "Set signed-on sailors' permissions",
				"for-all-unregistered-users": "Set stowaways' permissions",
			},
		},
		"manage-users": {
			"promote-admin": "Promote to admiral",
			"demote-admin": "Demote from admiral",
			"promote-moderator": "Promote to first mate",
			"demote-moderator": "Demote from first mate",
			"promote-trusted-user": "Promote to trusted matey",
			"demote-trusted-user": "Demote from trusted matey",
			kick: "Throw users overboard",
		},
	},
};
