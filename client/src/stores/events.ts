import type { Module } from "vuex";
import { ToastStyle, type ToastLevel } from "@/models/toast";
import {
	RoomRequestType,
	type ServerMessageEvent,
	type ServerMessageEventCustom,
} from "ott-common/models/messages";
import { secondsToTimestamp } from "@/util/timestamp";
import type { FullOTTStoreState } from "@/store";
import { i18n } from "@/i18n";

export const eventsModule: Module<unknown, FullOTTStoreState> = {
	actions: {
		event(context, message: ServerMessageEvent) {
			const t = i18n.global.t;
			const user = message.user.name;
			let text = t("room-event.unknown");
			let duration = 5000;
			// Fullscreen keeps only what explains the picture (critical) or its playback
			// (content); everything social is left to the windowed layout.
			let level: ToastLevel = "social";
			if (message.request.type === RoomRequestType.PlaybackRequest) {
				duration = 3000;
				level = "content";
				text = t(message.request.state ? "room-event.played" : "room-event.paused", {
					user,
				});
			} else if (
				message.request.type === RoomRequestType.SkipRequest &&
				message.additional.video
			) {
				text = t("room-event.skipped", {
					user,
					video: message.additional.video.title,
				});
				duration = 20000;
				level = "critical";
			} else if (message.request.type === RoomRequestType.SeekRequest) {
				text = t("room-event.seeked", {
					user,
					time: secondsToTimestamp(message.request.value),
				});
				duration = context.rootState.settings.seekNoticeSeconds * 1000;
				level = "critical";
			} else if (message.request.type === RoomRequestType.JoinRequest) {
				text = t("room-event.joined", { user });
				duration = context.rootState.settings.presenceNoticeSeconds * 1000;
			} else if (
				message.request.type === RoomRequestType.LeaveRequest &&
				message.additional.user
			) {
				text = t("room-event.left", { user: message.additional.user.name });
				duration = context.rootState.settings.presenceNoticeSeconds * 1000;
			} else if (message.request.type === RoomRequestType.AddRequest) {
				if (message.request.videos) {
					text = t("room-event.added-many", {
						user,
						count: message.request.videos.length,
					});
				} else if (message.additional.video) {
					text = t("room-event.added", {
						user,
						video: message.additional.video.title,
					});
				} else {
					text = t("room-event.added-unknown", { user });
				}
				duration = 20000;
			} else if (message.request.type === RoomRequestType.RemoveRequest) {
				if (message.additional.video) {
					text = t("room-event.removed", {
						user,
						video: message.additional.video.title,
					});
				} else {
					text = t("room-event.removed-unknown", { user });
				}
				duration = 20000;
			} else if (message.request.type === RoomRequestType.UpdateQueueItemRequest) {
				if (message.additional.video) {
					text = t("room-event.updated", {
						user,
						video: message.additional.video.title,
					});
				} else {
					text = t("room-event.updated-unknown", { user });
				}
				duration = 20000;
			} else {
				console.debug(`Unhandled room event type: ${message.request.type}`);
			}

			if (duration === 0) {
				return;
			}
			this.commit("toast/ADD_TOAST", {
				style: ToastStyle.Neutral,
				content: text,
				duration,
				event: message,
				level,
			});
		},
		eventcustom(_context, message: ServerMessageEventCustom) {
			this.commit("toast/ADD_TOAST", {
				style: ToastStyle.Neutral,
				content: message.text,
				duration: message.duration ?? 3000,
				// A room-wide announcement is worth keeping in fullscreen.
				level: "content",
			});
		},
	},
};

export default eventsModule;
