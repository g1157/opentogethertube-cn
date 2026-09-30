import { describe, expect, it, vi } from "vitest";
import { link } from "@/util/upscale/cas";

/**
 * A context small enough to link against, plus a handle on its context-loss listener so the
 * test can fire it. The cache is per context, so both the programs and the listener matter.
 */
function fakeGl() {
	let lost: (() => void) | undefined;
	const programs: object[] = [];
	const gl = {
		canvas: {
			addEventListener: (type: string, listener: () => void) => {
				if (type === "webglcontextlost") {
					lost = listener;
				}
			},
		},
		createShader: vi.fn(() => ({})),
		shaderSource: vi.fn(),
		compileShader: vi.fn(),
		getShaderParameter: vi.fn(() => true),
		getShaderInfoLog: vi.fn(() => ""),
		createProgram: vi.fn(() => {
			const program = { id: programs.length };
			programs.push(program);
			return program;
		}),
		attachShader: vi.fn(),
		linkProgram: vi.fn(),
		getProgramParameter: vi.fn(() => true),
		getProgramInfoLog: vi.fn(() => ""),
	} as unknown as WebGL2RenderingContext;
	return { gl, loseContext: () => lost?.() };
}

describe("linked program cache", () => {
	it("links a chain once per context", () => {
		// The layer rebuilds on a tier switch, a scale step and a fullscreen toggle, all on the
		// same canvas now: re-linking the heavy chain's 55 programs each time was most of what a
		// rebuild cost.
		const { gl } = fakeGl();
		const first = link(gl, "fragment a");
		expect(link(gl, "fragment a")).toBe(first);
		expect(gl.createProgram).toHaveBeenCalledTimes(1);

		const other = link(gl, "fragment b");
		expect(other).not.toBe(first);
		expect(gl.createProgram).toHaveBeenCalledTimes(2);
	});

	it("gives each context its own programs", () => {
		// Programs cannot be shared between contexts, and reusing a canvas must never hand one
		// context a program that belongs to another.
		const a = fakeGl();
		const b = fakeGl();
		expect(link(a.gl, "fragment")).not.toBe(link(b.gl, "fragment"));
		expect(a.gl.createProgram).toHaveBeenCalledTimes(1);
		expect(b.gl.createProgram).toHaveBeenCalledTimes(1);
	});

	it("recompiles after the context is lost", () => {
		// Every program on a lost context is dead, so they must not be handed out again.
		const { gl, loseContext } = fakeGl();
		const first = link(gl, "fragment");
		loseContext();
		const second = link(gl, "fragment");
		expect(second).not.toBe(first);
		expect(gl.createProgram).toHaveBeenCalledTimes(2);
	});

	it("fails loudly when the program cannot be created", () => {
		const { gl } = fakeGl();
		(gl.createProgram as unknown as ReturnType<typeof vi.fn>).mockReturnValueOnce(null);
		expect(() => link(gl, "fragment")).toThrow("Unable to create program");
	});
});
