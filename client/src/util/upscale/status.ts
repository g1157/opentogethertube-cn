import { ref } from "vue";

/**
 * Why the video enhancement last gave up, surfaced in the playback details panel.
 *
 * WebGPU reports most mistakes asynchronously (validation errors, a lost device), so
 * without this the tier can stop drawing while the UI still believes it is running —
 * which is what a browser with a partial WebGPU implementation looks like.
 */
export const lastEnhancementError = ref<string | null>(null);

export function reportEnhancementError(message: string | null): void {
	lastEnhancementError.value = message;
}

/** Where the enhancement is rendering, for the panel: e.g. "Anime4K 质量 2560×1440". */
export const enhancementTarget = ref<string | null>(null);

export function reportEnhancementTarget(label: string | null): void {
	enhancementTarget.value = label;
}

/**
 * The engine the AI tiers ended up on. The sizing rule needs it — only the WebGPU presets can
 * afford the x2 intermediates the CNN floor causes (see `usesCnnSupersampling`) — and so do the
 * details panel and the queue badge, which otherwise preview a target the layer will not render.
 * `null` until an AI tier has started, and after the layer goes away.
 */
export const enhancementBackend = ref<"webgpu" | "webgl2" | null>(null);

export function reportEnhancementBackend(backend: "webgpu" | "webgl2" | null): void {
	enhancementBackend.value = backend;
}
