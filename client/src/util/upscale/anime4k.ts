/// <reference types="@webgpu/types" />
/* global GPUCanvasContext, GPUDevice, GPUShaderStage, GPUTextureUsage */
// Stoppable Anime4K WebGPU driver, adapted from Anime4K-WebGPU (MIT, Anime4KWebBoost)
// so that tier switches and unmounts can cancel the render loop and free the device.
// Two presets are exposed: "fast" (Mode A: restore, then one x2 upscale) and "quality"
// (Mode A+A: the same twice, the highest perceptual quality the port offers).
import type { Anime4KPipeline } from "anime4k-webgpu";

export interface UpscaleRenderer {
	stop(): void;
}

export type Anime4KVariant = "fast" | "quality";

const fullscreenTexturedQuadWGSL = `
struct VertexOutput {
  @builtin(position) Position : vec4<f32>,
  @location(0) fragUV : vec2<f32>,
}

@vertex
fn vert_main(@builtin(vertex_index) VertexIndex : u32) -> VertexOutput {
  const pos = array(
    vec2( 1.0,  1.0),
    vec2( 1.0, -1.0),
    vec2(-1.0, -1.0),
    vec2( 1.0,  1.0),
    vec2(-1.0, -1.0),
    vec2(-1.0,  1.0),
  );

  const uv = array(
    vec2(1.0, 0.0),
    vec2(1.0, 1.0),
    vec2(0.0, 1.0),
    vec2(1.0, 0.0),
    vec2(0.0, 1.0),
    vec2(0.0, 0.0),
  );

  var output : VertexOutput;
  output.Position = vec4(pos[VertexIndex], 0.0, 1.0);
  output.fragUV = uv[VertexIndex];
  return output;
}
`;

const sampleExternalTextureWGSL = `
@group(0) @binding(1) var mySampler: sampler;
@group(0) @binding(2) var myTexture: texture_2d<f32>;

@fragment
fn main(@location(0) fragUV : vec2f) -> @location(0) vec4f {
  return textureSampleBaseClampToEdge(myTexture, mySampler, fragUV);
}
`;

export async function startAnime4KRenderer(
	video: HTMLVideoElement,
	canvas: HTMLCanvasElement,
	variant: Anime4KVariant = "fast",
): Promise<UpscaleRenderer> {
	if (video.readyState < video.HAVE_FUTURE_DATA) {
		await new Promise<void>(resolve => {
			video.addEventListener("loadeddata", () => resolve(), { once: true });
		});
	}
	const width = video.videoWidth;
	const height = video.videoHeight;

	const adapter = await navigator.gpu.requestAdapter();
	if (!adapter) {
		throw new Error("WebGPU adapter unavailable");
	}
	const device = await adapter.requestDevice();
	// @webgpu/types supplies the WebGPU globals; the DOM lib has no overload for this context id.
	const context = canvas.getContext("webgpu") as GPUCanvasContext | null;
	if (!context) {
		device.destroy();
		throw new Error("WebGPU canvas context unavailable");
	}
	const presentationFormat = navigator.gpu.getPreferredCanvasFormat();
	context.configure({ device, format: presentationFormat, alphaMode: "premultiplied" });

	const { ModeA, ModeAA } = await import("anime4k-webgpu");

	const videoFrameTexture = device.createTexture({
		size: [width, height, 1],
		format: "rgba16float",
		usage:
			GPUTextureUsage.TEXTURE_BINDING |
			GPUTextureUsage.COPY_DST |
			GPUTextureUsage.RENDER_ATTACHMENT,
	});

	// A+A chains a second restore and upscale pass, which is what the "quality" tier sells.
	const Preset = variant === "quality" ? ModeAA : ModeA;
	const preset = new Preset({
		device,
		inputTexture: videoFrameTexture,
		nativeDimensions: { width, height },
		targetDimensions: { width: canvas.width, height: canvas.height },
	}) as unknown as Anime4KPipeline;

	const renderBindGroupLayout = device.createBindGroupLayout({
		entries: [
			{ binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
			{ binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: {} },
		],
	});
	const renderPipelineLayout = device.createPipelineLayout({
		bindGroupLayouts: [renderBindGroupLayout],
	});
	const renderPipeline = device.createRenderPipeline({
		layout: renderPipelineLayout,
		vertex: {
			module: device.createShaderModule({ code: fullscreenTexturedQuadWGSL }),
			entryPoint: "vert_main",
		},
		fragment: {
			module: device.createShaderModule({ code: sampleExternalTextureWGSL }),
			entryPoint: "main",
			targets: [{ format: presentationFormat }],
		},
		primitive: { topology: "triangle-list" },
	});
	const sampler = device.createSampler({ magFilter: "linear", minFilter: "linear" });
	const renderBindGroup = device.createBindGroup({
		layout: renderBindGroupLayout,
		entries: [
			{ binding: 1, resource: sampler },
			{ binding: 2, resource: preset.getOutputTexture().createView() },
		],
	});

	let frameRequest = 0;
	let stopped = false;

	const frame = () => {
		if (stopped) {
			return;
		}
		if (!video.paused) {
			device.queue.copyExternalImageToTexture(
				{ source: video },
				{ texture: videoFrameTexture },
				[width, height],
			);
		}
		const commandEncoder = device.createCommandEncoder();
		preset.pass(commandEncoder);
		const passEncoder = commandEncoder.beginRenderPass({
			colorAttachments: [
				{
					view: context.getCurrentTexture().createView(),
					clearValue: { r: 0, g: 0, b: 0, a: 1 },
					loadOp: "clear",
					storeOp: "store",
				},
			],
		});
		passEncoder.setPipeline(renderPipeline);
		passEncoder.setBindGroup(0, renderBindGroup);
		passEncoder.draw(6);
		passEncoder.end();
		device.queue.submit([commandEncoder.finish()]);
		frameRequest = video.requestVideoFrameCallback(frame);
	};
	frameRequest = video.requestVideoFrameCallback(frame);

	return {
		stop() {
			stopped = true;
			video.cancelVideoFrameCallback(frameRequest);
			device.destroy();
		},
	};
}
