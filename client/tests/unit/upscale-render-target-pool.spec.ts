import { describe, expect, it, vi } from "vitest";
import { createRenderTargetPool } from "@/util/upscale/cas";
import { ANIME4K_S_CHAIN, planChain, planTargetLimits } from "@/util/upscale/anime4k-webgl";

/**
 * The parts of a WebGL2 context createRenderTarget touches, counting the allocations. Rebuilding
 * the Anime4K chain's buffers every frame is what this pool exists to stop, so a test that only
 * sees "no new textures" catches a regression back to allocating per frame.
 */
function fakeGl() {
	let textures = 0;
	let framebuffers = 0;
	const gl = {
		TEXTURE_2D: 0x0de1,
		TEXTURE_WRAP_S: 0x2802,
		TEXTURE_WRAP_T: 0x2803,
		TEXTURE_MIN_FILTER: 0x2801,
		TEXTURE_MAG_FILTER: 0x2800,
		CLAMP_TO_EDGE: 0x812f,
		LINEAR: 0x2601,
		RGBA16F: 0x881a,
		RGBA: 0x1908,
		HALF_FLOAT: 0x140b,
		UNSIGNED_BYTE: 0x1401,
		FRAMEBUFFER: 0x8d40,
		COLOR_ATTACHMENT0: 0x8ce0,
		FRAMEBUFFER_COMPLETE: 0x8cd5,
		getExtension: vi.fn((name: string) => (name === "EXT_color_buffer_float" ? {} : null)),
		createTexture: vi.fn(() => {
			textures++;
			return {};
		}),
		createFramebuffer: vi.fn(() => {
			framebuffers++;
			return {};
		}),
		deleteTexture: vi.fn(() => {
			textures--;
		}),
		deleteFramebuffer: vi.fn(() => {
			framebuffers--;
		}),
		bindTexture: vi.fn(),
		bindFramebuffer: vi.fn(),
		texParameteri: vi.fn(),
		texImage2D: vi.fn(),
		framebufferTexture2D: vi.fn(),
		checkFramebufferStatus: vi.fn(() => 0x8cd5),
	};
	return {
		gl: gl as unknown as WebGL2RenderingContext,
		live: () => ({ textures, framebuffers }),
	};
}

describe("render target pool", () => {
	it("reuses a target of the same size instead of allocating another", () => {
		const { gl, live } = fakeGl();
		const pool = createRenderTargetPool(gl);

		const first = pool.take(3840, 2160);
		expect(live()).toEqual({ textures: 1, framebuffers: 1 });

		pool.give(first);
		const second = pool.take(3840, 2160);

		expect(second).toBe(first);
		expect(live()).toEqual({ textures: 1, framebuffers: 1 });
	});

	it("keeps a separate target for each size", () => {
		const { gl, live } = fakeGl();
		const pool = createRenderTargetPool(gl);

		const small = pool.take(1920, 1080);
		const large = pool.take(3840, 2160);
		expect(large).not.toBe(small);
		expect(live()).toEqual({ textures: 2, framebuffers: 2 });

		pool.give(small);
		pool.give(large);
		expect(pool.take(1920, 1080)).toBe(small);
		expect(pool.take(3840, 2160)).toBe(large);
		expect(live()).toEqual({ textures: 2, framebuffers: 2 });
	});

	it("frees what it still holds on dispose", () => {
		const { gl, live } = fakeGl();
		const pool = createRenderTargetPool(gl);

		pool.give(pool.take(3840, 2160));
		pool.give(pool.take(1920, 1080));
		pool.dispose();

		expect(live()).toEqual({ textures: 0, framebuffers: 0 });
		expect(gl.deleteTexture).toHaveBeenCalledTimes(2);
		// A disposed pool is empty again, so the next frame allocates afresh.
		pool.take(3840, 2160);
		expect(live()).toEqual({ textures: 1, framebuffers: 1 });
	});

	it("releases a target a bucket has no room for", () => {
		const { gl, live } = fakeGl();
		const pool = createRenderTargetPool(gl);
		pool.setLimits(new Map([["1920x1080", 1]]));

		const kept = pool.take(1920, 1080);
		const extra = pool.take(1920, 1080);
		pool.give(kept);
		pool.give(extra);

		// The second one is surplus, so it is freed instead of parked.
		expect(gl.deleteTexture).toHaveBeenCalledTimes(1);
		expect(live()).toEqual({ textures: 1, framebuffers: 1 });
		expect(pool.take(1920, 1080)).toBe(kept);
	});

	it("drops a size the new plan never uses", () => {
		const { gl, live } = fakeGl();
		const pool = createRenderTargetPool(gl);
		pool.give(pool.take(1920, 1080));
		pool.give(pool.take(3840, 2160));
		expect(live()).toEqual({ textures: 2, framebuffers: 2 });

		// The chain moved to a target size only (a fullscreen rebuild, say).
		pool.setLimits(new Map([["3840x2160", 4]]));

		expect(gl.deleteTexture).toHaveBeenCalledTimes(1);
		expect(live()).toEqual({ textures: 1, framebuffers: 1 });
	});

	it("keeps everything while no limits are known", () => {
		const { gl } = fakeGl();
		const pool = createRenderTargetPool(gl);
		const first = pool.take(1920, 1080);
		const second = pool.take(1920, 1080);

		pool.give(first);
		pool.give(second);

		expect(gl.deleteTexture).not.toHaveBeenCalled();
		expect(pool.take(1920, 1080)).toBe(second);
		expect(pool.take(1920, 1080)).toBe(first);
	});

	it("caps each size at exactly the slots the plan gives it", () => {
		const plan = planChain(
			ANIME4K_S_CHAIN,
			{ width: 1920, height: 1080 },
			{ width: 3840, height: 2160 },
		);
		const limits = planTargetLimits(plan);

		const slots = new Map<string, Set<number>>();
		for (const step of plan) {
			if (!step.active) {
				continue;
			}
			const key = `${step.width}x${step.height}`;
			const set = slots.get(key) ?? new Set<number>();
			set.add(step.slot);
			slots.set(key, set);
		}
		expect([...limits].sort()).toEqual([...slots].map(([key, set]) => [key, set.size]).sort());
		// A 2x target is what the x2 stage renders into, so both sizes appear.
		expect(limits.get("3840x2160")).toBeGreaterThanOrEqual(1);
		expect(limits.get("1920x1080")).toBeGreaterThanOrEqual(1);
	});
});
