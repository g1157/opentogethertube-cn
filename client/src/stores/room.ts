import omit from "lodash/omit";
import type { Store } from "vuex";
import type { Module } from "vuex/types";
import { Grants } from "ott-common/permissions";
import {
	QueueMode,
	Visibility,
	BufferGateMode,
	type RoomDanmakuSource,
} from "ott-common/models/types";
import type { QueueItem } from "ott-common/models/video";
import dayjs, { type Dayjs } from "dayjs";
import type {
	PlaybackPreparation,
	ServerMessageSync,
	TemporaryPlaybackSpeed,
} from "ott-common/models/messages";
import { deserializeMap, deserializeSet } from "ott-common/serialize";
import type { FullOTTStoreState } from "@/store";
import {
	getOneWayDelayMs,
	getServerClockOffsetMs,
	subscribeServerClock,
} from "@/util/connection-latency";

export interface RoomState {
	name: string;
	title: string;
	description: string;
	isTemporary: boolean;
	visibility: Visibility;
	queueMode: QueueMode;
	currentSource: QueueItem | null;
	queue: QueueItem[];
	isPlaying: boolean;
	playbackPosition: number;
	/** Monotonic id of the last explicit room seek; a change forces a hard seek. */
	seekId?: number;
	playbackPreparation: PlaybackPreparation | null;
	playbackSpeed: number;
	temporaryPlaybackSpeed: TemporaryPlaybackSpeed | null;
	hasOwner: boolean;
	hasPassword: boolean;
	voteCounts?: Map<string, number>;
	playbackStartTime: Dayjs | undefined;
	/**
	 * The server clock instant that came with the last applied position. Together with the
	 * measured clock offset it says which local moment the position describes, so the anchor
	 * can be rebuilt when the offset arrives after the sync did.
	 */
	playbackAnchorServerTime: number | null;
	videoSegments?: {
		startTime: number;
		endTime: number;
		videoDuration: number;
		category: string;
	}[];
	grants: Grants;
	prevQueue: QueueItem[] | null;
	enableVoteSkip: boolean;
	bufferGateMode: BufferGateMode;
	/** The danmaku track this room shares; null when nobody set one. */
	danmakuSource: RoomDanmakuSource | null;
	votesToSkip: Set<string>;
}

/**
 * A sync message describes the room clock at the moment it left the server. Anchoring it
 * at the moment we read it would leave this viewer a fixed one-way delay behind; the
 * measured round trip is the only way to know how much time it spent in flight.
 */
function syncAnchorNow(): Dayjs {
	return dayjs().subtract(getOneWayDelayMs(), "ms");
}

/**
 * The local instant a position-bearing sync describes: the server sampled the position at
 * its own `serverTime`, and the measured clock offset places that moment on our clock. Null
 * when either half is missing, and then the arrival-time anchor above is all we have.
 */
function anchorFromServerTime(serverTime: number | null): Dayjs | null {
	if (serverTime === null) {
		return null;
	}
	const offsetMs = getServerClockOffsetMs();
	if (offsetMs === null) {
		return null;
	}
	return dayjs(serverTime - offsetMs);
}

export const roomModule: Module<RoomState, FullOTTStoreState> = {
	namespaced: true,
	state: {
		name: "",
		title: "",
		description: "",
		isTemporary: false,
		visibility: Visibility.Unlisted,
		queueMode: QueueMode.Manual,
		currentSource: {} as QueueItem,
		queue: [],
		isPlaying: false,
		playbackPosition: 0,
		playbackPreparation: null,
		playbackSpeed: 1,
		temporaryPlaybackSpeed: null,
		hasOwner: false,
		hasPassword: false,
		voteCounts: undefined,
		playbackStartTime: undefined,
		playbackAnchorServerTime: null,
		grants: new Grants(),
		prevQueue: null,
		enableVoteSkip: false,
		bufferGateMode: BufferGateMode.Off,
		danmakuSource: null,
		votesToSkip: new Set(),
		videoSegments: [],
	},
	mutations: {
		SYNC(state, stateupdate: Partial<RoomState>) {
			// HACK: this lets vue detect the changes and react to them
			Object.assign(state, stateupdate);
		},
		/**
		 * Rebuild the anchor from the remembered sampling instant. The offset arrives with the
		 * first pong, which is after the syncs of a join, so without this a late joiner keeps
		 * the anchor it guessed at arrival time for the rest of the room's playback.
		 */
		REANCHOR_FROM_SERVER_CLOCK(state) {
			if (!state.isPlaying) {
				return;
			}
			const anchor = anchorFromServerTime(state.playbackAnchorServerTime);
			if (anchor !== null) {
				state.playbackStartTime = anchor;
			}
		},
	},
	actions: {
		sync(context, message: ServerMessageSync) {
			const stateupdate: Partial<RoomState> = {
				...omit(message, ["action", "grants", "voteCounts", "votesToSkip", "serverTime"]),
			} as any;
			if (typeof message.name === "string" && "currentSource" in message) {
				// Older servers omit this field; a previous visit's preparation must not survive.
				stateupdate.playbackPreparation = message.playbackPreparation ?? null;
				stateupdate.bufferGateMode = message.bufferGateMode ?? BufferGateMode.Off;
			}
			const hasPosition = message.playbackPosition !== undefined;
			const serverTime =
				typeof message.serverTime === "number" && Number.isFinite(message.serverTime)
					? message.serverTime
					: null;
			// The instant the carried position was sampled, when the server shared it.
			const positionAnchor = hasPosition ? anchorFromServerTime(serverTime) : null;
			if (
				message.isPlaying !== undefined &&
				this.state.room.isPlaying !== message.isPlaying
			) {
				if (message.isPlaying) {
					this.state.room.playbackStartTime = positionAnchor ?? syncAnchorNow();
				}
			}
			// A metadata-only `currentSource` (a subtitle, a learned duration) describes the same
			// media, and the message carries no new position: re-anchoring the clock around the
			// old position would move every viewer by its own drift.
			const previousSource = this.state.room.currentSource;
			const sourceIdentityChanged =
				"currentSource" in message &&
				(message.currentSource?.service !== previousSource?.service ||
					message.currentSource?.id !== previousSource?.id);
			if (hasPosition || sourceIdentityChanged) {
				stateupdate.playbackAnchorServerTime = serverTime;
			}
			if ((hasPosition || sourceIdentityChanged) && this.state.room.isPlaying) {
				// The sampling instant is independent of when this message was read, so a sync
				// delayed behind a retransmit or a busy main thread no longer becomes an anchor.
				this.state.room.playbackStartTime = positionAnchor ?? syncAnchorNow();
			}
			if ("currentSource" in message) {
				this.commit("PLAYBACK_BUFFER_RESET");
			}
			if (message.voteCounts) {
				stateupdate.voteCounts = deserializeMap(message.voteCounts);
			}
			if (message.grants) {
				stateupdate.grants = new Grants(message.grants);
			}
			if (message.votesToSkip) {
				stateupdate.votesToSkip = deserializeSet(message.votesToSkip);
			}
			context.commit("SYNC", stateupdate);
		},
	},
};

/**
 * Keep the materialised room anchor in step with the measured server-clock offset. The
 * offset arrives with the first pong, which is later than the syncs of a join, and a sample
 * that changes it would otherwise leave the anchor stale until the next position-bearing
 * sync. Returns an unsubscribe; the caller owns the lifetime.
 */
export function attachServerClock(store: Store<FullOTTStoreState>): () => void {
	return subscribeServerClock(() => {
		store.commit("room/REANCHOR_FROM_SERVER_CLOCK");
	});
}
