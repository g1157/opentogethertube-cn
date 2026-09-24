import type {
	ServerMessageUser,
	ServerMessageYou,
	PartialUserInfo,
} from "ott-common/models/messages";
import { type ClientId, Role, type RoomUserInfo } from "ott-common/models/types";
import type { Module } from "vuex/types";
import { API } from "@/common-http";
import { reactive } from "vue";
import type { GrantMask } from "ott-common/permissions";
import type { FullOTTStoreState } from "../store";

export interface UsersState {
	users: Map<ClientId, RoomUserInfo>;
	you: {
		id: ClientId;
	};
}

/** The grant currently in flight, so overlapping callers share one identity instead of two. */
let pendingGrant: Promise<void> | null = null;

export const usersModule: Module<UsersState, FullOTTStoreState> = {
	namespaced: true,
	state: {
		users: reactive(new Map()),
		you: {
			id: "",
		},
	},
	getters: {
		token(): string | null {
			return window.localStorage.getItem("token");
		},
		self(state): RoomUserInfo | undefined {
			return state.users.get(state.you.id);
		},
		grants(state, getters, rootState): GrantMask {
			return rootState.room.grants.getMask(getters.self?.role ?? Role.Owner);
		},
	},
	mutations: {
		INIT_USERS(state, payload: RoomUserInfo[]) {
			state.users = new Map(payload.map(u => [u.id, u]));
		},
		UPDATE_USER(state, payload: PartialUserInfo) {
			const user = state.users.get(payload.id);
			if (!user) {
				state.users.set(payload.id, payload as RoomUserInfo);
			} else {
				Object.assign(user, payload);
			}
		},
		REMOVE_USER(state, payload: ClientId) {
			state.users.delete(payload);
		},
		SET_YOU(state, payload: ServerMessageYou) {
			state.you = payload.info;
		},
		SET_AUTH_TOKEN(_state, token: string) {
			window.localStorage.setItem("token", token);
		},
	},
	actions: {
		user(context, message: ServerMessageUser) {
			switch (message.update.kind) {
				case "init":
					context.commit("INIT_USERS", message.update.value);
					break;
				case "update":
					context.commit("UPDATE_USER", message.update.value);
					break;
				case "remove":
					context.commit("REMOVE_USER", message.update.value);
					break;
				default:
					console.error("Unknown user update kind", message.update);
					break;
			}
		},
		you(context, message: ServerMessageYou) {
			context.commit("SET_YOU", message);
		},
		async getNewToken(context) {
			// A page loaded straight into a room asks for a token twice: the app bootstrap and the
			// room's own wait. Two grants in flight mint two guests for one device, and the second
			// name then shows up next to the first. One grant, shared by both callers, keeps the
			// device on a single identity.
			if (pendingGrant) {
				await pendingGrant;
				return;
			}
			pendingGrant = (async () => {
				// Re-present the stored token so the server returns the same identity instead of
				// minting a fresh guest on every load (which splits a browser's tabs into separate
				// users and resets the nickname). The server mints a new one if it is invalid.
				const existing = window.localStorage.getItem("token")?.trim();
				// The generated guest nickname follows this header, so send the chosen UI language
				// instead of relying on the browser's own Accept-Language.
				const resp = await API.get("/auth/grant", {
					headers: {
						"Accept-Language": context.rootState.settings.locale,
						...(existing ? { Authorization: `Bearer ${existing}` } : {}),
					},
				});
				context.commit("SET_AUTH_TOKEN", resp.data.token);
			})();
			try {
				await pendingGrant;
			} finally {
				pendingGrant = null;
			}
		},
	},
};
