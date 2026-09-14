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
