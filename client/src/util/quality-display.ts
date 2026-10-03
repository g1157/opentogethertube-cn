export type QualityTier = "ultra" | "hd" | "sd" | "smooth";

/**
 * The tier word for a rendition, the way Chinese streaming sites label their ladder:
 * 超清 for 1080p and up, 高清 for 720p, 清晰 for 480p, 流畅 below that. Null when the
 * height is unknown, so the UI can fall back to the raw resolution.
 */
export function qualityTierFromHeight(height: number): QualityTier | null {
	if (!Number.isFinite(height) || height <= 0) {
		return null;
	}
	if (height >= 1080) {
		return "ultra";
	}
	if (height >= 720) {
		return "hd";
	}
	if (height >= 480) {
		return "sd";
	}
	return "smooth";
}
