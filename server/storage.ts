import {
	getRoomByName,
	getPermanentRoomList,
	isRoomNameTaken,
	saveRoom,
	updateRoom,
	deleteRoom,
} from "./storage/room.js";
import {
	getVideoInfo,
	getManyVideoInfo,
	updateVideoInfo,
	updateManyVideoInfo,
	getVideoInfoFields,
} from "./storage/cachedvideo.js";
import { addNote, countNotes, deleteAllNotes, deleteNote, listNotes } from "./storage/roomnote.js";

export default {
	getRoomByName,
	getPermanentRoomList,
	isRoomNameTaken,
	saveRoom,
	updateRoom,
	deleteRoom,
	getVideoInfo,
	getManyVideoInfo,
	updateVideoInfo,
	updateManyVideoInfo,
	getVideoInfoFields,
	listNotes,
	countNotes,
	addNote,
	deleteNote,
	deleteAllNotes,
};
