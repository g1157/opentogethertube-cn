import type { PlaybackDiagnostics } from "ott-common/models/types";

interface ConnectionLike {
	effectiveType?: string;
	downlink?: number;
	rtt?: number;
	saveData?: boolean;
}

export interface PlaybackDiagnosticsInput {
	video?: HTMLVideoElement | null;
	source?: { service?: string; id?: string } | null;
	playerKind: "native" | "embedded";
	hidden: boolean;
	autoplayBlocked: boolean;
	recovering: boolean;
	seeking: boolean;
	bufferAhead: number | null;
	previous?: { at: number; bufferAhead: number | null } | null;
	quality?: {
		startup: number | null;
		rebuffers: number;
		rebufferSeconds: number;
		playSeconds: number;
	} | null;
	sync?: { rateWrites: number; deadlineSeeks: number; maxAbsDrift: number } | null;
	wsRttMs?: number | null;
	hls?: { bandwidthKbps?: number; levelHeight?: number; levelCount?: number } | null;
	/** Injectable for tests; defaults to navigator.connection. */
	connection?: ConnectionLike | null;
	now?: number;
}

/** Seconds of media buffered per wall second; null when the window is unusable. */
export function bufferGrowth(
	previous: { at: number; bufferAhead: number | null } | null | undefined,
	now: number,
	current: number | null,
): number | null {
	if (!previous || previous.bufferAhead === null || current === null) {
		return null;
	}
	const elapsed = (now - previous.at) / 1000;
	if (!(elapsed > 0)) {
		return null;
	}
	const delta = current - previous.bufferAhead;
	// A shrinking buffer means a seek or source change, not a download rate.
	if (delta < -0.5) {
		return null;
	}
	return Math.round((delta / elapsed) * 1000) / 1000;
}

function connectionInfo(explicit?: ConnectionLike | null): ConnectionLike | null {
	if (explicit !== undefined) {
		return explicit;
	}
	if (typeof navigator === "undefined") {
		return null;
	}
	const connection = (navigator as Navigator & { connection?: ConnectionLike }).connection;
	return connection ?? null;
}

function sourceHost(source: PlaybackDiagnosticsInput["source"]): string | undefined {
	if (!source?.id) {
		return undefined;
	}
	try {
		return new URL(source.id).host || undefined;
	} catch {
		return undefined;
	}
}

function frameCounters(video: HTMLVideoElement | null | undefined) {
	try {
		const quality = video?.getVideoPlaybackQuality?.();
		return quality
			? { totalFrames: quality.totalVideoFrames, droppedFrames: quality.droppedVideoFrames }
			: {};
	} catch {
		return {};
	}
}

/**
 * Build the compact snapshot the server logs when this viewer holds the buffer gate.
 * It answers "why is this viewer slow": buffer runway and its growth rate, the browser's
 * own link estimate and RTT, the room socket RTT, decoder drops, hidden-tab/autoplay state,
 * and — for HLS — the engine's bandwidth estimate and active level.
 */
export function collectPlaybackDiagnostics(input: PlaybackDiagnosticsInput): PlaybackDiagnostics {
	const now = input.now ?? Date.now();
	const video = input.video ?? null;
	const connection = connectionInfo(input.connection);
	const frames = frameCounters(video);
	const hls = input.hls;

	return {
		sampledAt: now,
		service: input.source?.service,
		sourceHost: sourceHost(input.source),
		playerKind: input.playerKind,
		hidden: input.hidden,
		paused: video?.paused,
		readyState: video?.readyState,
		networkState: video?.networkState,
		bufferAhead: input.bufferAhead,
		bufferGrowth: bufferGrowth(input.previous, now, input.bufferAhead),
		startup: input.quality?.startup ?? null,
		rebuffers: input.quality?.rebuffers,
		rebufferSeconds: input.quality?.rebufferSeconds,
		playSeconds: input.quality?.playSeconds,
		rateWrites: input.sync?.rateWrites,
		deadlineSeeks: input.sync?.deadlineSeeks,
		maxDrift: input.sync?.maxAbsDrift,
		...frames,
		wsRttMs: input.wsRttMs ?? null,
		connectionEffectiveType: connection?.effectiveType,
		connectionDownlinkMbps:
			typeof connection?.downlink === "number" ? connection.downlink : undefined,
		connectionRttMs: typeof connection?.rtt === "number" ? connection.rtt : undefined,
		connectionSaveData: connection?.saveData,
		hlsBandwidthKbps: hls?.bandwidthKbps,
		hlsLevelHeight: hls?.levelHeight,
		hlsLevelCount: hls?.levelCount,
		autoplayBlocked: input.autoplayBlocked,
		recovering: input.recovering,
		seeking: input.seeking,
		errorCode: video?.error?.code ?? null,
	};
}
