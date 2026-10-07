/// <reference types="@webgpu/types" />
/* global GPUCanvasContext, GPUDevice, GPUShaderStage, GPUTextureUsage */
// Stoppable Anime4K WebGPU driver, adapted from Anime4K-WebGPU (MIT, Anime4KWebBoost)
// so that tier switches and unmounts can cancel the render loop and free the device.
// Two presets are exposed: "fast" (Mode A: restore, then one x2 upscale) and "quality"
// (Mode A+A: the same twice, the highest perceptual quality the port offers).
import type { Anime4KPipeline } from "anime4k-webgpu";
import { reportEnhancementError, reportEnhancementTarget } from "./status";

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
	/** Called when WebGPU stops the tier on its own: a lost device or a failed setup. */
	onFatal?: (message: string) => void,
): Promise<UpscaleRenderer> {
	if (video.readyState < video.HAVE_FUTURE_DATA) {
		await new Promise<void>(resolve => {
			video.addEventListener("loadeddata", () => resolve(), { once: true });
		});
	}
	const width = video.videoWidth;
	const height = video.videoHeight;

	// Some implementations only hand out an adapter when performance is requested.
	const adapter =
		(await navigator.gpu.requestAdapter({ powerPreference: "high-performance" })) ??
		(await navigator.gpu.requestAdapter());
	if (!adapter) {
		throw new Error("WebGPU adapter unavailable");
	}
	const device = await adapter.requestDevice();
	let frameRequest = 0;
	let stopped = false;
	let frames = 0;
	/** Media time of the frame the last loop callback drew; a repeated presentation of the
	 * same frame (a rate-change re-time, a redraw after a seek) is skipped, not drawn twice. */
	let lastFrameMediaTime = Number.NaN;
	let drawFailures = 0;
	let drawFrame: () => void = () => undefined;
	try {
		// WebGPU reports most setup mistakes through error scopes instead of exceptions. A
		// browser with a partial implementation would otherwise keep "rendering" with
		// nothing on screen and never let the layer fall back to a tier that works.
		device.pushErrorScope("validation");
		// @webgpu/types supplies the WebGPU globals; the DOM lib has no overload for this context id.
		const context = canvas.getContext("webgpu") as GPUCanvasContext | null;
		if (!context) {
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

		const validationError = await device.popErrorScope();
		if (validationError) {
			throw new Error(`WebGPU rejected the ${variant} pipeline: ${validationError.message}`);
		}

		const fail = (message: string) => {
			console.error(`[video-enhancement] ${message}`);
			reportEnhancementError(message);
			onFatal?.(message);
		};

		void device.lost.then(info => {
			if (stopped) {
				return;
			}
			stopped = true;
			video.cancelVideoFrameCallback(frameRequest);
			fail(`WebGPU device lost (${info.reason})${info.message ? `: ${info.message}` : ""}`);
		});
		device.onuncapturederror = event => {
			// The tier may still be drawing, so this only records the cause; the playback
			// details panel shows it, and the console keeps the full message.
			console.error("[video-enhancement] uncaptured WebGPU error:", event.error.message);
			reportEnhancementError(event.error.message);
		};

		/**
		 * Draws the frame the video currently holds. requestVideoFrameCallback is what normally
		 * drives the loop, and it only fires for newly presented frames: while the video is paused
		 * nothing would ever be drawn, so starting or rebuilding the tier while paused used to
		 * leave a canvas nobody had drawn into — which shows the raw video underneath instead of
		 * the enhanced picture. start(), pause and seeked therefore draw explicitly.
		 */
		drawFrame = () => {
			if (stopped || video.readyState < video.HAVE_CURRENT_DATA) {
				return;
			}
			device.queue.copyExternalImageToTexture(
				{ source: video },
				{ texture: videoFrameTexture },
				[width, height],
			);
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
			if (frames === 0) {
				console.info(
					`[video-enhancement] Anime4K ${variant} (WebGPU) drawing ${canvas.width}×${canvas.height} from ${width}×${height}`,
				);
				reportEnhancementTarget(
					`Anime4K ${variant} (WebGPU) · ${canvas.width}×${canvas.height}`,
				);
			}
			frames++;
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
				// tier that still looked enabled. Three failures in a row stand the renderer
				// down and surface the reason in the playback details panel.
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
	} catch (err) {
		// A setup that fails halfway — a browser that cannot upload a <video> frame (Firefox),
		// or a driver that rejects the pipeline — must not leave its device, textures and
		// listeners behind: the tier is retried on every tier switch and fullscreen toggle, so
		// each failure would otherwise leak a GPU device until the process runs out of memory.
		stopped = true;
		if (frameRequest) {
			video.cancelVideoFrameCallback(frameRequest);
		}
		video.removeEventListener("pause", drawFrame);
		video.removeEventListener("seeked", drawFrame);
		device.destroy();
		throw err;
	}

	return {
		stop() {
			stopped = true;
			video.cancelVideoFrameCallback(frameRequest);
			video.removeEventListener("pause", drawFrame);
			video.removeEventListener("seeked", drawFrame);
			device.destroy();
		},
	};
}
