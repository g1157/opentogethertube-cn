// Canvas sizing for the video enhancement layer.
//
// The canvas is the render target: both the sharpen pass and the Anime4K
// pipeline cost scales with how many pixels it holds, so "auto" follows what is
// actually displayed. It never drops below the source resolution, though. The
// sharpen pass magnifies and minifies with a single tap per pixel, while the
// browser scales an untouched video with a proper multi-tap filter; a canvas
// below the source therefore makes the enhanced picture softer than the plain
// one, which is what phones were seeing (1080p in a 780x438 device-pixel box
// rendered a 0.4x canvas).

/** Never render more than this multiple of the source, even when asked to. */
export const MAX_SCALE = 3;

/**
 * Floor for the automatic size. Past this point the shader's filtering, not the
 * browser's, decides how much source detail survives, and it loses that
 * comparison. Explicit lower tiers stay available, and are where the
 * auto-degrade ladder steps down when a device cannot afford the extra pixels.
 */
export const MIN_AUTO_SCALE = 1;

/** Lowest multiplier the settings offer; also the last rung of the degrade ladder. */
export const MIN_SCALE = 0.25;

/**
 * Pixel budget for the automatic size. A source far above the display (8K on a
 * phone) would otherwise render tens of millions of pixels per frame for a
 * picture the screen cannot show.
 */
export const MAX_AUTO_PIXELS = 3840 * 2160;

/** Upper bound for the device pixel ratio used when sizing the canvas. */
export const MAX_DPR = 3;

/**
 * Minimum target the CNN tiers aim for. Anime4K's presets only run their upscale stages
 * when the target is clearly larger than the source (the library checks for >1.2x), so
 * the canvas has to clear that gate or the top tier silently drops to its restore passes,
 * which is what made it look softer than a desktop player running the same chain.
 *
 * It is a floor, not the target: past the gate the display box decides, because pixels
 * beyond what the screen can show only cost frame time and heat. On a Retina laptop the
 * box alone is 1.2-1.8x of a 1080p source; aiming at a flat 2x there rendered roughly
 * twice the pixels the screen could show, which is what put the AI tiers under the
 * auto-degrade threshold on an 8-core fanless GPU.
 */
export const CNN_MIN_UPSCALE = 1.25;

/**
 * Whether this device should render above the display box to feed the CNN. Touch devices
 * pay for those pixels in heat and battery without a big picture to show for it, so they
 * keep the box-fitted target; the auto-degrade ladder steps down either way.
 */
export function canAffordCnnUpscale(): boolean {
	if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
		return false;
	}
	return !window.matchMedia("(pointer: coarse)").matches;
}

export interface CanvasSizeInput {
	nativeWidth: number;
	nativeHeight: number;
	/** Size of the element the canvas is stretched over, in CSS pixels. */
	boxWidth: number;
	boxHeight: number;
	dpr: number;
	/** Explicit multiplier from settings, or "auto" to fit the displayed box. */
	requestedScale: number | "auto";
	/** Let "auto" supersample so the CNN's upscale stages run (see CNN_MIN_UPSCALE). */
	cnnUpscale?: boolean;
}

export interface CanvasSize {
	width: number;
	height: number;
}

/** The multiplier at which the canvas exactly covers the box the video is displayed in. */
export function fitScale(input: Omit<CanvasSizeInput, "requestedScale" | "cnnUpscale">): number {
	// The canvas uses object-fit: contain, so the displayed video is limited by whichever
	// axis runs out of box first: the smaller ratio is the one that covers the picture
	// without over-rendering the other axis.
	const ratioX = (Math.max(input.boxWidth, 1) * input.dpr) / Math.max(1, input.nativeWidth);
	const ratioY = (Math.max(input.boxHeight, 1) * input.dpr) / Math.max(1, input.nativeHeight);
	return Math.min(ratioX, ratioY);
}

/**
 * The lowest multiplier the auto-degrade ladder may step to: the source resolution, or the
 * display box when that is smaller. Below both, the shader's single-tap filtering starts
 * deciding how much source detail survives, and it loses that comparison against the
 * browser's multi-tap scaler — the picture comes out softer than the plain video, so the
 * ladder turns the enhancement off rather than leaving the viewer with that.
 */
export function ladderFloorScale(
	input: Omit<CanvasSizeInput, "requestedScale" | "cnnUpscale">,
): number {
	return Math.min(MIN_AUTO_SCALE, fitScale(input));
}

export function computeCanvasSize(input: CanvasSizeInput): CanvasSize {
	const nativeWidth = Math.max(1, Math.floor(input.nativeWidth) || 1);
	const nativeHeight = Math.max(1, Math.floor(input.nativeHeight) || 1);

	let scale: number;
	if (input.requestedScale === "auto") {
		scale = fitScale({ ...input, nativeWidth, nativeHeight });
		if (input.cnnUpscale) {
			// Past the library's upscale gate the display box is the target; below it the CNN
			// would drop to its restore passes, so the floor is what has to give way.
			scale = Math.max(scale, CNN_MIN_UPSCALE);
		}
		scale = Math.min(MAX_SCALE, Math.max(MIN_AUTO_SCALE, scale));
		// The budget only binds when the target itself would exceed it, so it caps
		// huge sources without pulling normal ones down.
		const budgetScale = Math.sqrt(MAX_AUTO_PIXELS / (nativeWidth * nativeHeight));
		scale = Math.min(scale, budgetScale);
	} else {
		// An explicit choice is followed literally, including on the way up, so the
		// top tiers can supersample regardless of how small the box is.
		scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, input.requestedScale));
	}

	return {
		width: Math.max(1, Math.round(nativeWidth * scale)),
		height: Math.max(1, Math.round(nativeHeight * scale)),
	};
}
