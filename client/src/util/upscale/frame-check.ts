// Does what the enhancement drew actually look like the video?
//
// A browser can hand out a WebGPU device, pass a capability probe, and still draw the wrong
// picture — a blurry, vertically misplaced layer is what the Anime4K pipelines looked like on
// Firefox's WebGPU implementation, with no error anywhere to catch. The only honest check is the
// output: sample both frames down, and require that the enhanced one tracks the video and is not
// softer than it. Anything below these thresholds means the tier is drawing nonsense.

/** How closely the rendered frame has to track the video, pixel for pixel. */
export const MIN_CORRELATION = 0.85;
/** How sharp the rendered frame has to be, relative to the video (1.0 = no loss). */
export const MIN_SHARPNESS = 0.9;
/** The sampling grid both frames are reduced to before comparing. */
export const SAMPLE_WIDTH = 160;
export const SAMPLE_HEIGHT = 90;

/** A frame reduced to luma on a small grid, which is all the comparison needs. */
export function sampleLuma(
	source: HTMLVideoElement | HTMLCanvasElement,
	width = SAMPLE_WIDTH,
	height = SAMPLE_HEIGHT,
): Float32Array | null {
	const probe = document.createElement("canvas");
	probe.width = width;
	probe.height = height;
	const context = probe.getContext("2d");
	if (!context) {
		return null;
	}
	context.drawImage(source, 0, 0, width, height);
	const { data } = context.getImageData(0, 0, width, height);
	const luma = new Float32Array(width * height);
	for (let i = 0; i < luma.length; i++) {
		const at = i * 4;
		luma[i] = 0.299 * data[at] + 0.587 * data[at + 1] + 0.114 * data[at + 2];
	}
	return luma;
}

/** Mean absolute difference between neighbouring samples: the sharpness metric used elsewhere. */
function sharpness(frame: Float32Array, width: number): number {
	let sum = 0;
	let count = 0;
	for (let position = 0; position + width < frame.length; position++) {
		sum += Math.abs(frame[position] - frame[position + 1]);
		sum += Math.abs(frame[position] - frame[position + width]);
		count += 2;
	}
	return count === 0 ? 0 : sum / count;
}

export interface FrameComparison {
	correlation: number;
	sharpness: number;
	ok: boolean;
}

/**
 * Compares the video's frame with what the enhancement drew. They are the same content at the same
 * size, so a picture that is offset, flipped or blurred shows up as a low correlation or a low
 * sharpness ratio immediately.
 */
export function compareFrames(
	video: Float32Array,
	rendered: Float32Array,
	width = SAMPLE_WIDTH,
): FrameComparison {
	let videoMean = 0;
	let renderedMean = 0;
	for (let i = 0; i < video.length; i++) {
		videoMean += video[i];
		renderedMean += rendered[i];
	}
	videoMean /= video.length;
	renderedMean /= rendered.length;
	let covariance = 0;
	let videoVariance = 0;
	let renderedVariance = 0;
	for (let i = 0; i < video.length; i++) {
		const a = video[i] - videoMean;
		const b = rendered[i] - renderedMean;
		covariance += a * b;
		videoVariance += a * a;
		renderedVariance += b * b;
	}
	const correlation =
		videoVariance === 0 || renderedVariance === 0
			? 0
			: covariance / Math.sqrt(videoVariance * renderedVariance);
	const videoSharpness = sharpness(video, width);
	const renderedSharpness = sharpness(rendered, width);
	const relative = videoSharpness === 0 ? 0 : renderedSharpness / videoSharpness;
	return {
		correlation,
		sharpness: relative,
		ok: correlation >= MIN_CORRELATION && relative >= MIN_SHARPNESS,
	};
}

/** Samples both frames and compares them, or null when a frame cannot be read yet. */
export function enhancedFrameLooksLikeVideo(
	video: HTMLVideoElement,
	canvas: HTMLCanvasElement,
): FrameComparison | null {
	if (video.readyState < video.HAVE_CURRENT_DATA || canvas.width === 0 || canvas.height === 0) {
		return null;
	}
	const videoLuma = sampleLuma(video);
	const renderedLuma = sampleLuma(canvas);
	if (!videoLuma || !renderedLuma) {
		return null;
	}
	return compareFrames(videoLuma, renderedLuma);
}
