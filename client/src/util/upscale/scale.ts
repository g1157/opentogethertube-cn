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
 * Minimum target the CNN tiers aim for when the device can afford it. Anime4K's
 * presets only run their upscale stages when the target is clearly larger than the
 * source (the library checks for >1.2x), and its design point is a 2x upscale that the
 * display then downsamples. Sizing the canvas to the display box left those stages
 * switched off — only the restore passes ran — which is what made the top tier look
 * softer than a desktop player running the same shader chain.
 */
export const CNN_UPSCALE_SCALE = 2;

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
	/** Let "auto" supersample so the CNN's upscale stages run (see CNN_UPSCALE_SCALE). */
	cnnUpscale?: boolean;
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
		if (input.cnnUpscale) {
			// The display box is the floor, not the target: the CNN only upscales above
			// 1.2x, so aiming at the box silently reduced the top tier to its restore passes.
			scale = Math.max(scale, CNN_UPSCALE_SCALE);
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
