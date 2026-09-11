import { onUnmounted, ref, watch } from "vue";
import type { VideoId } from "ott-common/models/video";
import type {
	TemporaryPlaybackSpeed,
	TemporaryPlaybackSpeedRequest,
} from "ott-common/models/messages";
import { TEMPORARY_PLAYBACK_SPEED_RENEW_MS } from "ott-common/constants";

interface TemporarySpeedOptions {
	connected(): boolean;
	clientId(): string;
	currentVideo(): VideoId | null;
	roomGesture(): TemporaryPlaybackSpeed | null;
	canStart(): boolean;
	send(action: TemporaryPlaybackSpeedRequest["action"], id: string, video: VideoId): void;
	onRejected(): void;
}

let gestureSequence = 0;

export function useTemporaryPlaybackSpeed(options: TemporarySpeedOptions) {
	const gestureId = ref<string | null>(null);
	let video: VideoId | null = null;
	let acknowledged = false;
	let renewTimer: ReturnType<typeof setInterval> | null = null;
	let ackTimer: ReturnType<typeof setTimeout> | null = null;

	function stop(send = true) {
		if (renewTimer !== null) {
			clearInterval(renewTimer);
		}
		if (ackTimer !== null) {
			clearTimeout(ackTimer);
		}
		renewTimer = null;
		ackTimer = null;
		const id = gestureId.value;
		gestureId.value = null;
		acknowledged = false;
		if (send && id && video && options.connected()) {
			try {
				options.send("stop", id, video);
			} catch {
				// The socket can close between the state check and send. The server lease expires.
			}
		}
		video = null;
	}

	function start(): boolean {
		if (!options.connected() || !options.canStart() || gestureId.value) {
			return false;
		}
		const current = options.currentVideo();
		if (!current) {
			return false;
		}
		video = { service: current.service, id: current.id };
		const id = `${Date.now().toString(36)}-${++gestureSequence}-${Math.random().toString(36).slice(2, 10)}`;
		gestureId.value = id;
		try {
			options.send("start", id, video);
		} catch {
			stop(false);
			options.onRejected();
			return false;
		}
		renewTimer = setInterval(() => {
			if (!options.connected()) {
				stop(false);
			} else if (gestureId.value && video) {
				try {
					options.send("renew", gestureId.value, video);
				} catch {
					stop(false);
				}
			}
		}, TEMPORARY_PLAYBACK_SPEED_RENEW_MS);
		ackTimer = setTimeout(() => {
			if (!acknowledged) {
				stop();
				options.onRejected();
			}
		}, 2500);
		return true;
	}

	watch(
		options.roomGesture,
		current => {
			if (!gestureId.value) {
				return;
			}
			if (
				current?.gestureId === gestureId.value &&
				current?.clientId === options.clientId()
			) {
				acknowledged = true;
			} else if (current || acknowledged) {
				// Another viewer's explicit speed change or gesture takes precedence.
				stop(false);
			}
		},
		{ flush: "sync" },
	);
	watch(options.connected, connected => {
		if (!connected) {
			stop(false);
		}
	});
	watch(options.currentVideo, () => stop());
	onUnmounted(() => stop());

	return { gestureId, start, stop };
}
