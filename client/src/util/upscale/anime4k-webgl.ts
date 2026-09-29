// Anime4K on WebGL2: the official CNN chains, run as WebGL2 fragment shaders, for every browser
// without a usable WebGPU — Firefox outside Windows and Nightly, Safari before 26, and machines
// whose driver the WebGPU blocklist rejects.
//
// The shaders are generated from the official Anime4K v4.0.1 GLSL (see anime4k-glsl.ts and the
// converter it names). A chain is a list of segments; each segment reads the previous segment's
// output, and inside a segment the passes alternate between two buffers. That is how mpv arranges
// the same shaders, and it keeps a 52-pass chain at a handful of live render targets instead of
// one per pass.
import { ANIME4K_PASSES, ANIME4K_SEGMENTS, type Anime4KPassSpec } from "./anime4k-glsl";
import { createRenderTarget, link, releaseRenderTarget, SHARPEN_FRAGMENT_SHADER } from "./cas";
import { reportEnhancementTarget } from "./status";
import type { UpscaleRenderer } from "./upscale-renderer";

export type { Anime4KPassSpec };

export interface Anime4KChain {
	/** "S", "HQ", … — used in the console line and the playback details panel. */
	label: string;
	segments: Anime4KPassSpec[][];
}

/** The S variant: mpv's "fast" tier, small enough to ship as the everyday WebGL2 chain. */
export const ANIME4K_S_CHAIN: Anime4KChain = {
	label: "S",
	segments: ANIME4K_SEGMENTS.map(range => range.map(index => ANIME4K_PASSES[index])),
};

/**
 * Anime4K's own rule: the x2 upscale stages only run when the target is more than 1.2x the
 * source (its shaders carry the same condition as `//!WHEN`). Below that the restoration alone
 * is the point, and a depth-to-space pass would resample for nothing.
 */
export const ANIME4K_UPSCALE_THRESHOLD = 1.2;

/** The passes a frame runs: every segment, minus the upscale stages when the target is small. */
export function planChainPasses(
	chain: Anime4KChain,
	input: { magnifying: boolean },
): Anime4KPassSpec[] {
	const passes = chain.segments.flat();
	return input.magnifying ? passes : passes.filter(pass => !pass.upscaleOnly);
}

/**
 * Which buffer of a segment each pass writes. Passes alternate between the two plain buffers; a
 * pass that reads and writes the same name (Clamp_Highlights' statistics) gets one of its own,
 * because a texture cannot be sampled and rendered into at the same time.
 */
export function planSegmentBuffers(segment: Anime4KPassSpec[]): number[] {
	const extra = new Map<string, number>();
	let next = 2;
	return segment.map((pass, index) => {
		if (!pass.pingPong) {
			return index % 2;
		}
		if (!extra.has(pass.name)) {
			extra.set(pass.name, next++);
		}
		return extra.get(pass.name) as number;
	});
}

/** Every shader in the chain, so the guard test can scan them like the hand-written ones. */
export const ANIME4K_WEBGL_SHADERS: string[] = ANIME4K_PASSES.map(pass => pass.fragment);

/** The passes the S chain runs for a frame, for tests and the playback details panel. */
export function planAnime4KWebGLPasses(input: { magnifying: boolean }): string[] {
	return planChainPasses(ANIME4K_S_CHAIN, input).map(pass => pass.desc);
}

/**
 * Runs a chain over the video frame and presents the result. Every allocation happens here, so a
 * failed start leaves nothing behind.
 */
export function startAnime4KWebGLRenderer(
	video: HTMLVideoElement,
	canvas: HTMLCanvasElement,
	chain: Anime4KChain = ANIME4K_S_CHAIN,
): UpscaleRenderer {
	const gl = canvas.getContext("webgl2", {
		alpha: false,
		antialias: false,
		preserveDrawingBuffer: true,
	});
	if (!gl) {
		throw new Error("WebGL2 unavailable");
	}
	const programs = chain.segments.flat().map(pass => link(gl, pass.fragment));
	const present = link(gl, SHARPEN_FRAGMENT_SHADER);

	const vao = gl.createVertexArray();
	gl.bindVertexArray(vao);
	const buffer = gl.createBuffer();
	gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
	gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
	gl.enableVertexAttribArray(0);
	gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

	const videoTexture = gl.createTexture();
	if (!videoTexture) {
		throw new Error("Unable to create the enhancement texture");
	}
	gl.bindTexture(gl.TEXTURE_2D, videoTexture);
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
	gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);

	const lookups = programs.map(program => ({
		texture: gl.getUniformLocation(program, "uTexture"),
		base: gl.getUniformLocation(program, "uBase"),
		texel: gl.getUniformLocation(program, "uTexel"),
		size: gl.getUniformLocation(program, "uSize"),
	}));
	const presentTexture = gl.getUniformLocation(present, "uTexture");
	const presentAmount = gl.getUniformLocation(present, "uAmount");
	const presentTexel = gl.getUniformLocation(present, "uTexel");
	const presentFlip = gl.getUniformLocation(present, "uFlipY");

	// Two buffers per segment plus one per named read-and-write texture inside it; the previous
	// segment's output stays live while the next one runs.
	const buffers = new Map<number, ReturnType<typeof createRenderTarget>>();

	let frameRequest = 0;
	let stopped = false;
	let frames = 0;
	let passCount = 0;

	const target = (slot: number, width: number, height: number) => {
		const current = buffers.get(slot);
		if (current && current.width === width && current.height === height) {
			return current;
		}
		if (current) {
			releaseRenderTarget(gl, current);
		}
		const created = createRenderTarget(gl, width, height);
		buffers.set(slot, created);
		return created;
	};

	const drawFrame = () => {
		if (stopped || video.readyState < video.HAVE_CURRENT_DATA) {
			return;
		}
		gl.bindVertexArray(vao);
		gl.activeTexture(gl.TEXTURE0);
		gl.bindTexture(gl.TEXTURE_2D, videoTexture);
		gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video);

		const inputWidth = Math.max(1, video.videoWidth);
		const inputHeight = Math.max(1, video.videoHeight);
		const outputWidth = Math.max(1, canvas.width);
		const outputHeight = Math.max(1, canvas.height);
		const magnifying =
			outputWidth > ANIME4K_UPSCALE_THRESHOLD * inputWidth &&
			outputHeight > ANIME4K_UPSCALE_THRESHOLD * inputHeight;

		// The video texture is stored flipped, render targets are not; a segment's "input" is
		// whatever the previous segment produced, which is also what its MAIN means.
		let sceneTexture: WebGLTexture = videoTexture;
		let sceneWidth = inputWidth;
		let sceneHeight = inputHeight;
		let programIndex = 0;
		passCount = 0;

		chain.segments.forEach(segment => {
			const slots = planSegmentBuffers(segment);
			const segmentTexture = sceneTexture;
			const namedHere = new Map<string, WebGLTexture>([["input", segmentTexture]]);
			let previous = segmentTexture;
			let previousWidth = sceneWidth;
			let previousHeight = sceneHeight;

			segment.forEach((pass, index) => {
				if (pass.upscaleOnly && !magnifying) {
					// Anime4K itself would not run this pass below 1.2x; skip the program but keep
					// the program index in step.
					programIndex++;
					return;
				}
				const scaled = pass.scale === 2;
				const width = scaled ? previousWidth * 2 : previousWidth;
				const height = scaled ? previousHeight * 2 : previousHeight;
				const out = target(slots[index], width, height);
				const program = programs[programIndex];
				const where = lookups[programIndex];
				programIndex++;

				gl.bindFramebuffer(gl.FRAMEBUFFER, out.framebuffer);
				gl.viewport(0, 0, width, height);
				gl.useProgram(program);
				gl.activeTexture(gl.TEXTURE0);
				gl.bindTexture(gl.TEXTURE_2D, previous);
				gl.uniform1i(where.texture, 0);
				if (where.base) {
					gl.activeTexture(gl.TEXTURE1);
					gl.bindTexture(
						gl.TEXTURE_2D,
						(pass.baseName === "input"
							? segmentTexture
							: namedHere.get(pass.baseName)) ?? segmentTexture,
					);
					gl.uniform1i(where.base, 1);
				}
				gl.uniform2f(where.texel, 1 / previousWidth, 1 / previousHeight);
				gl.uniform2f(where.size, previousWidth, previousHeight);
				gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
				passCount++;

				namedHere.set(pass.name, out.texture);
				previous = out.texture;
				previousWidth = width;
				previousHeight = height;
			});

			if (magnifying || segment.every(pass => !pass.upscaleOnly)) {
				sceneTexture = previous;
				sceneWidth = previousWidth;
				sceneHeight = previousHeight;
			}
		});

		gl.bindFramebuffer(gl.FRAMEBUFFER, null);
		gl.viewport(0, 0, outputWidth, outputHeight);
		gl.useProgram(present);
		gl.activeTexture(gl.TEXTURE0);
		gl.bindTexture(gl.TEXTURE_2D, sceneTexture);
		gl.uniform1i(presentTexture, 0);
		gl.uniform1f(presentAmount, 0);
		// The chain stores its pictures the way the sharpen tier's render targets are stored.
		gl.uniform1f(presentFlip, 0);
		gl.uniform2f(presentTexel, 1 / sceneWidth, 1 / sceneHeight);
		gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

		if (frames === 0) {
			console.info(
				`[video-enhancement] Anime4K ${chain.label} (WebGL2) drawing ${outputWidth}×${outputHeight} from ${inputWidth}×${inputHeight}, ${passCount} passes`,
			);
			reportEnhancementTarget(`Anime4K ${chain.label} · ${outputWidth}×${outputHeight}`);
		}
		frames++;
	};

	const frame = () => {
		if (stopped) {
			return;
		}
		drawFrame();
		frameRequest = video.requestVideoFrameCallback(frame);
	};
	// A paused video presents no frames, so nothing would redraw the picture the viewer is
	// looking at — including the case of a tier that started while the video was paused.
	video.addEventListener("pause", drawFrame);
	video.addEventListener("seeked", drawFrame);
	drawFrame();
	frameRequest = video.requestVideoFrameCallback(frame);

	return {
		stop() {
			stopped = true;
			video.cancelVideoFrameCallback(frameRequest);
			video.removeEventListener("pause", drawFrame);
			video.removeEventListener("seeked", drawFrame);
			for (const current of buffers.values()) {
				releaseRenderTarget(gl, current);
			}
			buffers.clear();
			gl.getExtension("WEBGL_lose_context")?.loseContext();
		},
	};
}
