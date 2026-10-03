import { onBeforeUnmount, onMounted, ref, shallowRef, watch, type Ref } from "vue";
import type { AudioEqPreset } from "@/stores/settings";
import {
	AUDIO_EQ_BANDS_HZ,
	AUDIO_EQ_Q,
	canRouteMediaThroughWebAudio,
	elementAudioRoutingSupported,
	resolveEqBands,
} from "@/util/audio-eq";

const MIN_AUDIO_BOOST = 100;
const MAX_AUDIO_BOOST = 300;

function clampAudioBoost(boost: number): number {
	return Math.min(Math.max(boost, MIN_AUDIO_BOOST), MAX_AUDIO_BOOST);
}

/** dB → linear multiplier for the preamp stage. */
function dbToGain(db: number): number {
	return 10 ** (db / 20);
}

/**
 * True while the current source cannot be routed through Web Audio (no CORS headers, no
 * crossorigin load). The settings UI reads it to explain why an audio effect is inert.
 */
export const audioEqSourceBlocked = ref(false);

/**
 * The player's local audio graph: a fixed chain of
 * `source → 10 peaking filters → preamp → boost gain → destination`.
 *
 * The chain is built once per media element and never rewired; "off" is expressed by zero
 * filter gains and unity preamp, which keeps a re-connect bug from ever doubling the
 * signal. Creating a MediaElementAudioSourceNode permanently routes the element through
 * Web Audio, so the one thing this module must never do is build the graph for a resource
 * that would be silenced by the browser's CORS rule — see canRouteMediaThroughWebAudio.
 */
export function useMediaAudioBoost(
	mediaElement: Ref<HTMLMediaElement | undefined>,
	createContext: () => AudioContext = () => new AudioContext(),
) {
	const context = shallowRef<AudioContext>();
	const source = shallowRef<MediaElementAudioSourceNode>();
	const filters = shallowRef<BiquadFilterNode[]>([]);
	const preamp = shallowRef<GainNode>();
	const gain = shallowRef<GainNode>();
	const isConnected = ref(false);
	const setupFailed = ref(false);
	let desiredBoost = MIN_AUDIO_BOOST;
	let desiredEq: AudioEqPreset = "off";

	function resumeContext() {
		const audioContext = context.value;
		if (audioContext && audioContext.state === "suspended") {
			void audioContext.resume().catch(err => {
				console.warn("Failed to resume media audio context", err);
			});
		}
	}

	function buildGraph(element: HTMLMediaElement, audioContext: AudioContext): boolean {
		try {
			// Everything that can throw is built before the element is permanently routed,
			// and the output is connected last: a failure along the way leaves nothing
			// attached to the destination.
			const eqNodes = AUDIO_EQ_BANDS_HZ.map(hz => {
				const filter = audioContext.createBiquadFilter();
				filter.type = "peaking";
				filter.frequency.value = hz;
				filter.Q.value = AUDIO_EQ_Q;
				filter.gain.value = 0;
				return filter;
			});
			const preampNode = audioContext.createGain();
			const gainNode = audioContext.createGain();
			for (let i = 0; i < eqNodes.length - 1; i++) {
				eqNodes[i].connect(eqNodes[i + 1]);
			}
			eqNodes[eqNodes.length - 1].connect(preampNode);
			preampNode.connect(gainNode);

			const sourceNode = audioContext.createMediaElementSource(element);
			sourceNode.connect(eqNodes[0]);
			gainNode.connect(audioContext.destination);

			source.value = sourceNode;
			filters.value = eqNodes;
			preamp.value = preampNode;
			gain.value = gainNode;
			isConnected.value = true;
			audioEqSourceBlocked.value = false;
			return true;
		} catch (err) {
			setupFailed.value = true;
			console.warn("Failed to initialize media audio graph", err);
			return false;
		}
	}

	function ensureGraph(): boolean {
		if (isConnected.value) {
			return true;
		}
		if (setupFailed.value) {
			return false;
		}
		const element = mediaElement.value;
		const audioContext = context.value;
		if (!element || !audioContext) {
			return false;
		}
		if (!elementAudioRoutingSupported()) {
			// WebKit turns attached element audio into permanent playback stutter; the
			// settings UI hides the feature there, and this guard keeps it from being
			// engaged by any other caller.
			return false;
		}
		if (!canRouteMediaThroughWebAudio(element, window.location.origin)) {
			// Routing a CORS-restricted source through Web Audio would output silence, and
			// the routing cannot be taken back once created.
			audioEqSourceBlocked.value = true;
			return false;
		}
		return buildGraph(element, audioContext);
	}

	function applyBoost() {
		if (gain.value) {
			gain.value.gain.value = clampAudioBoost(desiredBoost) / 100;
		}
	}

	function applyEq() {
		if (!preamp.value || filters.value.length === 0) {
			return;
		}
		const spec = resolveEqBands(desiredEq);
		filters.value.forEach((filter, index) => {
			filter.gain.value = spec?.bands[index] ?? 0;
		});
		preamp.value.gain.value = spec ? dbToGain(spec.preampDb) : 1;
	}

	/** Writes the remembered settings onto the graph, building it when anything is active. */
	function applyDesiredState() {
		const wantsGraph = desiredBoost > MIN_AUDIO_BOOST || desiredEq !== "off";
		if (!wantsGraph) {
			// Nothing to hear. A graph that exists anyway is reset so a lingering effect
			// never survives the switch that turned it off.
			if (isConnected.value) {
				applyBoost();
				applyEq();
			}
			return;
		}
		if (!ensureGraph()) {
			return;
		}
		applyBoost();
		applyEq();
		resumeContext();
	}

	function disconnectGraph() {
		source.value?.disconnect();
		for (const filter of filters.value) {
			filter.disconnect();
		}
		preamp.value?.disconnect();
		gain.value?.disconnect();
		source.value = undefined;
		filters.value = [];
		preamp.value = undefined;
		gain.value = undefined;
		isConnected.value = false;
		setupFailed.value = false;
	}

	function setBoost(boost: number): void {
		desiredBoost = clampAudioBoost(boost);
		applyDesiredState();
	}

	function setEq(preset: AudioEqPreset): void {
		desiredEq = preset;
		applyDesiredState();
	}

	function resetFailedSetup(): void {
		if (isConnected.value) {
			return;
		}
		setupFailed.value = false;
		audioEqSourceBlocked.value = false;
	}

	function hasActiveGraph(): boolean {
		return isConnected.value;
	}

	onMounted(() => {
		context.value = createContext();
	});

	// A replaced element needs its own graph: the nodes stay bound to the element they
	// were created from, and the old element is on its way out anyway.
	watch(mediaElement, () => {
		disconnectGraph();
		applyDesiredState();
	});

	onBeforeUnmount(() => {
		disconnectGraph();
		const audioContext = context.value;
		context.value = undefined;
		if (audioContext && audioContext.state !== "closed") {
			void audioContext.close().catch(err => {
				console.warn("Failed to close media audio context", err);
			});
		}
	});

	return {
		context,
		source,
		filters,
		preamp,
		gain,
		isConnected,
		setBoost,
		setEq,
		resetFailedSetup,
		hasActiveGraph,
	};
}
