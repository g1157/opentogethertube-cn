import { computeCanvasSize } from "./scale";

export interface RenderedTarget {
	width: number;
	height: number;
	scale: number;
}

/**
 * The canvas the enhancement would render a source at, given the box the picture is
 * shown in. The picture is letterboxed inside that box, so the contained size comes
 * first — the same fit the player uses.
 */
export function computeRenderedTarget(options: {
	nativeWidth?: number;
	nativeHeight?: number;
	boxWidth: number;
	boxHeight: number;
	dpr: number;
	requestedScale: number | "auto";
	/** Mirrors the layer's device rule, so the preview matches what is rendered. */
	cnnUpscale?: boolean;
	fillMode?: "contain" | "cover";
}): RenderedTarget | null {
	const { nativeWidth, nativeHeight } = options;
	if (!nativeWidth || !nativeHeight || options.boxWidth <= 0 || options.boxHeight <= 0) {
		return null;
	}
	const size = computeCanvasSize({
		nativeWidth,
		nativeHeight,
		boxWidth: options.boxWidth,
		boxHeight: options.boxHeight,
		dpr: options.dpr,
		requestedScale: options.requestedScale,
		cnnUpscale: options.cnnUpscale,
		fillMode: options.fillMode,
	});
	return { width: size.width, height: size.height, scale: size.width / nativeWidth };
}

/** Size of the room's picture area, when a room is on screen. */
export function measurePlayerBox(): { width: number; height: number } | null {
	if (typeof document === "undefined") {
		return null;
	}
	const container = document.querySelector('[data-cy="player-container"]');
	if (!container) {
		return null;
	}
	const rect = container.getBoundingClientRect();
	return rect.width > 0 && rect.height > 0 ? { width: rect.width, height: rect.height } : null;
}
