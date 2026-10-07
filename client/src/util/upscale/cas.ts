// Lightweight WebGL2 video enhancement, used as the tier that works everywhere.
//
// Magnifying runs an edge-adaptive upscale (EASU), then the contrast-adaptive
// sharpening at the output resolution — the EASU -> sharpen order FSR 1
// prescribes. Plain bilinear magnification was what made 720p look soft on a
// 1440p screen, and it costs the same single pass either way.
//
// Minifying (an explicit lower tier, or where the degrade ladder stepped down)
// keeps the single-pass behaviour: the sharper of the two filters is the
// browser's own scaler there, and the goal is only to spend fewer pixels.
//
// EASU is ported from AMD FidelityFX Super Resolution 1.0 (ffx_fsr1.h).
// Copyright (c) 2021 Advanced Micro Devices, Inc. All rights reserved.
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in
// all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
// THE SOFTWARE.

import { reportEnhancementError } from "./status";

export interface UpscaleRenderer {
	stop(): void;
}

// Both fragment programs sample through the same uv. It runs bottom-up in clip
// space (the framebuffer's own order), and each program decides whether its
// input texture stores the picture top row first (the video, which uploads
// unflipped) or bottom row first (the intermediate render target, whose rows the
// framebuffer wrote bottom-up).
export const VERTEX_SHADER = `#version 300 es
layout(location = 0) in vec2 aPos;
out vec2 vUv;
void main() {
	vUv = vec2((aPos.x + 1.0) * 0.5, (aPos.y + 1.0) * 0.5);
	gl_Position = vec4(aPos, 0.0, 1.0);
}
`;

export const SHARPEN_FRAGMENT_SHADER = `#version 300 es
precision highp float;
uniform sampler2D uTexture;
uniform vec2 uTexel;
uniform float uAmount;
// 1.0 when the input is the video texture (first row at v=0), 0.0 for a render
// target the framebuffer filled bottom-up.
uniform float uFlipY;
in vec2 vUv;
out vec4 outColor;
void main() {
	vec2 uv = vec2(vUv.x, mix(vUv.y, 1.0 - vUv.y, uFlipY));
	vec3 c = texture(uTexture, uv).rgb;
	vec3 n = texture(uTexture, uv + vec2(0.0, -uTexel.y)).rgb;
	vec3 s = texture(uTexture, uv + vec2(0.0, uTexel.y)).rgb;
	vec3 w = texture(uTexture, uv + vec2(-uTexel.x, 0.0)).rgb;
	vec3 e = texture(uTexture, uv + vec2(uTexel.x, 0.0)).rgb;
	vec3 blur = (n + s + w + e) * 0.25;
	// Clamp the sharpened result to the local neighborhood so edges never halo.
	vec3 mn = min(min(min(n, s), min(w, e)), c);
	vec3 mx = max(max(max(n, s), max(w, e)), c);
	outColor = vec4(clamp(c + (c - blur) * uAmount, mn, mx), 1.0);
}
`;

export const EASU_FRAGMENT_SHADER = `#version 300 es
precision highp float;
uniform sampler2D uTexture;
uniform vec2 uInSize;
uniform vec2 uOutSize;
in vec2 vUv;
out vec4 outColor;

// Integer coordinates in the input's texel grid, origin at the top-left texel.
vec3 tap(vec2 texel) {
	return texture(uTexture, (texel + 0.5) / uInSize).rgb;
}

float luma(vec3 color) {
	return color.b * 0.5 + (color.r * 0.5 + color.g);
}

// Direction and length for one of the four bilinear corners around 'pp'.
void accumulate(
	inout vec2 dir,
	inout float len,
	float w,
	float lA,
	float lB,
	float lC,
	float lD,
	float lE
) {
	float dc = lD - lC;
	float cb = lC - lB;
	float lenX = 1.0 / max(max(abs(dc), abs(cb)), 1e-5);
	float dirX = lD - lB;
	dir.x += dirX * w;
	float sx = clamp(abs(dirX) * lenX, 0.0, 1.0);
	len += sx * sx * w;

	float ec = lE - lC;
	float ca = lC - lA;
	float lenY = 1.0 / max(max(abs(ec), abs(ca)), 1e-5);
	float dirY = lE - lA;
	dir.y += dirY * w;
	float sy = clamp(abs(dirY) * lenY, 0.0, 1.0);
	len += sy * sy * w;
}

// One tap of the adaptive elliptical filter. 'off' is the tap position relative
// to 'pp', 'dir' the gradient direction and 'len' the anisotropic stretch.
void contribute(
	inout vec3 aC,
	inout float aW,
	vec2 off,
	vec2 dir,
	vec2 len,
	float lob,
	float clp,
	vec3 color
) {
	vec2 v = vec2(off.x * dir.x + off.y * dir.y, off.x * (-dir.y) + off.y * dir.x);
	v *= len;
	// Distance squared, limited to the window: at a corner two taps fall outside.
	float d2 = min(dot(v, v), clp);
	// Approximation of the lanczos(2) kernel without sin(), rcp() or sqrt().
	float wB = (2.0 / 5.0) * d2 - 1.0;
	float wA = lob * d2 - 1.0;
	wB *= wB;
	wA *= wA;
	wB = (25.0 / 16.0) * wB - (25.0 / 16.0 - 1.0);
	float w = wB * wA;
	aC += color * w;
	aW += w;
}

void main() {
	// Output pixel index counted from the top, matching the tap grid below.
	vec2 ip = vec2(vUv.x * uOutSize.x, (1.0 - vUv.y) * uOutSize.y) - 0.5;
	vec2 pp = (ip + 0.5) * uInSize / uOutSize - 0.5;
	vec2 fp = floor(pp);
	pp -= fp;

	// 12-tap kernel, offsets from the texel holding 'f':
	//     b c
	//   e f g h
	//   i j k l
	//     n o
	vec3 b = tap(fp + vec2(0.0, -1.0));
	vec3 c = tap(fp + vec2(1.0, -1.0));
	vec3 e = tap(fp + vec2(-1.0, 0.0));
	vec3 f = tap(fp);
	vec3 g = tap(fp + vec2(1.0, 0.0));
	vec3 h = tap(fp + vec2(2.0, 0.0));
	vec3 i = tap(fp + vec2(-1.0, 1.0));
	vec3 j = tap(fp + vec2(0.0, 1.0));
	vec3 k = tap(fp + vec2(1.0, 1.0));
	vec3 l = tap(fp + vec2(2.0, 1.0));
	vec3 n = tap(fp + vec2(0.0, 2.0));
	vec3 o = tap(fp + vec2(1.0, 2.0));

	float bL = luma(b);
	float cL = luma(c);
	float eL = luma(e);
	float fL = luma(f);
	float gL = luma(g);
	float hL = luma(h);
	float iL = luma(i);
	float jL = luma(j);
	float kL = luma(k);
	float lL = luma(l);
	float nL = luma(n);
	float oL = luma(o);

	vec2 dir = vec2(0.0);
	float len = 0.0;
	accumulate(dir, len, (1.0 - pp.x) * (1.0 - pp.y), bL, eL, fL, gL, jL);
	accumulate(dir, len, pp.x * (1.0 - pp.y), cL, fL, gL, hL, kL);
	accumulate(dir, len, (1.0 - pp.x) * pp.y, fL, iL, jL, kL, nL);
	accumulate(dir, len, pp.x * pp.y, gL, jL, kL, lL, oL);

	float dirR = dot(dir, dir);
	bool zero = dirR < (1.0 / 32768.0);
	dirR = zero ? 1.0 : inversesqrt(dirR);
	dir = zero ? vec2(1.0, 0.0) : dir * dirR;
	len = len * 0.5;
	len *= len;
	// Stretch the kernel {1.0 vert|horz, to sqrt(2.0) on diagonal}.
	float stretch = dot(dir, dir) / max(max(abs(dir.x), abs(dir.y)), 1e-5);
	vec2 len2 = vec2(1.0 + (stretch - 1.0) * len, 1.0 - 0.5 * len);
	// The window shifts from +/- sqrt(2.0) to slightly beyond 2.0 as edges appear.
	float lob = 0.5 + ((1.0 / 4.0 - 0.04) - 0.5) * len;
	float clp = 1.0 / lob;

	vec3 min4 = min(min(f, g), min(j, k));
	vec3 max4 = max(max(f, g), max(j, k));

	vec3 aC = vec3(0.0);
	float aW = 0.0;
	contribute(aC, aW, vec2(0.0, -1.0) - pp, dir, len2, lob, clp, b);
	contribute(aC, aW, vec2(1.0, -1.0) - pp, dir, len2, lob, clp, c);
	contribute(aC, aW, vec2(-1.0, 1.0) - pp, dir, len2, lob, clp, i);
	contribute(aC, aW, vec2(0.0, 1.0) - pp, dir, len2, lob, clp, j);
	contribute(aC, aW, vec2(0.0, 0.0) - pp, dir, len2, lob, clp, f);
	contribute(aC, aW, vec2(-1.0, 0.0) - pp, dir, len2, lob, clp, e);
	contribute(aC, aW, vec2(1.0, 1.0) - pp, dir, len2, lob, clp, k);
	contribute(aC, aW, vec2(2.0, 1.0) - pp, dir, len2, lob, clp, l);
	contribute(aC, aW, vec2(2.0, 0.0) - pp, dir, len2, lob, clp, h);
	contribute(aC, aW, vec2(1.0, 0.0) - pp, dir, len2, lob, clp, g);
	contribute(aC, aW, vec2(1.0, 2.0) - pp, dir, len2, lob, clp, o);
	contribute(aC, aW, vec2(0.0, 2.0) - pp, dir, len2, lob, clp, n);

	// Normalize, then clamp to the four nearest texels so the negative lobes
	// introduce no ringing.
	outColor = vec4(min(max4, max(min4, aC / aW)), 1.0);
}
`;

function compile(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
	const shader = gl.createShader(type);
	if (!shader) {
		throw new Error("Unable to create shader");
	}
	gl.shaderSource(shader, source);
	gl.compileShader(shader);
	if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
		throw new Error(`Shader compile failed: ${gl.getShaderInfoLog(shader) ?? "unknown"}`);
	}
	return shader;
}

/**
 * Linked programs, cached per context. The layer rebuilds on a tier switch, a scale step and
 * entering fullscreen, and it keeps the canvas (and therefore the context) across those
 * rebuilds — so linking the same chain again would be pure waste. Linking is also the most
 * visible part of a rebuild: the heavy chain is 55 programs.
 *
 * The context is held by identity, so the entries go away with it. A context loss clears them:
 * every program linked on it is dead, and a restored context must compile its own.
 */
const programCache = new WeakMap<WebGL2RenderingContext, Map<string, WebGLProgram>>();

function programsOf(gl: WebGL2RenderingContext): Map<string, WebGLProgram> {
	let cached = programCache.get(gl);
	if (!cached) {
		const programs = new Map<string, WebGLProgram>();
		programCache.set(gl, programs);
		gl.canvas?.addEventListener("webglcontextlost", () => programs.clear());
		cached = programs;
	}
	return cached;
}

export function link(gl: WebGL2RenderingContext, fragmentSource: string): WebGLProgram {
	const programs = programsOf(gl);
	const cached = programs.get(fragmentSource);
	if (cached) {
		return cached;
	}
	const program = gl.createProgram();
	if (!program) {
		throw new Error("Unable to create program");
	}
	gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, VERTEX_SHADER));
	gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, fragmentSource));
	gl.linkProgram(program);
	if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
		throw new Error(`Program link failed: ${gl.getProgramInfoLog(program) ?? "unknown"}`);
	}
	programs.set(fragmentSource, program);
	return program;
}

export interface RenderTarget {
	texture: WebGLTexture;
	framebuffer: WebGLFramebuffer;
	width: number;
	height: number;
	/** True when the target holds more than 8 bits per channel. */
	halfFloat: boolean;
}

/**
 * A framebuffer to render one pass into. Half float keeps the precision a deband pass needs;
 * platforms that cannot attach one (or drivers that refuse the attachment) fall back to the
 * 8-bit target every tier used before.
 */
export function createRenderTarget(
	gl: WebGL2RenderingContext,
	width: number,
	height: number,
): RenderTarget {
	// In WebGL2 the 16-bit float formats become color-renderable through EXT_color_buffer_float;
	// the half-float extension is the older WebGL1 spelling that Chromium answers as well.
	// Firefox only implements the float one, so asking for the half-float name alone dropped
	// every intermediate in the clean and sharpen chains to 8 bits there for no reason.
	const halfFloat =
		gl.getExtension("EXT_color_buffer_float") !== null ||
		gl.getExtension("EXT_color_buffer_half_float") !== null;
	const target =
		allocateRenderTarget(gl, width, height, halfFloat) ??
		(halfFloat ? allocateRenderTarget(gl, width, height, false) : null);
	if (!target) {
		throw new Error("Unable to allocate the enhancement render target");
	}
	return target;
}

function allocateRenderTarget(
	gl: WebGL2RenderingContext,
	width: number,
	height: number,
	halfFloat: boolean,
): RenderTarget | null {
	const texture = gl.createTexture();
	const framebuffer = gl.createFramebuffer();
	if (!texture || !framebuffer) {
		return null;
	}
	gl.bindTexture(gl.TEXTURE_2D, texture);
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
	if (halfFloat) {
		gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, width, height, 0, gl.RGBA, gl.HALF_FLOAT, null);
	} else {
		gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
	}
	gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
	gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
	const complete = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
	gl.bindFramebuffer(gl.FRAMEBUFFER, null);
	if (!complete) {
		gl.deleteFramebuffer(framebuffer);
		gl.deleteTexture(texture);
		return null;
	}
	return { texture, framebuffer, width, height, halfFloat };
}

export function releaseRenderTarget(gl: WebGL2RenderingContext, target: RenderTarget): void {
	gl.deleteFramebuffer(target.framebuffer);
	gl.deleteTexture(target.texture);
}

/**
 * A size-keyed pool of render targets.
 *
 * The Anime4K planner frees a buffer as soon as nothing samples it any more, and rebuilding those
 * on the next frame costs several 4K half-float textures at 2x — hundreds of megabytes. Measured
 * on the same machine: 18.8 fps rebuilding against 110.7 fps reusing them under Chrome's ANGLE,
 * 33.2 against 101.3 under Firefox's. Handing a buffer back here instead of deleting it keeps the
 * live set small and the per-frame allocations at zero.
 */
export interface RenderTargetPool {
	take(width: number, height: number): RenderTarget;
	give(target: RenderTarget): void;
	/**
	 * How many targets each size may keep between frames.
	 *
	 * The chain's plan says exactly how many targets of a size it can have live at once, so
	 * anything past that is surplus and is released on the spot; a size the new plan never uses is
	 * dropped whole. Sizes without a limit are kept, which is only the state before the first plan.
	 */
	setLimits(limits: Map<string, number>): void;
	dispose(): void;
}

const bucketKey = (width: number, height: number) => `${width}x${height}`;

export function createRenderTargetPool(gl: WebGL2RenderingContext): RenderTargetPool {
	const free = new Map<string, RenderTarget[]>();
	let limits: Map<string, number> | undefined;
	return {
		take(width, height) {
			return (
				free.get(bucketKey(width, height))?.pop() ?? createRenderTarget(gl, width, height)
			);
		},
		give(target) {
			const bucket = bucketKey(target.width, target.height);
			const list = free.get(bucket);
			const limit = limits?.get(bucket);
			if (limit !== undefined && (list?.length ?? 0) >= limit) {
				releaseRenderTarget(gl, target);
				return;
			}
			if (list) {
				list.push(target);
			} else {
				free.set(bucket, [target]);
			}
		},
		setLimits(next) {
			limits = next;
			for (const [bucket, list] of free) {
				const limit = next.get(bucket);
				if (limit === undefined) {
					for (const target of list) {
						releaseRenderTarget(gl, target);
					}
					free.delete(bucket);
					continue;
				}
				while (list.length > limit) {
					releaseRenderTarget(gl, list.pop() as RenderTarget);
				}
			}
		},
		dispose() {
			for (const list of free.values()) {
				for (const target of list) {
					releaseRenderTarget(gl, target);
				}
			}
			free.clear();
		},
	};
}

export function startSharpenRenderer(
	video: HTMLVideoElement,
	canvas: HTMLCanvasElement,
	getAmount: () => number,
): UpscaleRenderer {
	const gl = canvas.getContext("webgl2", {
		alpha: false,
		antialias: false,
		// A paused video presents no new frames and this tier only draws on presented frames,
		// so the buffer has to survive being composited on its own; otherwise a re-composite
		// (a resize, a tab switch) can leave the canvas empty, and an empty canvas shows the
		// raw video through it in Firefox.
		preserveDrawingBuffer: true,
	});
	if (!gl) {
		throw new Error("WebGL2 unavailable");
	}
	const sharpenProgram = link(gl, SHARPEN_FRAGMENT_SHADER);
	const easuProgram = link(gl, EASU_FRAGMENT_SHADER);

	// Both programs declare aPos at location 0, so one vertex array serves both.
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

	gl.useProgram(sharpenProgram);
	gl.uniform1i(gl.getUniformLocation(sharpenProgram, "uTexture"), 0);
	gl.useProgram(easuProgram);
	gl.uniform1i(gl.getUniformLocation(easuProgram, "uTexture"), 0);

	const sharpenAmount = gl.getUniformLocation(sharpenProgram, "uAmount");
	const sharpenTexel = gl.getUniformLocation(sharpenProgram, "uTexel");
	const sharpenFlipY = gl.getUniformLocation(sharpenProgram, "uFlipY");
	const easuInSize = gl.getUniformLocation(easuProgram, "uInSize");
	const easuOutSize = gl.getUniformLocation(easuProgram, "uOutSize");

	let stage: RenderTarget | null = null;
	let frameRequest = 0;
	let stopped = false;
	/** Media time of the frame the last loop callback drew; a repeated presentation of the
	 * same frame (a rate-change re-time, a redraw after a seek) is skipped, not drawn twice. */
	let lastFrameMediaTime = Number.NaN;
	let drawFailures = 0;

	const ensureStage = (width: number, height: number): RenderTarget => {
		if (stage && stage.width === width && stage.height === height) {
			return stage;
		}
		if (stage) {
			releaseRenderTarget(gl, stage);
		}
		stage = createRenderTarget(gl, width, height);
		return stage;
	};

	/**
	 * Draws the frame the video currently holds. requestVideoFrameCallback is what normally
	 * drives the loop, and it only fires for newly presented frames: while the video is paused
	 * nothing would ever be drawn, so starting or rebuilding the tier while paused used to
	 * leave a canvas nobody had drawn into — which shows the raw video underneath instead of
	 * the enhanced picture. start(), pause and seeked therefore draw explicitly.
	 */
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
		const magnifying = outputWidth > inputWidth || outputHeight > inputHeight;

		if (magnifying) {
			// EASU in the source resolution's terms, then sharpen the upscaled
			// picture so the strength slider acts at the displayed scale.
			const target = ensureStage(outputWidth, outputHeight);
			gl.bindFramebuffer(gl.FRAMEBUFFER, target.framebuffer);
			gl.viewport(0, 0, outputWidth, outputHeight);
			gl.useProgram(easuProgram);
			// ensureStage leaves the stage texture bound; the EASU pass reads the video.
			gl.bindTexture(gl.TEXTURE_2D, videoTexture);
			gl.uniform2f(easuInSize, inputWidth, inputHeight);
			gl.uniform2f(easuOutSize, outputWidth, outputHeight);
			gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

			gl.bindFramebuffer(gl.FRAMEBUFFER, null);
			gl.useProgram(sharpenProgram);
			gl.bindTexture(gl.TEXTURE_2D, target.texture);
			gl.uniform1f(sharpenAmount, getAmount());
			gl.uniform1f(sharpenFlipY, 0);
			gl.uniform2f(sharpenTexel, 1 / outputWidth, 1 / outputHeight);
			gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
		} else {
			gl.bindFramebuffer(gl.FRAMEBUFFER, null);
			gl.viewport(0, 0, outputWidth, outputHeight);
			gl.useProgram(sharpenProgram);
			gl.uniform1f(sharpenAmount, getAmount());
			gl.uniform1f(sharpenFlipY, 1);
			// Minifying: the neighborhood is measured in source texels, so the
			// sharpening stays a property of the source detail.
			gl.uniform2f(sharpenTexel, 1 / inputWidth, 1 / inputHeight);
			gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
		}
	};

	const frame = (_now: number, metadata: VideoFrameCallbackMetadata) => {
		if (stopped) {
			return;
		}
		try {
			const mediaTime = metadata?.mediaTime;
			if (mediaTime === undefined || !(Math.abs(mediaTime - lastFrameMediaTime) < 1e-4)) {
				lastFrameMediaTime = mediaTime ?? Number.NaN;
				drawFrame();
			}
			drawFailures = 0;
		} catch (error) {
			// A draw that throws used to end the loop silently, freezing the canvas under a
			// tier that still looked enabled. Three failures in a row stand the renderer down
			// and surface the reason in the playback details panel.
			drawFailures++;
			if (drawFailures >= 3) {
				stopped = true;
				reportEnhancementError(error instanceof Error ? error.message : String(error));
				return;
			}
		}
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
			if (stage) {
				releaseRenderTarget(gl, stage);
				stage = null;
			}
			// The context outlives this renderer (the layer keeps the canvas so a rebuild can
			// reuse its context and linked programs), so what this instance allocated has to be
			// deleted rather than left to a context loss.
			gl.deleteVertexArray(vao);
			gl.deleteBuffer(buffer);
			gl.deleteTexture(videoTexture);
		},
	};
}
