import type { AudioEqPreset } from "@/stores/settings";

/**
 * Ten peaking bands at the frequencies AtomPlayer+ and desktop players use. They cover
 * the audible range in roughly octave steps, which is enough for the two presets below
 * and leaves room for per-band controls later.
 */
export const AUDIO_EQ_BANDS_HZ = [32, 63, 125, 250, 500, 1000, 2000, 4000, 8000, 16000] as const;

/** Bandwidth of each peaking filter; 1.0 matches the reference player. */
export const AUDIO_EQ_Q = 1;

export interface AudioEqSpec {
	/** Gain in dB per band of AUDIO_EQ_BANDS_HZ. */
	bands: readonly number[];
	/** Headroom taken before the boost stage so the boosted bands cannot clip hot mixes. */
	preampDb: number;
}

export const AUDIO_EQ_SPECS: Record<Exclude<AudioEqPreset, "off">, AudioEqSpec> = {
	// Lift the low end and trim the top a little; the preamp keeps loud content from
	// clipping after +6 dB of bass.
	bass: { bands: [6, 6, 5, 2, 0, 0, 0, -1, -1, -1], preampDb: -3 },
	// Make dialogue cut through: take out the rumble and mud, lift the presence range.
	vocal: { bands: [-6, -4, -2, 0, 1, 2, 3, 2, 0, 0], preampDb: -2 },
};

/** The bands and preamp for a preset, or null for "off" (leave the mix as it is). */
export function resolveEqBands(preset: AudioEqPreset): AudioEqSpec | null {
	if (preset === "off") {
		return null;
	}
	return AUDIO_EQ_SPECS[preset] ?? null;
}

const IOS_USER_AGENT = /iPhone|iPad|iPod/;
const SAFARI_USER_AGENT = /Safari\//;
const NON_SAFARI_BRAND = /(Chrome|Chromium|CriOS|Edg|EdgiOS|FxiOS|OPR)/;

/**
 * Whether this browser can route a playing video's audio through Web Audio without
 * wrecking playback. WebKit is excluded — Safari (and every iOS browser, which is WebKit
 * underneath): once an element's audio has been attached to a Web Audio graph there,
 * both the picture and the sound stutter for as long as that element lives, and the
 * routing cannot be detached, so the only honest behaviour is to leave the graph alone.
 */
export function elementAudioRoutingSupported(
	userAgent = typeof navigator === "undefined" ? "" : navigator.userAgent,
): boolean {
	if (!userAgent) {
		return true;
	}
	const ios = IOS_USER_AGENT.test(userAgent);
	const safariDesktop = SAFARI_USER_AGENT.test(userAgent) && !NON_SAFARI_BRAND.test(userAgent);
	return !ios && !safariDesktop;
}

function isSameOrigin(source: string, pageOrigin: string): boolean {
	try {
		return new URL(source, pageOrigin).origin === pageOrigin;
	} catch {
		return false;
	}
}

/**
 * Whether this media element can be routed through Web Audio without silence. A
 * CORS-cross-origin resource makes a MediaElementAudioSourceNode output nothing, and the
 * routing cannot be undone once a graph is built, so this has to be answered before the
 * first node is created. MSE output (blob:) and same-origin files are always clean; a
 * remote file is clean when it was fetched in CORS mode, which the crossorigin attribute
 * records for the current load.
 */
export function canRouteMediaThroughWebAudio(
	media: Pick<HTMLMediaElement, "currentSrc" | "src" | "crossOrigin">,
	pageOrigin: string,
): boolean {
	// Falsy covers both null (attribute absent) and "" (the empty attribute value some
	// DOM implementations report); either way the load was not made in CORS mode.
	const corsFlagged = Boolean(media.crossOrigin);
	const source = media.currentSrc || media.src;
	if (!source) {
		// Nothing loaded yet. Only a set crossorigin attribute guarantees that whatever
		// loads next is fetched in CORS mode; without it the answer has to wait.
		return corsFlagged;
	}
	if (source.startsWith("blob:")) {
		return true;
	}
	if (isSameOrigin(source, pageOrigin)) {
		return true;
	}
	return corsFlagged;
}
