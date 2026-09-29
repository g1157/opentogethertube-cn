// Anime4K on WebGL2: the same CNN restoration and x2 upscale the "AI upscale" tiers use on
// WebGPU, for every browser that has no usable WebGPU — Firefox outside Windows and Nightly,
// Safari before 26, and machines whose driver the WebGPU blocklist rejects.
//
// The shaders are generated from the official Anime4K v4.0.1 GLSL (see anime4k-glsl.ts and the
// converter it names); this file is only the driver: it compiles the pass chain, runs it over
// the video frame, and presents the result. The chain is the official S (small) variant, which
// is mpv's "fast" tier — Restore_CNN_S at the source resolution, then Upscale_CNN_x2_S, whose
// depth-to-space pass carries the x2 upscale.
import {
	ANIME4K_RESTORE_PASSES,
	ANIME4K_UPSCALE_PASSES,
	type Anime4KPassSpec,
} from "./anime4k-glsl";
import { createRenderTarget, link, releaseRenderTarget, SHARPEN_FRAGMENT_SHADER } from "./cas";
import { reportEnhancementTarget } from "./status";
import type { UpscaleRenderer } from "./upscale-renderer";

/**
 * Anime4K's own rule: the x2 upscale chain only runs when the target is more than 1.2x the
 * source (its shaders carry the same condition as `//!WHEN`). Below that the restoration alone
 * is the point, and its depth-to-space pass would resample for nothing.
 */
export const ANIME4K_UPSCALE_THRESHOLD = 1.2;

const PASSES: Anime4KPassSpec[] = [...ANIME4K_RESTORE_PASSES, ...ANIME4K_UPSCALE_PASSES];

/** Every pass the chain runs for a frame, for tests and for the playback details panel. */
export function planAnime4KWebGLPasses(input: { magnifying: boolean }): string[] {
	const chain = input.magnifying ? PASSES : ANIME4K_RESTORE_PASSES;
	return chain.map(pass => pass.desc);
}

/** The generated sources, so the shader guard test can scan them like the hand-written ones. */
export const ANIME4K_WEBGL_SHADERS: string[] = PASSES.map(pass => pass.fragment);

/** One render target per live intermediate. The two chains are laid out so they can share. */
const RESTORE_SLOTS = [0, 1, 2, 4];
const UPSCALE_SLOTS = [0, 1, 2, 3, 5];

/**
 * Runs the Anime4K S chain: video -> restore -> x2 upscale -> present. Every allocation happens
 * here so a failed start leaves nothing behind.
 */
export function startAnime4KWebGLRenderer(
	video: HTMLVideoElement,
	canvas: HTMLCanvasElement,
): UpscaleRenderer {
	const gl = canvas.getContext("webgl2", {
		alpha: false,
		antialias: false,
		preserveDrawingBuffer: true,
	});
	if (!gl) {
		throw new Error("WebGL2 unavailable");
	}
	const programs = PASSES.map(pass => link(gl, pass.fragment));
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

	const slots: (ReturnType<typeof createRenderTarget> | null)[] = [
		null,
		null,
		null,
		null,
		null,
		null,
	];

	let frameRequest = 0;
	let stopped = false;
	let frames = 0;

	const target = (slot: number, width: number, height: number) => {
		const current = slots[slot];
		if (current && current.width === width && current.height === height) {
			return current;
		}
		if (current) {
			releaseRenderTarget(gl, current);
		}
		const created = createRenderTarget(gl, width, height);
		slots[slot] = created;
		return created;
	};

	interface Scene {
		texture: WebGLTexture;
		width: number;
		height: number;
	}

	/**
	 * Runs one chain of passes and returns its last output. `base` is the picture the chain's
	 * final pass adds its result to: the video frame for the restore chain, and the restored
	 * picture for the upscale chain, which is what mpv's MAIN holds at each point.
	 */
	const runChain = (
		passes: Anime4KPassSpec[],
		chainSlots: number[],
		input: Scene,
		base: WebGLTexture,
		index: { value: number },
	): Scene => {
		let scene = input;
		passes.forEach((pass, i) => {
			const scaled = pass.scale === 2;
			const width = scaled ? scene.width * 2 : scene.width;
			const height = scaled ? scene.height * 2 : scene.height;
			const out = target(chainSlots[i], width, height);
			const program = programs[index.value];
			const where = lookups[index.value];
			index.value++;

			gl.bindFramebuffer(gl.FRAMEBUFFER, out.framebuffer);
			gl.viewport(0, 0, width, height);
			gl.useProgram(program);
			gl.activeTexture(gl.TEXTURE0);
			gl.bindTexture(gl.TEXTURE_2D, scene.texture);
			gl.uniform1i(where.texture, 0);
			if (where.base) {
				gl.activeTexture(gl.TEXTURE1);
				gl.bindTexture(gl.TEXTURE_2D, base);
				gl.uniform1i(where.base, 1);
			}
			gl.uniform2f(where.texel, 1 / scene.width, 1 / scene.height);
			gl.uniform2f(where.size, scene.width, scene.height);
			gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

			scene = { texture: out.texture, width, height };
		});
		return scene;
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

		const index = { value: 0 };
		const videoScene: Scene = { texture: videoTexture, width: inputWidth, height: inputHeight };
		const restored = runChain(
			ANIME4K_RESTORE_PASSES,
			RESTORE_SLOTS,
			videoScene,
			videoTexture,
			index,
		);
		let shown = restored;
		if (magnifying) {
			shown = runChain(
				ANIME4K_UPSCALE_PASSES,
				UPSCALE_SLOTS,
				restored,
				restored.texture,
				index,
			);
		}

		gl.bindFramebuffer(gl.FRAMEBUFFER, null);
		gl.viewport(0, 0, outputWidth, outputHeight);
		gl.useProgram(present);
		gl.activeTexture(gl.TEXTURE0);
		gl.bindTexture(gl.TEXTURE_2D, shown.texture);
		gl.uniform1i(presentTexture, 0);
		gl.uniform1f(presentAmount, 0);
		// The chain stores its pictures the way the sharpen tier's render targets are stored.
		gl.uniform1f(presentFlip, 0);
		gl.uniform2f(presentTexel, 1 / shown.width, 1 / shown.height);
		gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

		if (frames === 0) {
			console.info(
				`[video-enhancement] Anime4K S (WebGL2) drawing ${outputWidth}×${outputHeight} from ${inputWidth}×${inputHeight}`,
			);
			reportEnhancementTarget(`Anime4K S · ${outputWidth}×${outputHeight}`);
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
			for (let i = 0; i < slots.length; i++) {
				const current = slots[i];
				if (current) {
					releaseRenderTarget(gl, current);
					slots[i] = null;
				}
			}
			gl.getExtension("WEBGL_lose_context")?.loseContext();
		},
	};
}
