import type { Module } from "vuex/types";

export interface MiscState {
	isLoadingCreateRoom: boolean;
	cancelledRoomCreation: boolean;
	/** The create-room dialog lives in the app shell; other pages ask for it through here. */
	showCreateRoomForm: boolean;
}

/** I couldn't figure out what to name this one. */
export const miscModule: Module<MiscState, unknown> = {
	namespaced: true,
	state: {
		isLoadingCreateRoom: false,
		cancelledRoomCreation: false,
		showCreateRoomForm: false,
	},
	mutations: {
		CREATING_ROOM(state: MiscState) {
			state.isLoadingCreateRoom = true;
			state.cancelledRoomCreation = false;
		},
		SET_CREATE_ROOM_FORM(state: MiscState, value: boolean) {
			state.showCreateRoomForm = value;
		},
		CANCELLED_ROOM_CREATION(state: MiscState) {
			state.isLoadingCreateRoom = false;
			state.cancelledRoomCreation = true;
		},
		ROOM_CREATED(state: MiscState, _payload: { name: string }) {
			state.isLoadingCreateRoom = false;
			state.cancelledRoomCreation = false;
		},
		ROOM_CREATE_FAILED(state: MiscState) {
			state.isLoadingCreateRoom = false;
			state.cancelledRoomCreation = false;
		},
	},
};
