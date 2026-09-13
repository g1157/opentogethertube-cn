import { onUnmounted, ref } from "vue";
import type {
	ClientMessageSignal,
	ClientMessageVoice,
	RtcIceServer,
	ServerMessage,
	ServerMessageSignal,
	ServerMessageVoice,
	VoiceDeniedReason,
	VoiceIceCandidate,
	VoiceSignalPayload,
} from "ott-common/models/messages";
import type { ClientId } from "ott-common/models/types";
import { useConnection } from "@/plugins/connection";
import { useStore } from "@/store";

/**
 * How much the shared media drops while the local microphone is picking up speech. -8 dB is the
 * value the Chinese music-app "listen together" feature settled on; it keeps dialogue audible.
 */
const DUCK_FACTOR = 0.4;
const SPEAKING_THRESHOLD = 0.02;
const SPEAKING_POLL_MS = 120;

export function useVoice() {
	const connection = useConnection();
	const store = useStore();

	const available = ref(false);
	const joined = ref(false);
	const muted = ref(false);
	const speaking = ref(false);
	/** False when the server withheld relay servers because the usage budget is spent. */
	const relay = ref(false);
	const participants = ref<ClientId[]>([]);
	const error = ref<VoiceDeniedReason | "mic-permission" | null>(null);

	let iceServers: RtcIceServer[] = [];
	let localStream: MediaStream | null = null;
	const peers = new Map<ClientId, RTCPeerConnection>();
	const pendingCandidates = new Map<ClientId, RTCIceCandidateInit[]>();
	const audioElements = new Map<ClientId, HTMLAudioElement>();
	const savedVolumes = new Map<HTMLMediaElement, number>();
	let audioContext: AudioContext | null = null;
	let speakingTimer: ReturnType<typeof setInterval> | null = null;
	let duckActive = false;

	function selfId(): ClientId {
		return store.state.users.you.id;
	}

	function sendSignal(to: ClientId, signal: VoiceSignalPayload) {
		const msg: ClientMessageSignal = { action: "signal", to, signal };
		try {
			connection.send(msg);
		} catch {
			// A signal for a peer that vanished is harmless; the presence update will clean up.
		}
	}

	function sendPresence(joinedVoice: boolean) {
		const msg: ClientMessageVoice = { action: "voice", joined: joinedVoice };
		try {
			connection.send(msg);
		} catch {
			// The socket may already be closing; disconnect cleanup handles the server side.
		}
	}

	function ensurePeer(remoteId: ClientId): RTCPeerConnection {
		const existing = peers.get(remoteId);
		if (existing) {
			return existing;
		}
		const pc = new RTCPeerConnection({ iceServers });
		peers.set(remoteId, pc);
		if (localStream) {
			for (const track of localStream.getTracks()) {
				pc.addTrack(track, localStream);
			}
		}
		pc.onicecandidate = e => {
			if (!e.candidate) {
				return;
			}
			sendSignal(remoteId, {
				kind: "candidate",
				candidate: {
					candidate: e.candidate.candidate,
					sdpMid: e.candidate.sdpMid,
					sdpMLineIndex: e.candidate.sdpMLineIndex,
					usernameFragment: e.candidate.usernameFragment,
				},
			});
		};
		pc.ontrack = e => {
			const stream = e.streams[0];
			if (stream) {
				attachRemoteAudio(remoteId, stream);
			}
		};
		pc.onconnectionstatechange = () => {
			if (pc.connectionState === "failed" || pc.connectionState === "closed") {
				closePeer(remoteId);
			}
		};
		return pc;
	}

	function closePeer(remoteId: ClientId) {
		const pc = peers.get(remoteId);
		if (pc) {
			pc.onicecandidate = null;
			pc.ontrack = null;
			pc.onconnectionstatechange = null;
			pc.close();
			peers.delete(remoteId);
		}
		pendingCandidates.delete(remoteId);
		const el = audioElements.get(remoteId);
		if (el) {
			el.srcObject = null;
			el.remove();
			audioElements.delete(remoteId);
		}
	}

	function attachRemoteAudio(remoteId: ClientId, stream: MediaStream) {
		let el = audioElements.get(remoteId);
		if (!el) {
			el = document.createElement("audio");
			el.autoplay = true;
			// Marks our own playback so voice ducking never lowers another participant's voice.
			el.dataset.ottVoice = "true";
			document.body.appendChild(el);
			audioElements.set(remoteId, el);
		}
		el.srcObject = stream;
		void el.play().catch(() => {
			// Autoplay can stay blocked until the page has been interacted with; the join click
			// normally satisfies that, and unmuting restores playback otherwise.
		});
	}

	async function flushCandidates(remoteId: ClientId, pc: RTCPeerConnection) {
		const pending = pendingCandidates.get(remoteId);
		if (!pending) {
			return;
		}
		pendingCandidates.delete(remoteId);
		for (const candidate of pending) {
			try {
				await pc.addIceCandidate(candidate);
			} catch (e) {
				console.warn("voice: rejected a buffered candidate", e);
			}
		}
	}

	async function startOffer(remoteId: ClientId) {
		try {
			const pc = ensurePeer(remoteId);
			const offer = await pc.createOffer();
			await pc.setLocalDescription(offer);
			sendSignal(remoteId, { kind: "offer", sdp: offer.sdp ?? "" });
		} catch (e) {
			console.warn("voice: failed to create an offer", e);
		}
	}

	async function handleSignal(msg: ServerMessageSignal) {
		const remoteId = msg.from;
		if (remoteId === selfId()) {
			return;
		}
		const signal = msg.signal;
		if (signal.kind === "candidate") {
			const pc = peers.get(remoteId);
			if (!pc || !pc.remoteDescription) {
				// Candidates routinely arrive before the description they belong to.
				const queue = pendingCandidates.get(remoteId) ?? [];
				queue.push(signal.candidate as RTCIceCandidateInit);
				pendingCandidates.set(remoteId, queue);
				return;
			}
			try {
				await pc.addIceCandidate(signal.candidate as RTCIceCandidateInit);
			} catch (e) {
				console.warn("voice: rejected a candidate", e);
			}
			return;
		}
		if (signal.kind === "offer") {
			try {
				const pc = ensurePeer(remoteId);
				await pc.setRemoteDescription({ type: "offer", sdp: signal.sdp });
				await flushCandidates(remoteId, pc);
				const answer = await pc.createAnswer();
				await pc.setLocalDescription(answer);
				sendSignal(remoteId, { kind: "answer", sdp: answer.sdp ?? "" });
			} catch (e) {
				console.warn("voice: failed to answer an offer", e);
			}
			return;
		}
		const pc = peers.get(remoteId);
		if (!pc) {
			return;
		}
		try {
			await pc.setRemoteDescription({ type: "answer", sdp: signal.sdp });
			await flushCandidates(remoteId, pc);
		} catch (e) {
			console.warn("voice: failed to apply an answer", e);
		}
	}

	async function handleVoice(msg: ServerMessageVoice) {
		available.value = true;
		iceServers = msg.iceServers ?? [];
		relay.value = msg.relay;
		participants.value = msg.participants;
		if (msg.denied) {
			error.value = msg.denied;
		}
		const me = selfId();
		const isParticipant = msg.participants.includes(me);
		if (joined.value && !isParticipant) {
			// The server is authoritative: it refused the join, or removed us when the hard relay
			// budget was reached. Drop local capture without asking it again.
			teardownLocal();
			return;
		}
		if (joined.value && isParticipant) {
			error.value = null;
		}
		const remote = msg.participants.filter(id => id !== me);
		for (const id of [...peers.keys()]) {
			if (!remote.includes(id)) {
				closePeer(id);
			}
		}
		if (!joined.value) {
			return;
		}
		for (const id of remote) {
			// Only the lexicographically smaller id offers, so both sides never offer at once.
			if (!peers.has(id) && me < id) {
				await startOffer(id);
			}
		}
	}

	/**
	 * Spike-level ducking: lowers every media element except our own peer audio. This fights the
	 * player's own volume control, so it has to move into the player store before this ships.
	 */
	function duck(active: boolean) {
		if (active === duckActive) {
			return;
		}
		duckActive = active;
		for (const el of document.querySelectorAll<HTMLMediaElement>("video, audio")) {
			if (el.dataset.ottVoice === "true") {
				continue;
			}
			if (active) {
				if (!savedVolumes.has(el)) {
					savedVolumes.set(el, el.volume);
				}
				el.volume = (savedVolumes.get(el) ?? 1) * DUCK_FACTOR;
			} else {
				const saved = savedVolumes.get(el);
				if (saved !== undefined) {
					el.volume = saved;
					savedVolumes.delete(el);
				}
			}
		}
	}

	function startSpeakingDetection() {
		if (!localStream) {
			return;
		}
		try {
			audioContext = new AudioContext();
			const source = audioContext.createMediaStreamSource(localStream);
			const analyser = audioContext.createAnalyser();
			analyser.fftSize = 512;
			source.connect(analyser);
			const buffer = new Float32Array(analyser.fftSize);
			speakingTimer = setInterval(() => {
				analyser.getFloatTimeDomainData(buffer);
				let sum = 0;
				for (const sample of buffer) {
					sum += sample * sample;
				}
				const rms = Math.sqrt(sum / buffer.length);
				const active = !muted.value && rms > SPEAKING_THRESHOLD;
				speaking.value = active;
				duck(active);
			}, SPEAKING_POLL_MS);
		} catch (e) {
			console.warn("voice: speaking detection is unavailable", e);
		}
	}

	function teardownMedia() {
		if (speakingTimer !== null) {
			clearInterval(speakingTimer);
			speakingTimer = null;
		}
		duck(false);
		for (const track of localStream?.getTracks() ?? []) {
			track.stop();
		}
		localStream = null;
		if (audioContext) {
			void audioContext.close().catch(() => {
				// Closing an already-closed context is not actionable.
			});
			audioContext = null;
		}
	}

	async function join() {
		if (joined.value) {
			return;
		}
		error.value = null;
		try {
			localStream = await navigator.mediaDevices.getUserMedia({
				audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
			});
		} catch (e) {
			console.warn("voice: microphone is unavailable", e);
			error.value = "mic-permission";
			return;
		}
		joined.value = true;
		muted.value = false;
		startSpeakingDetection();
		sendPresence(true);
	}

	/** Drops everything local without telling the server, for when the server already decided. */
	function teardownLocal() {
		joined.value = false;
		muted.value = false;
		speaking.value = false;
		teardownMedia();
		for (const id of [...peers.keys()]) {
			closePeer(id);
		}
	}

	function leave() {
		if (joined.value) {
			sendPresence(false);
		}
		teardownLocal();
	}

	function toggleMute() {
		muted.value = !muted.value;
		for (const track of localStream?.getAudioTracks() ?? []) {
			track.enabled = !muted.value;
		}
		if (muted.value) {
			speaking.value = false;
			duck(false);
		}
	}

	const onVoiceMessage = (msg: ServerMessage) => {
		if (msg.action !== "voice") {
			return;
		}
		void handleVoice(msg);
	};
	const onSignalMessage = (msg: ServerMessage) => {
		if (msg.action !== "signal") {
			return;
		}
		void handleSignal(msg);
	};
	connection.addMessageHandler("voice", onVoiceMessage);
	connection.addMessageHandler("signal", onSignalMessage);

	onUnmounted(() => {
		leave();
		connection.removeMessageHandler("voice", onVoiceMessage);
		connection.removeMessageHandler("signal", onSignalMessage);
	});

	return {
		available,
		joined,
		muted,
		speaking,
		relay,
		participants,
		error,
		join,
		leave,
		toggleMute,
	};
}
