// Anime4K on WebGL2: the official CNN chains, run as WebGL2 fragment shaders, for every browser
// without a usable WebGPU — Firefox outside Windows and Nightly, Safari before 26, and machines
// whose driver the WebGPU blocklist rejects.
//
// The shaders are generated from the official Anime4K v4.0.1 GLSL (see anime4k-glsl.ts and the
// converter it names). The driver keeps mpv's own model of a chain: MAIN is the picture as it
// stands when a pass runs, a pass that saves to a name of its own leaves it alone, and one that
// saves to MAIN — or does not save at all — replaces it. Names outlive the file that wrote them,
// which is what lets Clamp_Highlights read the whole picture at the end of the chain (mpv runs its
// clamp at PREKERNEL, after every MAIN pass), and a buffer is only reused once nothing samples the
// name it holds any more.
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

/** True when a pass replaces the picture rather than writing a feature map of its own. */
const writesPicture = (pass: Anime4KPassSpec) => pass.name === "MAIN" || pass.name === "output";

export interface Anime4KPlanStep {
	/** The pass to run, and where its compiled program sits in the chain's program list. */
	pass: Anime4KPassSpec;
	index: number;
	/** False when Anime4K's 1.2x condition skips this pass at this target size. */
	active: boolean;
	/** What each sampler gets; `"input"` is already resolved to whatever holds the picture then. */
	reads: string[];
	/** The size of the texture this pass samples. Its output is `scale` times that. */
	source: { width: number; height: number };
	/** The size this pass renders at. */
	width: number;
	height: number;
	/** Which buffer of the frame this pass renders into. */
	slot: number;
}

/**
 * Works out a frame's passes: which run at this target size, what each of them samples, how big
 * its output is, and which buffer it writes.
 *
 * Buffers are reused as soon as nothing samples the name they hold any more, which has to be
 * tracked per name rather than per pass index: the VL chains write a pair of feature-map halves
 * per layer and the next layer reads both halves, and a depth-to-space pass adds the picture —
 * still `"input"` to it — that was written several passes earlier.
 */
export function planChain(
	chain: Anime4KChain,
	input: { width: number; height: number },
	target: { width: number; height: number },
): Anime4KPlanStep[] {
	const steps: Anime4KPlanStep[] = [];
	// mpv's MAIN: the picture a pass sees. It only moves when a pass writes the main image.
	const sizes = new Map<string, { width: number; height: number }>([["video", input]]);
	let picture = "video";
	let pictureSize = input;
	let index = 0;
	for (const segment of chain.segments) {
		// Each file is gated by its own `//!WHEN OUTPUT > 1.2x MAIN`: an x2 stage only runs when the
		// target is more than 1.2x the picture it would upscale. The second stage of an A+A chain
		// sees the first stage's output, which at 2x targets is already 1:1 with the target.
		const magnifying =
			target.width > ANIME4K_UPSCALE_THRESHOLD * pictureSize.width &&
			target.height > ANIME4K_UPSCALE_THRESHOLD * pictureSize.height;
		for (const pass of segment) {
			const active = !pass.upscaleOnly || magnifying;
			const reads = active ? pass.reads.map(name => (name === "input" ? picture : name)) : [];
			// A pass that writes the picture renders at the picture's size — Clamp_Highlights' clamp
			// samples statistics the head of the chain left at the source size but writes the
			// finished picture — while a feature-map pass is sized by what it samples.
			const source = writesPicture(pass)
				? pictureSize
				: (sizes.get(reads[0] ?? "video") ?? pictureSize);
			const width = pass.scale === 2 ? source.width * 2 : source.width;
			const height = pass.scale === 2 ? source.height * 2 : source.height;
			steps.push({ pass, index: index++, active, reads, source, width, height, slot: -1 });
			if (!active) {
				continue;
			}
			sizes.set(pass.name, { width, height });
			if (writesPicture(pass)) {
				picture = pass.name;
				pictureSize = { width, height };
			}
		}
	}

	const lastRead = new Map<string, number>();
	steps.forEach((step, position) => {
		for (const name of step.reads) {
			lastRead.set(name, Math.max(lastRead.get(name) ?? -1, position));
		}
	});
	const slotOf = new Map<string, number>([["video", -1]]);
	const free: number[] = [];
	let next = 0;
	steps.forEach((step, position) => {
		if (!step.active) {
			return;
		}
		for (const [name, slot] of [...slotOf]) {
			if (slot >= 0 && (lastRead.get(name) ?? -1) < position && !step.reads.includes(name)) {
				slotOf.delete(name);
				free.push(slot);
			}
		}
		const sampled = new Set(step.reads.map(name => slotOf.get(name)));
		let slot = slotOf.get(step.pass.name);
		if (slot === undefined || sampled.has(slot)) {
			slot = free.length > 0 ? (free.shift() as number) : next++;
			// A pass that reads and writes its own name moved it to a fresh buffer; the old one is
			// dead now that nothing refers to it by name any more.
			if (slotOf.has(step.pass.name)) {
				free.push(slotOf.get(step.pass.name) as number);
			}
		}
		slotOf.set(step.pass.name, slot);
		step.slot = slot;
	});
	return steps;
}

/** Every shader in the chain, so the guard test can scan them like the hand-written ones. */
export const ANIME4K_WEBGL_SHADERS: string[] = ANIME4K_PASSES.map(pass => pass.fragment);

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

	const lookups = chain.segments.flat().map((pass, index) => {
		const program = programs[index];
		return {
			textures: pass.reads.map((_, unit) =>
				gl.getUniformLocation(program, unit === 0 ? "uTexture" : `uTexture${unit}`),
			),
			texel: gl.getUniformLocation(program, "uTexel"),
			size: gl.getUniformLocation(program, "uSize"),
		};
	});
	const presentTexture = gl.getUniformLocation(present, "uTexture");
	const presentAmount = gl.getUniformLocation(present, "uAmount");
	const presentTexel = gl.getUniformLocation(present, "uTexel");
	const presentFlip = gl.getUniformLocation(present, "uFlipY");

	// One render target per buffer the plan hands out, so a long chain keeps only the buffers that
	// still hold a name something samples.
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
		const plan = planChain(
			chain,
			{ width: inputWidth, height: inputHeight },
			{ width: outputWidth, height: outputHeight },
		);

		// The video texture is stored flipped, render targets are not, so the reads of the video —
		// and only those — flip, which the converter bakes into the shaders. "input" resolves to
		// whichever texture holds the picture at that point in the chain.
		const textures = new Map<string, WebGLTexture>([["video", videoTexture]]);
		let picture = videoTexture;
		let pictureWidth = inputWidth;
		let pictureHeight = inputHeight;
		passCount = 0;

		for (const step of plan) {
			if (!step.active) {
				continue;
			}
			const out = target(step.slot, step.width, step.height);
			const program = programs[step.index];
			const where = lookups[step.index];
			gl.bindFramebuffer(gl.FRAMEBUFFER, out.framebuffer);
			gl.viewport(0, 0, step.width, step.height);
			gl.useProgram(program);
			step.reads.forEach((name, unit) => {
				gl.activeTexture(gl.TEXTURE0 + unit);
				gl.bindTexture(gl.TEXTURE_2D, textures.get(name) ?? videoTexture);
				gl.uniform1i(where.textures[unit], unit);
			});
			gl.uniform2f(where.texel, 1 / step.source.width, 1 / step.source.height);
			gl.uniform2f(where.size, step.source.width, step.source.height);
			gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
			passCount++;

			textures.set(step.pass.name, out.texture);
			if (writesPicture(step.pass)) {
				picture = out.texture;
				pictureWidth = step.width;
				pictureHeight = step.height;
			}
		}

		gl.bindFramebuffer(gl.FRAMEBUFFER, null);
		gl.viewport(0, 0, outputWidth, outputHeight);
		gl.useProgram(present);
		gl.activeTexture(gl.TEXTURE0);
		gl.bindTexture(gl.TEXTURE_2D, picture);
		gl.uniform1i(presentTexture, 0);
		gl.uniform1f(presentAmount, 0);
		// The chain stores its pictures the way the sharpen tier's render targets are stored.
		gl.uniform1f(presentFlip, 0);
		gl.uniform2f(presentTexel, 1 / pictureWidth, 1 / pictureHeight);
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
