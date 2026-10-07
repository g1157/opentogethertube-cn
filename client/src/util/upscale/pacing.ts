/**
 * Judges whether the enhancement is keeping up with the picture.
 *
 * The degrade ladder used to watch only how many frames the browser presented, and only
 * gave up below an absolute 18 fps; a renderer dropping one frame in twenty — visible
 * judder on 24 fps content — left that number looking healthy. This module reads the
 * presented media times instead: their median step is the source's nominal frame interval,
 * so the media clock says how many frames should have arrived over a measuring window, and
 * the shortfall says how many never did. The ladder steps down until the machine keeps up.
 *
 * The caller owns the window: it feeds distinct presentations only (a frame the browser
 * presents twice carries the same `mediaTime` and is not another frame to keep up with),
 * discards windows that start with a rebuild, and resets on a stall.
 */

export interface PacingWindow {
	/** Distinct frames presented in the window. */
	frameCount: number;
	elapsedMs: number;
	/** Media times (`metadata.mediaTime`) of those frames, in presentation order. */
	mediaTimes: number[];
	/** Frames the media pipeline dropped rather than displayed in this window. */
	droppedFrames?: number;
	/** Frames it produced in this window (presented plus dropped), when reported. */
	totalFrames?: number;
}

export interface PacingVerdict {
	/** Whether the window carried enough frames to say anything at all. */
	judged: boolean;
	/** Frames per wall-clock second over the window. */
	fps: number;
	/** Frames the media clock implies over the window; null when the cadence is unknowable. */
	expectedFrames: number | null;
	/** Share of the expected frames that never arrived; 0 when not estimable. */
	shortfall: number;
	degrade: boolean;
}

/**
 * Fewer frames than this in a window is not enough data for a verdict: the cadence
 * estimate needs a handful of steps, and a real stall (a pause, a background tab) is
 * reset by the caller before it is counted. Six frames over six seconds already say the
 * renderer is crawling — waiting for twenty-four would never judge a 1-2 fps tier.
 */
export const PACING_MIN_FRAMES = 6;
/** A presentation rate under this is struggling regardless of cadence. */
export const PACING_FLOOR_FPS = 18;
/** Dropping this share of the media clock's frames is visible judder; step down. */
export const PACING_SHORTFALL = 0.05;
/** The share of the pipeline's own dropped frames that counts as stutter. */
export const PACING_DROPPED = 0.08;

/**
 * Median step between consecutive media times, in seconds. A dropped frame doubles one
 * step, which the median ignores; duplicates (step 0) are filtered out first. Null when
 * no positive step exists (a single frame, or a stream whose clock never advances).
 */
export function medianFrameInterval(mediaTimes: number[]): number | null {
	const steps: number[] = [];
	for (let index = 1; index < mediaTimes.length; index++) {
		const step = mediaTimes[index] - mediaTimes[index - 1];
		if (Number.isFinite(step) && step > 0) {
			steps.push(step);
		}
	}
	if (steps.length === 0) {
		return null;
	}
	steps.sort((a, b) => a - b);
	const middle = steps.length >> 1;
	return steps.length % 2 === 1 ? steps[middle] : (steps[middle - 1] + steps[middle]) / 2;
}

export function pacingVerdict(window: PacingWindow): PacingVerdict {
	const elapsedMs = Math.max(1, window.elapsedMs);
	const fps = (window.frameCount / elapsedMs) * 1000;
	if (window.frameCount < PACING_MIN_FRAMES) {
		return { judged: false, fps, expectedFrames: null, shortfall: 0, degrade: false };
	}
	const mediaTimes = window.mediaTimes;
	const interval = medianFrameInterval(mediaTimes);
	const span = (mediaTimes[mediaTimes.length - 1] ?? 0) - (mediaTimes[0] ?? 0);
	// The first frame has no step in front of it, hence the +1.
	const expectedFrames =
		interval !== null && interval > 0 && span > 0 ? span / interval + 1 : null;
	const shortfall =
		expectedFrames !== null ? Math.max(0, 1 - window.frameCount / expectedFrames) : 0;
	// Two ways to fall behind: the media clock outruns the presentations (irregular drops —
	// the median step stays at the source cadence while the count does not), or the whole
	// presentation rate sits under the floor (a consistently overloaded renderer degrades
	// into a regular, self-consistent-looking cadence). The former catches the 24 fps
	// source presenting at 21–23 fps — judder the absolute floor alone never saw.
	// The pipeline's own drop counter is the third: an evenly thinned presentation (every
	// fourth frame dropped, say) looks cadence-consistent, but the browser still reports
	// those frames as dropped rather than displayed.
	const droppedRatio =
		window.totalFrames !== undefined && window.totalFrames > 0
			? Math.max(0, window.droppedFrames ?? 0) / window.totalFrames
			: 0;
	const degrade =
		fps < PACING_FLOOR_FPS || shortfall > PACING_SHORTFALL || droppedRatio > PACING_DROPPED;
	return { judged: true, fps, expectedFrames, shortfall, degrade };
}
