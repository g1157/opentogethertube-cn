// Live-action enhancement tier: clean the source's compression artifacts, then use the same
// multi-tap upscale and contrast-adaptive sharpening the sharpen tier does.
//
// Anime-style CNNs separate the picture into edges and flat areas, which flattens skin
// texture, fabric and film grain before the upscale. Live action needs the opposite
// priorities: remove the blocking, mosquito noise and banding that actually make a stream
// look bad, magnify with a multi-tap filter, and sharpen only lightly so faces do not halo.
//
// Orientation: a render target written by the "clean" pass stores the picture video-style
// (first row at v=0), which is what EASU reads; EASU's own output is framebuffer-style, so
// the final sharpen pass flips only when it reads the clean target instead.
import {
	createRenderTarget,
	EASU_FRAGMENT_SHADER,
	link,
	releaseRenderTarget,
	SHARPEN_FRAGMENT_SHADER,
	type RenderTarget,
} from "./cas";
import { reportEnhancementTarget } from "./status";
import type { UpscaleRenderer } from "./upscale-renderer";

/** The film chain leans gentle: the sharpen slider's value is scaled by this. */
export const FILM_SHARPEN_FACTOR = 0.6;
/** Denoise/deblock weight of the clean pass (edge-preserving, so it can be moderate). */
export const FILM_DENOISE = 0.5;
/** Banding flattening weight; the dither amplitude follows it. */
export const FILM_DEBAND = 0.6;

export type FilmPass = "clean" | "easu" | "cas";

/**
 * The passes the film chain runs for a frame. Kept pure so the ordering rules are testable
 * without a GPU: the clean pass always runs, EASU only when the target magnifies, and the
 * sharpen pass always finishes the chain.
 */
export function planFilmPasses(input: { magnifying: boolean }): FilmPass[] {
	return ["clean", ...(input.magnifying ? (["easu"] as const) : []), "cas"];
}

// Reads the video with plain uv (top-row-first storage) and writes the filtered picture;
// neighborhood taps are symmetric, so only the sample/write mapping depends on this.
const CLEAN_FRAGMENT_SHADER = `#version 300 es
precision highp float;
uniform sampler2D uTexture;
uniform vec2 uTexel;
uniform float uDenoise;
uniform float uDeband;
in vec2 vUv;
out vec4 outColor;

float luma(vec3 c) {
	return c.b * 0.5 + (c.r * 0.5 + c.g);
}

void main() {
	vec2 uv = vUv;
	vec3 c = texture(uTexture, uv).rgb;
	vec3 n = texture(uTexture, uv + vec2(0.0, -uTexel.y)).rgb;
	vec3 s = texture(uTexture, uv + vec2(0.0, uTexel.y)).rgb;
	vec3 w = texture(uTexture, uv + vec2(-uTexel.x, 0.0)).rgb;
	vec3 e = texture(uTexture, uv + vec2(uTexel.x, 0.0)).rgb;

	// Edge-preserving mean: a neighbour only counts when it is close in luminance, which is
	// what takes blocking and mosquito noise down without smearing real texture.
	float lc = luma(c);
	float wn = 1.0 / (0.02 + abs(luma(n) - lc));
	float ws = 1.0 / (0.02 + abs(luma(s) - lc));
	float ww = 1.0 / (0.02 + abs(luma(w) - lc));
	float we = 1.0 / (0.02 + abs(luma(e) - lc));
	vec3 filtered = (c + n * wn + s * ws + w * ww + e * we) / (1.0 + wn + ws + ww + we);

	// Banding lives where the whole neighborhood spans a couple of code values; flatten
	// those towards the filtered mean and leave textured areas alone.
	vec3 mn = min(min(min(n, s), min(w, e)), c);
	vec3 mx = max(max(max(n, s), max(w, e)), c);
	float flat = 1.0 - smoothstep(0.02, 0.10, luma(mx) - luma(mn));

	float weight = clamp(uDenoise + uDeband * flat, 0.0, 1.0);
	vec3 result = mix(c, filtered, weight);

	// Ordered dither at the LSB: without it, quantising to the display's 8 bits would put
	// back a good part of the gradients this pass just smoothed.
	float noise = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453) - 0.5;
	result += noise * uDeband / 255.0;

	outColor = vec4(clamp(result, 0.0, 1.0), 1.0);
}
`;

export interface FilmRendererOptions {
	/** 0..1 sharpening strength from settings; the film chain scales it down. */
	getStrength: () => number;
}

/**
 * Starts the film chain on a WebGL2 canvas. Returns a renderer the layer can stop; every
 * allocation happens here so a failed start leaves nothing behind.
 */
export function startFilmRenderer(
	video: HTMLVideoElement,
	canvas: HTMLCanvasElement,
	options: FilmRendererOptions,
): UpscaleRenderer {
	const gl = canvas.getContext("webgl2", { alpha: false, antialias: false });
	if (!gl) {
		throw new Error("WebGL2 unavailable");
	}
	const cleanProgram = link(gl, CLEAN_FRAGMENT_SHADER);
	const easuProgram = link(gl, EASU_FRAGMENT_SHADER);
	const sharpenProgram = link(gl, SHARPEN_FRAGMENT_SHADER);

	const vao = gl.createVertexArray();
	gl.bindVertexArray(vao);
	const buffer = gl.createBuffer();
	gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
	gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
	gl.enableVertexAttribArray(0);
	gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

	const videoTexture = gl.createTexture();
	gl.bindTexture(gl.TEXTURE_2D, videoTexture);
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
	gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);

	gl.useProgram(cleanProgram);
	gl.uniform1i(gl.getUniformLocation(cleanProgram, "uTexture"), 0);
	const cleanTexel = gl.getUniformLocation(cleanProgram, "uTexel");
	const cleanDenoise = gl.getUniformLocation(cleanProgram, "uDenoise");
	const cleanDeband = gl.getUniformLocation(cleanProgram, "uDeband");

	gl.useProgram(easuProgram);
	gl.uniform1i(gl.getUniformLocation(easuProgram, "uTexture"), 0);
	const easuInSize = gl.getUniformLocation(easuProgram, "uInSize");
	const easuOutSize = gl.getUniformLocation(easuProgram, "uOutSize");

	gl.useProgram(sharpenProgram);
	gl.uniform1i(gl.getUniformLocation(sharpenProgram, "uTexture"), 0);
	const sharpenAmount = gl.getUniformLocation(sharpenProgram, "uAmount");
	const sharpenTexel = gl.getUniformLocation(sharpenProgram, "uTexel");
	const sharpenFlipY = gl.getUniformLocation(sharpenProgram, "uFlipY");

	let cleanTarget: RenderTarget | null = null;
	let upscaleTarget: RenderTarget | null = null;
	let frameRequest = 0;
	let stopped = false;
	let frames = 0;

	const ensureTarget = (
		current: RenderTarget | null,
		width: number,
		height: number,
	): RenderTarget => {
		if (current && current.width === width && current.height === height) {
			return current;
		}
		if (current) {
			releaseRenderTarget(gl, current);
		}
		return createRenderTarget(gl, width, height);
	};

	const frame = () => {
		if (stopped) {
			return;
		}
		if (!video.paused && video.readyState >= video.HAVE_CURRENT_DATA) {
			gl.bindVertexArray(vao);
			gl.activeTexture(gl.TEXTURE0);
			gl.bindTexture(gl.TEXTURE_2D, videoTexture);
			gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video);

			const inputWidth = Math.max(1, video.videoWidth);
			const inputHeight = Math.max(1, video.videoHeight);
			const outputWidth = Math.max(1, canvas.width);
			const outputHeight = Math.max(1, canvas.height);
			const magnifying = outputWidth > inputWidth || outputHeight > inputHeight;

			cleanTarget = ensureTarget(cleanTarget, inputWidth, inputHeight);
			gl.bindFramebuffer(gl.FRAMEBUFFER, cleanTarget.framebuffer);
			gl.viewport(0, 0, inputWidth, inputHeight);
			gl.useProgram(cleanProgram);
			gl.bindTexture(gl.TEXTURE_2D, videoTexture);
			gl.uniform2f(cleanTexel, 1 / inputWidth, 1 / inputHeight);
			gl.uniform1f(cleanDenoise, FILM_DENOISE);
			gl.uniform1f(cleanDeband, FILM_DEBAND);
			gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

			let outputTexture = cleanTarget.texture;
			if (magnifying) {
				upscaleTarget = ensureTarget(upscaleTarget, outputWidth, outputHeight);
				gl.bindFramebuffer(gl.FRAMEBUFFER, upscaleTarget.framebuffer);
				gl.viewport(0, 0, outputWidth, outputHeight);
				gl.useProgram(easuProgram);
				gl.bindTexture(gl.TEXTURE_2D, cleanTarget.texture);
				gl.uniform2f(easuInSize, inputWidth, inputHeight);
				gl.uniform2f(easuOutSize, outputWidth, outputHeight);
				gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
				outputTexture = upscaleTarget.texture;
			}

			gl.bindFramebuffer(gl.FRAMEBUFFER, null);
			gl.viewport(0, 0, outputWidth, outputHeight);
			gl.useProgram(sharpenProgram);
			gl.bindTexture(gl.TEXTURE_2D, outputTexture);
			gl.uniform1f(sharpenAmount, options.getStrength() * FILM_SHARPEN_FACTOR);
			// The EASU target is framebuffer-style (v=0 is the bottom row); the clean target
			// holds the picture video-style (v=0 is the top row), so only that one flips.
			gl.uniform1f(sharpenFlipY, magnifying ? 0 : 1);
			gl.uniform2f(sharpenTexel, 1 / outputWidth, 1 / outputHeight);
			gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

			if (frames === 0) {
				console.info(
					`[video-enhancement] film chain cleaning ${inputWidth}×${inputHeight} into ${outputWidth}×${outputHeight}`,
				);
				reportEnhancementTarget(`film · ${outputWidth}×${outputHeight}`);
			}
			frames++;
		}
		frameRequest = video.requestVideoFrameCallback(frame);
	};
	frameRequest = video.requestVideoFrameCallback(frame);

	return {
		stop() {
			stopped = true;
			video.cancelVideoFrameCallback(frameRequest);
			if (cleanTarget) {
				releaseRenderTarget(gl, cleanTarget);
				cleanTarget = null;
			}
			if (upscaleTarget) {
				releaseRenderTarget(gl, upscaleTarget);
				upscaleTarget = null;
			}
			gl.getExtension("WEBGL_lose_context")?.loseContext();
		},
	};
}
