import { computed, onUnmounted, ref } from "vue";
import type {
	ClientMessageSignal,
	ClientMessageVoice,
	RtcIceServer,
	ServerMessage,
	ServerMessageSignal,
	ServerMessageVoice,
	VoiceDeniedReason,
	VoiceSignalPayload,
} from "ott-common/models/messages";
import type { ClientId } from "ott-common/models/types";
import { useConnection } from "@/plugins/connection";
import { useStore } from "@/store";
import { useVolume } from "@/components/composables";

/**
 * How much the shared media drops while the local microphone is picking up speech. -8 dB is the
 * value the Chinese music-app "listen together" feature settled on; it keeps dialogue audible.
 */
const DUCK_FACTOR = 0.4;
const SPEAKING_THRESHOLD = 0.02;
const SPEAKING_POLL_MS = 120;

/** Give ICE this long before reporting a failure instead of "connecting" forever. */
const CONNECT_TIMEOUT_MS = 10000;
const PATH_POLL_MS = 600;
const PATH_POLL_LIMIT = 8;
/** Bounded, deterministic re-offer schedule used by the smaller client id. */
const RECONNECT_DELAYS_MS = [1500, 4000, 8000];

/**
 * Half-duplex echo guard. On a phone speaker the browser's AEC cannot cancel a loud remote voice
 * completely, and in a mesh that residual loops back and forth. While any remote stream is above
 * this level the local microphone sends silence; the hold bridges word gaps so the gate does not
 * chatter. It defaults to on for touch devices and can be turned off when using headphones.
 */
const REMOTE_ECHO_THRESHOLD = 0.01;
const ECHO_POLL_MS = 80;
const ECHO_HOLD_MS = 350;
const TOUCH_PRIMARY_QUERY = "(hover: none) and (pointer: coarse)";

export type VoicePeerState = "connecting" | "connected" | "direct" | "relay" | "failed";

export interface VoicePeerSummary {
	total: number;
	connecting: number;
	connected: number;
	direct: number;
	relay: number;
	failed: number;
}

export function summarizeVoicePeers(states: Record<string, VoicePeerState>): VoicePeerSummary {
	const summary: VoicePeerSummary = {
		total: 0,
		connecting: 0,
		connected: 0,
		direct: 0,
		relay: 0,
		failed: 0,
	};
	for (const state of Object.values(states)) {
		summary.total++;
		summary[state]++;
	}
	return summary;
}

/**
 * Reads the selected candidate pair from a WebRTC stats report. A pair is a relay only when one
 * of its candidates is a TURN candidate; server-reflexive and peer-reflexive addresses are still
 * direct media paths. Returns null while the pair is not available yet.
 */
export function getPeerPath(stats: RTCStatsReport): "direct" | "relay" | null {
	let selectedPairId: string | null = null;
	stats.forEach(report => {
		if (report.type === "transport" && typeof report.selectedCandidatePairId === "string") {
			selectedPairId = report.selectedCandidatePairId;
		} else if (report.type === "candidate-pair" && report.selected === true) {
			selectedPairId = report.id;
		}
	});
	if (!selectedPairId) {
		return null;
	}
	const pair = stats.get(selectedPairId);
	if (!pair) {
		return null;
	}
	const local = stats.get(pair.localCandidateId);
	const remote = stats.get(pair.remoteCandidateId);
	const localType = local?.candidateType;
	const remoteType = remote?.candidateType;
	if (!localType || !remoteType) {
		return null;
	}
	return localType === "relay" || remoteType === "relay" ? "relay" : "direct";
}

export function useVoice() {
	const connection = useConnection();
	const store = useStore();
	const volume = useVolume();

	const available = ref(false);
	const joined = ref(false);
	const muted = ref(false);
	const speaking = ref(false);
	/** False when the server withheld relay servers because the usage budget is spent. */
	const relay = ref(false);
	const participants = ref<ClientId[]>([]);
	const error = ref<VoiceDeniedReason | "mic-permission" | null>(null);
	const peerStates = ref<Record<string, VoicePeerState>>({});
	const echoGuard = ref(prefersTouchPrimary());
	const echoSuppressed = ref(false);

	let iceServers: RtcIceServer[] = [];
	let localStream: MediaStream | null = null;
	const peers = new Map<ClientId, RTCPeerConnection>();
	const pendingCandidates = new Map<ClientId, RTCIceCandidateInit[]>();
	const audioElements = new Map<ClientId, HTMLAudioElement>();
	const remoteStreams = new Map<ClientId, MediaStream>();
	const remoteAnalysers = new Map<
		ClientId,
		{ source: MediaStreamAudioSourceNode; analyser: AnalyserNode; buffer: Float32Array }
	>();
	const connectTimers = new Map<ClientId, ReturnType<typeof setTimeout>>();
	const pathTimers = new Map<ClientId, ReturnType<typeof setTimeout>>();
	const retryTimers = new Map<ClientId, ReturnType<typeof setTimeout>>();
	const reconnectAttempts = new Map<ClientId, number>();
	let audioContext: AudioContext | null = null;
	/** Zero-gain sink that keeps analyser graphs rendered without duplicating remote audio. */
	let echoSink: GainNode | null = null;
	let speakingTimer: ReturnType<typeof setInterval> | null = null;
	let echoTimer: ReturnType<typeof setInterval> | null = null;
	let lastRemoteLoudAt = 0;
	let duckActive = false;
	let joining = false;
	let joinEpoch = 0;

	const summary = computed(() => summarizeVoicePeers(peerStates.value));

	function selfId(): ClientId {
		return store.state.users.you.id;
	}

	function prefersTouchPrimary(): boolean {
		return (
			typeof window !== "undefined" &&
			typeof window.matchMedia === "function" &&
			window.matchMedia(TOUCH_PRIMARY_QUERY).matches
		);
	}

	function setPeerState(remoteId: ClientId, state: VoicePeerState) {
		if (peerStates.value[remoteId] === state) {
			return;
		}
		peerStates.value = { ...peerStates.value, [remoteId]: state };
	}

	function clearPeerState(remoteId: ClientId) {
		if (!(remoteId in peerStates.value)) {
			return;
		}
		const next = { ...peerStates.value };
		delete next[remoteId];
		peerStates.value = next;
	}

	function clearTimer(timers: Map<ClientId, ReturnType<typeof setTimeout>>, remoteId: ClientId) {
		const timer = timers.get(remoteId);
		if (timer !== undefined) {
			clearTimeout(timer);
			timers.delete(remoteId);
		}
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

	/** Without this the UI would keep saying "connecting" after ICE silently gave up. */
	function armConnectTimer(remoteId: ClientId, delayMs = CONNECT_TIMEOUT_MS) {
		clearTimer(connectTimers, remoteId);
		connectTimers.set(
			remoteId,
			setTimeout(() => {
				connectTimers.delete(remoteId);
				if (!joined.value || !participants.value.includes(remoteId)) {
					return;
				}
				const state = peerStates.value[remoteId];
				if (state === "direct" || state === "relay" || state === "connected") {
					return;
				}
				setPeerState(remoteId, "failed");
				const pc = peers.get(remoteId);
				if (pc) {
					handlePeerFailure(remoteId, pc);
				} else if (selfId() < remoteId) {
					scheduleReconnect(remoteId);
				}
			}, delayMs),
		);
	}

	function schedulePathPoll(remoteId: ClientId, pc: RTCPeerConnection, attempt = 0) {
		clearTimer(pathTimers, remoteId);
		pathTimers.set(
			remoteId,
			setTimeout(
				async () => {
					pathTimers.delete(remoteId);
					if (peers.get(remoteId) !== pc) {
						return;
					}
					let path: "direct" | "relay" | null = null;
					try {
						path = getPeerPath(await pc.getStats());
					} catch {
						path = null;
					}
					if (peers.get(remoteId) !== pc) {
						return;
					}
					if (path) {
						setPeerState(remoteId, path);
						reconnectAttempts.delete(remoteId);
						return;
					}
					if (attempt + 1 < PATH_POLL_LIMIT) {
						schedulePathPoll(remoteId, pc, attempt + 1);
					}
				},
				attempt === 0 ? 300 : PATH_POLL_MS,
			),
		);
	}

	/** Only the smaller id offers, so only it rebuilds a failed pair; the other side waits. */
	function scheduleReconnect(remoteId: ClientId) {
		if (!joined.value) {
			return;
		}
		const attempt = reconnectAttempts.get(remoteId) ?? 0;
		if (attempt >= RECONNECT_DELAYS_MS.length) {
			return;
		}
		clearTimer(retryTimers, remoteId);
		reconnectAttempts.set(remoteId, attempt + 1);
		retryTimers.set(
			remoteId,
			setTimeout(() => {
				retryTimers.delete(remoteId);
				if (!joined.value || !participants.value.includes(remoteId)) {
					return;
				}
				if (peers.has(remoteId)) {
					return;
				}
				setPeerState(remoteId, "connecting");
				armConnectTimer(remoteId);
				void startOffer(remoteId);
			}, RECONNECT_DELAYS_MS[attempt]),
		);
	}

	function handlePeerFailure(remoteId: ClientId, pc: RTCPeerConnection) {
		if (peers.get(remoteId) !== pc) {
			return;
		}
		closePeer(remoteId);
		setPeerState(remoteId, "failed");
		if (selfId() < remoteId) {
			scheduleReconnect(remoteId);
		}
	}

	function ensurePeer(remoteId: ClientId): RTCPeerConnection {
		const existing = peers.get(remoteId);
		if (existing) {
			return existing;
		}
		const pc = new RTCPeerConnection({ iceServers });
		peers.set(remoteId, pc);
		setPeerState(remoteId, "connecting");
		armConnectTimer(remoteId);
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
			if (peers.get(remoteId) !== pc) {
				return;
			}
			switch (pc.connectionState) {
				case "connected":
					clearTimer(connectTimers, remoteId);
					reconnectAttempts.delete(remoteId);
					if (
						peerStates.value[remoteId] !== "direct" &&
						peerStates.value[remoteId] !== "relay"
					) {
						setPeerState(remoteId, "connected");
					}
					schedulePathPoll(remoteId, pc);
					break;
				case "disconnected":
					setPeerState(remoteId, "connecting");
					armConnectTimer(remoteId);
					break;
				case "failed":
					handlePeerFailure(remoteId, pc);
					break;
				case "closed":
					closePeer(remoteId);
					break;
			}
		};
		return pc;
	}

	function closePeer(remoteId: ClientId) {
		clearTimer(connectTimers, remoteId);
		clearTimer(pathTimers, remoteId);
		clearTimer(retryTimers, remoteId);
		const pc = peers.get(remoteId);
		if (pc) {
			pc.onicecandidate = null;
			pc.ontrack = null;
			pc.onconnectionstatechange = null;
			pc.close();
			peers.delete(remoteId);
		}
		pendingCandidates.delete(remoteId);
		removeRemoteAnalyser(remoteId);
		remoteStreams.delete(remoteId);
		const el = audioElements.get(remoteId);
		if (el) {
			el.srcObject = null;
			el.remove();
			audioElements.delete(remoteId);
		}
		clearPeerState(remoteId);
	}

	function attachRemoteAudio(remoteId: ClientId, stream: MediaStream) {
		if (remoteStreams.get(remoteId) !== stream) {
			removeRemoteAnalyser(remoteId);
			remoteStreams.set(remoteId, stream);
			if (echoGuard.value) {
				addRemoteAnalyser(remoteId, stream);
			}
		}
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

	function addRemoteAnalyser(remoteId: ClientId, stream: MediaStream) {
		if (!audioContext || remoteAnalysers.has(remoteId)) {
			return;
		}
		try {
			const source = audioContext.createMediaStreamSource(stream);
			const analyser = audioContext.createAnalyser();
			analyser.fftSize = 256;
			source.connect(analyser);
			if (echoSink) {
				// An analyser with no path to the destination is not rendered in every browser.
				// The sink has zero gain, so this tap never adds audible audio.
				analyser.connect(echoSink);
			}
			remoteAnalysers.set(remoteId, {
				source,
				analyser,
				buffer: new Float32Array(analyser.fftSize),
			});
			startEchoPolling();
		} catch (e) {
			console.warn("voice: echo monitoring is unavailable for a peer", e);
		}
	}

	function removeRemoteAnalyser(remoteId: ClientId) {
		const entry = remoteAnalysers.get(remoteId);
		if (!entry) {
			return;
		}
		try {
			entry.source.disconnect();
		} catch {
			// Disconnecting an already-closed stream is not actionable.
		}
		remoteAnalysers.delete(remoteId);
		if (remoteAnalysers.size === 0) {
			stopEchoPolling();
		}
	}

	function startEchoPolling() {
		if (echoTimer !== null || remoteAnalysers.size === 0) {
			return;
		}
		echoTimer = setInterval(() => {
			if (echoTimer === null) {
				return;
			}
			let loud = false;
			for (const { analyser, buffer } of remoteAnalysers.values()) {
				analyser.getFloatTimeDomainData(buffer);
				let sum = 0;
				for (const sample of buffer) {
					sum += sample * sample;
				}
				if (Math.sqrt(sum / buffer.length) > REMOTE_ECHO_THRESHOLD) {
					loud = true;
					break;
				}
			}
			if (loud) {
				lastRemoteLoudAt = Date.now();
			}
			setEchoSuppressed(Date.now() - lastRemoteLoudAt < ECHO_HOLD_MS);
		}, ECHO_POLL_MS);
	}

	function stopEchoPolling() {
		if (echoTimer !== null) {
			clearInterval(echoTimer);
			echoTimer = null;
		}
		for (const entry of remoteAnalysers.values()) {
			try {
				entry.source.disconnect();
			} catch {
				// Already disconnected.
			}
		}
		remoteAnalysers.clear();
		lastRemoteLoudAt = 0;
		setEchoSuppressed(false);
	}

	function setEchoGuard(enabled: boolean) {
		echoGuard.value = enabled;
		if (!enabled) {
			stopEchoPolling();
			return;
		}
		for (const [remoteId, stream] of remoteStreams) {
			addRemoteAnalyser(remoteId, stream);
		}
	}

	function toggleEchoGuard() {
		setEchoGuard(!echoGuard.value);
	}

	function applyMicState() {
		const enabled = !muted.value && !echoSuppressed.value;
		for (const track of localStream?.getAudioTracks() ?? []) {
			track.enabled = enabled;
		}
	}

	function setEchoSuppressed(suppress: boolean) {
		if (echoSuppressed.value === suppress) {
			return;
		}
		echoSuppressed.value = suppress;
		applyMicState();
		if (suppress) {
			speaking.value = false;
			duck(false);
		}
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
			} else if (!peers.has(id) && !(id in peerStates.value)) {
				// The other side has not offered yet. Without a timer this would say "connecting"
				// forever when signaling itself is lost.
				setPeerState(id, "connecting");
				armConnectTimer(id);
			}
		}
	}

	/**
	 * Ducking multiplies the player volume instead of writing to media elements, so the volume
	 * slider keeps showing the user's own level and peer audio is never affected.
	 */
	function duck(active: boolean) {
		if (active === duckActive) {
			return;
		}
		duckActive = active;
		volume.duckFactor.value = active ? DUCK_FACTOR : 1;
	}

	function startSpeakingDetection() {
		if (!localStream) {
			return;
		}
		try {
			audioContext = new AudioContext();
			if (typeof audioContext.resume === "function") {
				void audioContext.resume().catch(() => {
					// A context created from the join click is normally running already.
				});
			}
			if (typeof audioContext.createGain === "function" && audioContext.destination) {
				echoSink = audioContext.createGain();
				echoSink.gain.value = 0;
				echoSink.connect(audioContext.destination);
			}
			const source = audioContext.createMediaStreamSource(localStream);
			const analyser = audioContext.createAnalyser();
			analyser.fftSize = 512;
			source.connect(analyser);
			if (echoSink) {
				analyser.connect(echoSink);
			}
			const buffer = new Float32Array(analyser.fftSize);
			speakingTimer = setInterval(() => {
				// A tick queued before teardown still runs once after clearInterval; without
				// this guard its duck(true) would land after the closing duck(false) and hold
				// the shared media at the ducking level until the next join.
				if (speakingTimer === null) {
					return;
				}
				analyser.getFloatTimeDomainData(buffer);
				let sum = 0;
				for (const sample of buffer) {
					sum += sample * sample;
				}
				const rms = Math.sqrt(sum / buffer.length);
				const active = !muted.value && !echoSuppressed.value && rms > SPEAKING_THRESHOLD;
				speaking.value = active;
				duck(active);
			}, SPEAKING_POLL_MS);
		} catch (e) {
			console.warn("voice: speaking detection is unavailable", e);
		}
		if (echoGuard.value) {
			for (const [remoteId, stream] of remoteStreams) {
				addRemoteAnalyser(remoteId, stream);
			}
		}
	}

	function teardownMedia() {
		if (speakingTimer !== null) {
			clearInterval(speakingTimer);
			speakingTimer = null;
		}
		stopEchoPolling();
		remoteStreams.clear();
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
		echoSink = null;
	}

	async function join() {
		// The microphone request can take seconds (permission prompt) and the button stays live
		// during it. Without this guard a double click captured twice and left a second speaking
		// watch running after leave, which kept ducking the media intermittently.
		if (joined.value || joining) {
			return;
		}
		joining = true;
		const epoch = ++joinEpoch;
		error.value = null;
		let stream: MediaStream | null = null;
		try {
			stream = await navigator.mediaDevices.getUserMedia({
				audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
			});
		} catch (e) {
			console.warn("voice: microphone is unavailable", e);
			error.value = "mic-permission";
			return;
		} finally {
			joining = false;
		}
		if (epoch !== joinEpoch) {
			// Left (or the room unmounted) while the request was in flight: the late stream
			// must not stay open behind a joined state nobody tracks anymore.
			for (const track of stream?.getTracks() ?? []) {
				track.stop();
			}
			return;
		}
		if (stream === null) {
			return;
		}
		localStream = stream;
		joined.value = true;
		muted.value = false;
		echoSuppressed.value = false;
		applyMicState();
		startSpeakingDetection();
		sendPresence(true);
		const settings = stream.getAudioTracks()[0]?.getSettings?.();
		if (settings?.echoCancellation === false) {
			// The guard is the only remaining defense when the browser reports no AEC.
			setEchoGuard(true);
		}
	}

	/** Drops everything local without telling the server, for when the server already decided. */
	function teardownLocal() {
		joined.value = false;
		muted.value = false;
		speaking.value = false;
		echoSuppressed.value = false;
		teardownMedia();
		for (const id of [...peers.keys()]) {
			closePeer(id);
		}
		for (const timers of [connectTimers, pathTimers, retryTimers]) {
			for (const timer of timers.values()) {
				clearTimeout(timer);
			}
			timers.clear();
		}
		reconnectAttempts.clear();
		peerStates.value = {};
	}

	function leave() {
		// An in-flight join must not attach its microphone stream afterwards.
		joinEpoch++;
		if (joined.value) {
			sendPresence(false);
		}
		teardownLocal();
	}

	function toggleMute() {
		muted.value = !muted.value;
		applyMicState();
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
		summary,
		echoGuard,
		echoSuppressed,
		join,
		leave,
		toggleMute,
		setEchoGuard,
		toggleEchoGuard,
	};
}
