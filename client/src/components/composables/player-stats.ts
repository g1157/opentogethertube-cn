import { onBeforeUnmount, ref, watch, type Ref } from "vue";
import { calculateCurrentPosition } from "ott-common/timestamp";
import { useStore } from "@/store";
import type { UpscaleMode } from "@/stores/settings";
import { MAX_SCALE, computeCanvasSize } from "@/util/upscale/scale";

export interface PlayerStatsRow {
	labelKey: string;
	/** Preformatted value; takes precedence over valueKey. */
	value?: string;
	/** i18n key for a localized value, plus its interpolation parameters. */
	valueKey?: string;
	params?: Record<string, unknown>;
}

export interface PlayerStatsSection {
	titleKey: string;
	rows: PlayerStatsRow[];
}

export interface PlayerStatsInput {
	video?: HTMLVideoElement;
	/** Presentation rate measured over the last sampling window, null while paused. */
	measuredFps: number | null;
	now: number;
	room: {
		isPlaying: boolean;
		playbackPosition: number;
		playbackStartTimeMs: number | null;
		playbackSpeed: number;
		sourceId?: string;
		sourceService?: string;
	};
	settings: {
		upscaleMode: UpscaleMode;
		upscaleScale: number | "auto";
		upscaleAutoDegrade: boolean;
	};
	device: {
		dpr: number;
		viewportWidth: number;
		viewportHeight: number;
		webgpu: boolean;
		gpuName: string | null;
	};
}

export function secondsToTimestamp(seconds: number): string {
	if (!Number.isFinite(seconds) || seconds < 0) {
		return "—";
	}
	const total = Math.floor(seconds);
	const hours = Math.floor(total / 3600);
	const minutes = Math.floor((total % 3600) / 60);
	const secs = total % 60;
	const mm = String(minutes).padStart(2, "0");
	const ss = String(secs).padStart(2, "0");
	return hours > 0 ? `${hours}:${mm}:${ss}` : `${minutes}:${ss}`;
}

/** Seconds buffered ahead of the current position, or null when unknown. */
export function bufferAhead(video: HTMLVideoElement): number | null {
	try {
		const buffered = video.buffered;
		if (!buffered || buffered.length === 0) {
			return null;
		}
		const time = video.currentTime;
		for (let i = 0; i < buffered.length; i++) {
			if (time >= buffered.start(i) && time <= buffered.end(i)) {
				return buffered.end(i) - time;
			}
		}
		return null;
	} catch {
		// jsdom and some embeds throw on buffered/time reads.
		return null;
	}
}

function playStateKey(video: HTMLVideoElement | undefined): string {
	if (!video) {
		return "player.stats.state-unknown";
	}
	if (video.paused) {
		return "player.stats.state-paused";
	}
	return video.readyState < 3 ? "player.stats.state-buffering" : "player.stats.state-playing";
}

/** A row whose value is a number of seconds, formatted with the app's unit. */
function secondsRow(
	labelKey: string,
	seconds: number | null,
	format = (s: number) => s.toFixed(1),
): PlayerStatsRow {
	if (seconds === null) {
		return { labelKey, value: "—" };
	}
	return { labelKey, valueKey: "player.stats.value-seconds", params: { value: format(seconds) } };
}

/**
 * Everything the playback details panel shows, as label/value pairs. Deliberately
 * free of i18n and DOM wiring so a test can drive it with a fake element.
 */
export function collectPlayerStats(input: PlayerStatsInput): PlayerStatsSection[] {
	const video = input.video;
	const width = video?.videoWidth ?? 0;
	const height = video?.videoHeight ?? 0;

	let sourceHost: string | null = null;
	try {
		if (input.room.sourceId) {
			sourceHost = new URL(input.room.sourceId).host || null;
		}
	} catch {
		sourceHost = null;
	}

	const canvas =
		video && width > 0
			? computeCanvasSize({
					nativeWidth: width,
					nativeHeight: height,
					boxWidth: video.getBoundingClientRect().width,
					boxHeight: video.getBoundingClientRect().height,
					dpr: Math.min(input.device.dpr || 1, 2),
					requestedScale: input.settings.upscaleScale,
				})
			: null;
	const scale = canvas && width > 0 ? canvas.width / width : null;

	let quality: { droppedVideoFrames: number; totalVideoFrames: number } | null = null;
	try {
		quality = video?.getVideoPlaybackQuality?.() ?? null;
	} catch {
		quality = null;
	}

	let drift: number | null = null;
	if (video && input.room.isPlaying && input.room.playbackStartTimeMs !== null) {
		const roomPosition = calculateCurrentPosition(
			input.room.playbackStartTimeMs,
			input.now,
			input.room.playbackPosition,
			input.room.playbackSpeed,
		);
		drift = roomPosition - video.currentTime;
	}

	const videoRows: PlayerStatsRow[] = [
		{
			labelKey: "player.stats.resolution",
			value: width > 0 ? `${width}×${height}` : "—",
		},
		{
			labelKey: "player.stats.time",
			valueKey: "player.stats.value-time",
			params: {
				current: video ? secondsToTimestamp(video.currentTime) : "—",
				total:
					video && Number.isFinite(video.duration) && video.duration > 0
						? secondsToTimestamp(video.duration)
						: "—",
			},
		},
	];
	if (input.room.sourceService) {
		videoRows.push({ labelKey: "player.stats.source-type", value: input.room.sourceService });
	}
	if (sourceHost) {
		videoRows.push({ labelKey: "player.stats.source-host", value: sourceHost });
	}

	const ahead = video ? bufferAhead(video) : null;
	const playbackRows: PlayerStatsRow[] = [
		{ labelKey: "player.stats.state", valueKey: playStateKey(video) },
		{
			labelKey: "player.stats.rate",
			value: `${(video?.playbackRate ?? input.room.playbackSpeed ?? 1).toFixed(2)}×`,
		},
		secondsRow("player.stats.buffer-ahead", ahead),
		{
			labelKey: "player.stats.dropped",
			value: quality ? `${quality.droppedVideoFrames} / ${quality.totalVideoFrames}` : "—",
		},
		{
			labelKey: "player.stats.render-fps",
			value: input.measuredFps === null ? "—" : `${input.measuredFps.toFixed(1)} fps`,
		},
		secondsRow("player.stats.drift", drift, s => `${s >= 0 ? "+" : ""}${s.toFixed(2)}`),
	];

	const enhancementRows: PlayerStatsRow[] = [
		{
			labelKey: "player.stats.mode",
			valueKey: `room.upscale.${input.settings.upscaleMode}`,
		},
		{
			labelKey: "player.stats.render-target",
			value: canvas ? `${canvas.width}×${canvas.height}（${(scale ?? 1).toFixed(2)}×）` : "—",
		},
		{
			labelKey: "player.stats.auto-degrade",
			valueKey: input.settings.upscaleAutoDegrade ? "common.on" : "common.off",
		},
	];

	const webgpuRow: PlayerStatsRow = input.device.gpuName
		? { labelKey: "player.stats.webgpu", value: input.device.gpuName }
		: {
				labelKey: "player.stats.webgpu",
				valueKey: input.device.webgpu
					? "player.stats.available"
					: "player.stats.unavailable",
			};

	const deviceRows: PlayerStatsRow[] = [
		{
			labelKey: "player.stats.viewport",
			value: `${input.device.viewportWidth}×${input.device.viewportHeight} · DPR ${input.device.dpr}`,
		},
		webgpuRow,
		{ labelKey: "player.stats.max-scale", value: `${MAX_SCALE}×` },
	];

	return [
		{ titleKey: "player.stats.section-video", rows: videoRows },
		{ titleKey: "player.stats.section-playback", rows: playbackRows },
		{ titleKey: "player.stats.section-enhancement", rows: enhancementRows },
		{ titleKey: "player.stats.section-device", rows: deviceRows },
	];
}

let gpuNamePromise: Promise<string | null> | null = null;

/** The GPU name behind WebGPU, resolved once per page. */
function resolveGpuName(): Promise<string | null> {
	if (!gpuNamePromise) {
		gpuNamePromise = (async () => {
			try {
				const gpu = navigator.gpu;
				if (!gpu) {
					return null;
				}
				const adapter = await gpu.requestAdapter();
				const info = adapter?.info;
				if (!info) {
					return null;
				}
				const parts = [
					info.vendor,
					info.architecture,
					info.device,
					info.description,
				].filter(part => !!part);
				return parts.length > 0 ? parts.join(" ") : null;
			} catch {
				return null;
			}
		})();
	}
	return gpuNamePromise;
}

/**
 * Live playback statistics for the details panel. Sampling only runs while the panel
 * is open, so a closed panel costs nothing.
 */
export function usePlayerStats(
	getVideo: () => HTMLVideoElement | undefined,
	isActive: () => boolean,
): { sections: Ref<PlayerStatsSection[]> } {
	const store = useStore();
	const sections = ref<PlayerStatsSection[]>([]);

	let timer: ReturnType<typeof setInterval> | undefined;
	let fpsFrame = 0;
	let fpsCount = 0;
	let fpsStart = 0;
	let measuredFps: number | null = null;
	let gpuName: string | null = null;

	const input = (): PlayerStatsInput => {
		const room = store.state.room;
		return {
			video: getVideo(),
			measuredFps,
			now: Date.now(),
			room: {
				isPlaying: room.isPlaying,
				playbackPosition: room.playbackPosition,
				playbackStartTimeMs: room.playbackStartTime
					? room.playbackStartTime.valueOf()
					: null,
				playbackSpeed: room.playbackSpeed,
				sourceId: room.currentSource?.id,
				sourceService: room.currentSource?.service,
			},
			settings: {
				upscaleMode: store.state.settings.upscaleMode,
				upscaleScale: store.state.settings.upscaleScale,
				upscaleAutoDegrade: store.state.settings.upscaleAutoDegrade,
			},
			device: {
				dpr: typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1,
				viewportWidth: typeof window !== "undefined" ? window.innerWidth : 0,
				viewportHeight: typeof window !== "undefined" ? window.innerHeight : 0,
				webgpu: typeof navigator !== "undefined" && "gpu" in navigator,
				gpuName,
			},
		};
	};

	function stopFpsWindow() {
		const video = getVideo();
		if (video && fpsFrame) {
			video.cancelVideoFrameCallback?.(fpsFrame);
		}
		fpsFrame = 0;
	}

	function startFpsWindow() {
		const video = getVideo();
		if (!video || typeof video.requestVideoFrameCallback !== "function") {
			measuredFps = null;
			return;
		}
		fpsCount = 0;
		fpsStart = performance.now();
		const tick = () => {
			fpsCount++;
			if (fpsFrame) {
				fpsFrame = video.requestVideoFrameCallback(tick);
			}
		};
		fpsFrame = video.requestVideoFrameCallback(tick);
	}

	function refresh() {
		if (fpsStart > 0) {
			const elapsed = performance.now() - fpsStart;
			measuredFps = fpsCount > 0 && elapsed > 0 ? (fpsCount * 1000) / elapsed : null;
		}
		sections.value = collectPlayerStats(input());
	}

	function stop() {
		if (timer !== undefined) {
			clearInterval(timer);
			timer = undefined;
		}
		stopFpsWindow();
		measuredFps = null;
	}

	function start() {
		stop();
		void resolveGpuName().then(name => {
			gpuName = name;
		});
		sections.value = collectPlayerStats(input());
		startFpsWindow();
		timer = setInterval(() => {
			refresh();
			stopFpsWindow();
			startFpsWindow();
		}, 1000);
	}

	watch(isActive, active => (active ? start() : stop()), { immediate: true });
	onBeforeUnmount(stop);

	return { sections };
}
