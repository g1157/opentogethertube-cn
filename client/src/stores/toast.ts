import { RoomRequestType } from "ott-common/models/messages";
import _ from "lodash";
import type { Module } from "vuex/types";

import type { Toast } from "../models/toast";

/**
 * The queue keeps a bounded history. Notifier renders only the last few cards, so without a
 * cap a room that emits events faster than cards drain (joins, seeks, queue changes) grows
 * the array and the "more notices" counter without bound.
 */
const MAX_QUEUED_TOASTS = 30;

export interface ToastState {
	notifications: Toast[];
}

export const toastModule: Module<ToastState, unknown> = {
	namespaced: true,
	state: {
		notifications: [],
	},
	mutations: {
		ADD_TOAST(state: ToastState, notification: Omit<Toast, "id">) {
			if (state.notifications.length > 0) {
				const last = state.notifications[state.notifications.length - 1];
				if (notification.event?.request.type === last.event?.request.type) {
					if (last.event?.request.type === RoomRequestType.PlaybackRequest) {
						state.notifications.splice(state.notifications.length - 1, 1);
					} else if (
						last.event?.request.type === RoomRequestType.SeekRequest &&
						last.event?.user.name === notification.event?.user.name
					) {
						const removed = state.notifications.splice(
							state.notifications.length - 1,
							1,
						);
						notification.event.additional.prevPosition =
							removed[0].event?.additional.prevPosition;
					}
				}
			}
			state.notifications.push({
				...notification,
				id: Symbol(),
			});
			if (state.notifications.length > MAX_QUEUED_TOASTS) {
				state.notifications.splice(0, state.notifications.length - MAX_QUEUED_TOASTS);
			}
		},
		REMOVE_TOAST(state: ToastState, id: symbol) {
			const idx = _.findIndex(state.notifications, { id });
			if (idx < 0) {
				// A card closed twice, or after a clear, must not take the last toast with it:
				// splice(-1, 1) deletes from the end of the array.
				return;
			}
			state.notifications.splice(idx, 1);
		},
		CLEAR_ALL_TOASTS(state: ToastState) {
			state.notifications = [];
		},
	},
};
