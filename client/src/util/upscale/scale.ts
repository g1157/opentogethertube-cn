// Canvas sizing for the video enhancement layer.
//
// The canvas is the render target: both the sharpen shader and the Anime4K
// pipeline cost scales with how many pixels it holds, so the size has to follow
// what is actually displayed rather than the source resolution. A 1080p video
// shown in a 390x219 CSS px box on a phone only has 780x438 device pixels to
// fill; rendering 1920x1080 there is ~6x the work for pixels nobody sees.

/** Never render more than this multiple of the source, even when asked to. */
export const MAX_SCALE = 2;

/**
 * Floor for the automatic size. Low enough that high resolution sources shown
 * small (4K on a phone) are not forced to over-render, while still avoiding
 * degenerate canvases before layout has produced a real box.
 */
export const MIN_AUTO_SCALE = 0.25;

export interface CanvasSizeInput {
	nativeWidth: number;
	nativeHeight: number;
	/** Size of the element the canvas is stretched over, in CSS pixels. */
	boxWidth: number;
	boxHeight: number;
	dpr: number;
	/** Explicit multiplier from settings, or "auto" to fit the displayed box. */
	requestedScale: number | "auto";
}

export interface CanvasSize {
	width: number;
	height: number;
}

export function computeCanvasSize(input: CanvasSizeInput): CanvasSize {
	const nativeWidth = Math.max(1, Math.floor(input.nativeWidth) || 1);
	const nativeHeight = Math.max(1, Math.floor(input.nativeHeight) || 1);

	let scale: number;
	if (input.requestedScale === "auto") {
		// The canvas uses object-fit: contain, so the displayed video is limited by
		// whichever axis runs out of box first: the smaller ratio is the one that
		// covers the picture without over-rendering the other axis.
		const ratioX = (Math.max(input.boxWidth, 1) * input.dpr) / nativeWidth;
		const ratioY = (Math.max(input.boxHeight, 1) * input.dpr) / nativeHeight;
		scale = Math.min(ratioX, ratioY);
	} else {
		// An explicit choice is followed literally, including on the way up, so the
		// top tiers can supersample regardless of how small the box is.
		scale = input.requestedScale;
	}

	scale = Math.min(MAX_SCALE, Math.max(MIN_AUTO_SCALE, scale));
	return {
		width: Math.max(1, Math.round(nativeWidth * scale)),
		height: Math.max(1, Math.round(nativeHeight * scale)),
	};
}
