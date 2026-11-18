import { afterEach, describe, expect, it, vi } from "vitest";
import { startAnime4KWebGLRenderer } from "@/util/upscale/anime4k-webgl";

function context() {
	const textures = new Set<object>();
	const framebuffers = new Set<object>();
	const create = (set: Set<object>) => {
		const item = {};
		set.add(item);
		return item;
	};
	const gl = {
		getExtension: vi.fn(() => ({})),
		createShader: vi.fn(() => ({})),
		shaderSource: vi.fn(),
		compileShader: vi.fn(),
		getShaderParameter: vi.fn(() => true),
		getShaderInfoLog: vi.fn(),
		createProgram: vi.fn(() => ({})),
		attachShader: vi.fn(),
		linkProgram: vi.fn(),
		getProgramParameter: vi.fn(() => true),
		getProgramInfoLog: vi.fn(),
		detachShader: vi.fn(),
		deleteShader: vi.fn(),
		deleteProgram: vi.fn(),
		createVertexArray: vi.fn(() => ({})),
		bindVertexArray: vi.fn(),
		deleteVertexArray: vi.fn(),
		createBuffer: vi.fn(() => ({})),
		bindBuffer: vi.fn(),
		bufferData: vi.fn(),
		deleteBuffer: vi.fn(),
		enableVertexAttribArray: vi.fn(),
		vertexAttribPointer: vi.fn(),
		createTexture: vi.fn(() => create(textures)),
		deleteTexture: vi.fn(item => textures.delete(item)),
		bindTexture: vi.fn(),
		texParameteri: vi.fn(),
		pixelStorei: vi.fn(),
		texImage2D: vi.fn(),
		createFramebuffer: vi.fn(() => create(framebuffers)),
		deleteFramebuffer: vi.fn(item => framebuffers.delete(item)),
		bindFramebuffer: vi.fn(),
		framebufferTexture2D: vi.fn(),
		checkFramebufferStatus: vi.fn(() => 1),
		FRAMEBUFFER_COMPLETE: 1,
		getUniformLocation: vi.fn(() => ({})),
		useProgram: vi.fn(),
		uniform1i: vi.fn(),
		uniform1f: vi.fn(),
		uniform2f: vi.fn(),
		activeTexture: vi.fn(),
		viewport: vi.fn(),
		drawArrays: vi.fn(),
	} as unknown as WebGL2RenderingContext;
	const video = document.createElement("video");
	Object.defineProperties(video, {
		videoWidth: { value: 1280 },
		videoHeight: { value: 720 },
		readyState: { value: 2 },
	});
	Object.defineProperties(video, {
		requestVideoFrameCallback: { value: () => 1, writable: true },
		cancelVideoFrameCallback: { value: () => undefined, writable: true },
	});
	vi.spyOn(video, "requestVideoFrameCallback");
	vi.spyOn(video, "cancelVideoFrameCallback");
	const canvas = document.createElement("canvas");
	canvas.width = 1920;
	canvas.height = 1080;
	vi.spyOn(canvas, "getContext").mockReturnValue(gl);
	return { video, canvas, textures, framebuffers, gl };
}

describe("paused enhancement memory", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		vi.useRealTimers();
	});

	it("releases active and pooled targets after a paused redraw, then rebuilds on demand", () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		const { video, canvas, textures, framebuffers, gl } = context();
		const renderer = startAnime4KWebGLRenderer(video, canvas);
		try {
			expect(framebuffers.size).toBeGreaterThan(0);
			vi.advanceTimersByTime(14000);
			renderer.redraw!();
			vi.advanceTimersByTime(14000);
			expect(framebuffers.size).toBeGreaterThan(0);
			vi.advanceTimersByTime(1000);
			expect(framebuffers.size).toBe(0);
			expect(textures.size).toBe(1); // Only the upload texture remains; the picture lives in the canvas.
			const draws = vi.mocked(gl.drawArrays).mock.calls.length;
			renderer.redraw!();
			expect(framebuffers.size).toBeGreaterThan(0);
			expect(vi.mocked(gl.drawArrays).mock.calls.length).toBeGreaterThan(draws);
		} finally {
			renderer.stop();
		}
		expect(textures.size).toBe(0);
		expect(framebuffers.size).toBe(0);
	});
});
