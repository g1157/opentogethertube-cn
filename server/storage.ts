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
};
