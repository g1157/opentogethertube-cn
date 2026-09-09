import type { VueWrapper } from "@vue/test-utils";
import type { Component } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Hls from "hls.js";
import { MediaPlayer as DashSdk } from "dashjs";
import DirectPlayer from "@/components/players/DirectPlayer.vue";
import HlsPlayer from "@/components/players/HlsPlayer.vue";
import DashPlayer from "@/components/players/DashPlayer.vue";
import type { MediaPlayer } from "@/components/composables/media-player";
import type { MediaLoadingState } from "@/util/media-loading-state";
import { mountComponent } from "./component-test-utils";

interface HlsDouble {
	listeners: Map<string, (event: string, data: unknown) => void>;
	destroy: ReturnType<typeof vi.fn>;
}

interface DashDouble {
	listeners: Map<string, (event?: unknown) => void>;
	tracks: Record<string, unknown[]>;
	initialize: ReturnType<typeof vi.fn>;
	destroy: ReturnType<typeof vi.fn>;
}

const hlsMock = vi.hoisted(() => ({ supported: true, instances: [] as HlsDouble[] }));
const dashMock = vi.hoisted(() => ({ instances: [] as DashDouble[] }));

vi.mock("hls.js", () => ({
	default: class {
		static isSupported = () => hlsMock.supported;
		static Events = {
			MANIFEST_PARSED: "manifest",
			BUFFER_CREATED: "buffers",
			ERROR: "error",
			INIT_PTS_FOUND: "pts",
			LEVEL_SWITCHED: "level",
		};
		static ErrorTypes = { NETWORK_ERROR: "networkError", MEDIA_ERROR: "mediaError" };
		levels = [{ width: 1280, height: 720 }];
		subtitleTracks = [];
		subtitleTrack = -1;
		autoLevelEnabled = true;
		currentLevel = 0;
		listeners = new Map<string, (event: string, data: unknown) => void>();
		source = "";
		loadSource = vi.fn((url: string) => {
			this.source = url;
		});
		attachMedia = vi.fn((media: HTMLVideoElement) => {
			media.src = this.source;
			media.load();
		});
		startLoad = vi.fn();
		stopLoad = vi.fn();
		recoverMediaError = vi.fn();
		destroy = vi.fn();
		constructor(
			public config: {
				maxBufferLength: number;
				maxMaxBufferLength: number;
				backBufferLength: number;
			},
		) {
			hlsMock.instances.push(this);
		}
		on(event: string, handler: (event: string, data: unknown) => void) {
			this.listeners.set(event, handler);
		}
	},
}));

vi.mock("dashjs", () => {
	class DashDoubleImpl {
		listeners = new Map<string, (event?: unknown) => void>();
		tracks: Record<string, unknown[]> = { video: [{}], audio: [{}], text: [] };
		initialize = vi.fn((media: HTMLVideoElement, url: string, autoplay: boolean) => {
			media.src = url;
			media.load();
			if (autoplay) {
				void media.play();
			}
		});
		attachTTMLRenderingDiv = vi.fn();
		updateSettings = vi.fn();
		getTracksFor = vi.fn((type: string) => this.tracks[type] ?? []);
		getRepresentationsByType = vi.fn(() => []);
		getCurrentRepresentationForType = vi.fn(() => ({ index: 0 }));
		getCurrentTextTrackIndex = vi.fn(() => -1);
		getSettings = vi.fn(() => ({
			streaming: { abr: { autoSwitchBitrate: { video: true } } },
		}));
		setTextTrack = vi.fn();
		destroy = vi.fn();
		constructor() {
			dashMock.instances.push(this);
		}
		on(event: string, handler: (event?: unknown) => void) {
			this.listeners.set(event, handler);
		}
	}
	return {
		MediaPlayer: Object.assign(() => ({ create: () => new DashDoubleImpl() }), {
			events: {
				MANIFEST_LOADED: "manifest",
				TEXT_TRACKS_ADDED: "text",
				ERROR: "error",
				STREAM_INITIALIZED: "stream",
				BUFFER_EMPTY: "empty",
				BUFFER_LOADED: "loaded",
				QUALITY_CHANGE_RENDERED: "quality",
			},
		}),
	};
});

vi.mock("@/components/composables/media-audio-boost", () => ({
	useMediaAudioBoost: () => ({ setBoost: vi.fn(), resetFailedSetup: vi.fn() }),
}));

interface VideoState {
	paused: boolean;
	readyState: number;
	seeking: boolean;
	videoWidth: number;
	videoHeight: number;
	buffered: TimeRanges;
	error: MediaError | null;
}

interface PlayerFixture {
	name: string;
	component: Component;
	props: { videoUrl: string; service?: string; videoMime?: string };
	nextVideoUrl: string;
}

const players: PlayerFixture[] = [
	{
		name: "MP4",
		component: DirectPlayer,
		props: {
			service: "direct",
			videoUrl: "https://media.example/episode.mp4",
			videoMime: "video/mp4",
		},
		nextVideoUrl: "https://media.example/next.mp4",
	},
	{
		name: "HLS",
		component: HlsPlayer,
		props: { videoUrl: "https://media.example/episode.m3u8" },
		nextVideoUrl: "https://media.example/next.m3u8",
	},
	{
		name: "DASH",
		component: DashPlayer,
		props: { videoUrl: "https://media.example/episode.mpd" },
		nextVideoUrl: "https://media.example/next.mpd",
	},
];

const originalMediaError = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, "error");
const originalFrameMethods = new Map(
	["requestVideoFrameCallback", "cancelVideoFrameCallback"].map(
		name => [name, Object.getOwnPropertyDescriptor(HTMLVideoElement.prototype, name)] as const,
	),
);

function ranges(values: [number, number][]): TimeRanges {
	return {
		length: values.length,
		start: index => values[index][0],
		end: index => values[index][1],
	};
}

describe("native player loading-state integration", () => {
	let wrapper: VueWrapper | undefined;
	let videoStates: WeakMap<HTMLMediaElement, VideoState>;
	let frames: Map<number, { video: HTMLVideoElement; callback: VideoFrameRequestCallback }>;
	let nextFrameId: number;

	function state(video: HTMLMediaElement): VideoState {
		let value = videoStates.get(video);
		if (!value) {
			value = {
				paused: true,
				readyState: 0,
				seeking: false,
				videoWidth: 0,
				videoHeight: 0,
				buffered: ranges([]),
				error: null,
			};
			videoStates.set(video, value);
		}
		return value;
	}

	beforeEach(() => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		videoStates = new WeakMap();
		frames = new Map();
		nextFrameId = 0;
		hlsMock.supported = true;
		hlsMock.instances.length = 0;
		dashMock.instances.length = 0;
		vi.spyOn(console, "log").mockImplementation(() => undefined);
		vi.spyOn(console, "info").mockImplementation(() => undefined);
		vi.spyOn(document, "hidden", "get").mockReturnValue(false);
		vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Unexpected test request")));
		vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(function (
			this: HTMLMediaElement,
		) {
			videoStates.delete(this);
			this.currentTime = 0;
		});
		vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(function (
			this: HTMLMediaElement,
		) {
			state(this).paused = false;
			return Promise.resolve();
		});
		vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(function (
			this: HTMLMediaElement,
		) {
			state(this).paused = true;
		});
		for (const key of ["paused", "readyState", "seeking", "buffered"] as const) {
			vi.spyOn(HTMLMediaElement.prototype, key, "get").mockImplementation(function (
				this: HTMLMediaElement,
			) {
				return state(this)[key];
			});
		}
		for (const key of ["videoWidth", "videoHeight"] as const) {
			vi.spyOn(HTMLVideoElement.prototype, key, "get").mockImplementation(function (
				this: HTMLVideoElement,
			) {
				return state(this)[key];
			});
		}
		Object.defineProperty(HTMLMediaElement.prototype, "error", {
			configurable: true,
			get(this: HTMLMediaElement) {
				return state(this).error;
			},
		});
		Object.defineProperties(HTMLVideoElement.prototype, {
			requestVideoFrameCallback: {
				configurable: true,
				value: vi.fn(function (
					this: HTMLVideoElement,
					callback: VideoFrameRequestCallback,
				) {
					frames.set(++nextFrameId, { video: this, callback });
					return nextFrameId;
				}),
			},
			cancelVideoFrameCallback: {
				configurable: true,
				// Retain callbacks to simulate delivery already queued before cancellation.
				value: vi.fn(),
			},
		});
		vi.spyOn(HTMLMediaElement.prototype, "duration", "get").mockReturnValue(1800);
		vi.spyOn(HTMLMediaElement.prototype, "canPlayType").mockReturnValue("");
	});

	afterEach(() => {
		wrapper?.unmount();
		wrapper = undefined;
		vi.restoreAllMocks();
		for (const [name, descriptor] of originalFrameMethods) {
			if (descriptor) {
				Object.defineProperty(HTMLVideoElement.prototype, name, descriptor);
			} else {
				Reflect.deleteProperty(HTMLVideoElement.prototype, name);
			}
		}
		if (originalMediaError) {
			Object.defineProperty(HTMLMediaElement.prototype, "error", originalMediaError);
		} else {
			Reflect.deleteProperty(HTMLMediaElement.prototype, "error");
		}
		vi.unstubAllGlobals();
		vi.useRealTimers();
	});

	function mountPlayer(fixture: PlayerFixture) {
		({ wrapper } = mountComponent(fixture.component, { props: fixture.props }));
		return {
			wrapper,
			video: wrapper.get("video").element as HTMLVideoElement,
			api: wrapper.vm.$.exposed as MediaPlayer,
		};
	}

	function latest(target: VueWrapper): MediaLoadingState {
		const events = target.emitted("loading-state");
		expect(events?.length).toBeGreaterThan(0);
		return events!.at(-1)![0] as MediaLoadingState;
	}

	function currentFrame(video: HTMLVideoElement): number {
		const request = [...frames.entries()].filter(([, frame]) => frame.video === video).at(-1);
		expect(request).toBeDefined();
		return request![0];
	}

	function presentFrame(id: number, mediaTime?: number) {
		const frame = frames.get(id)!;
		frame.callback(0, {
			mediaTime: mediaTime ?? frame.video.currentTime,
			width: 1280,
			height: 720,
			presentedFrames: 1,
			expectedDisplayTime: 0,
			presentationTime: 0,
		});
	}

	async function makePlayable(target: ReturnType<typeof mountPlayer>, position = 310) {
		target.api.setPosition(position);
		state(target.video).readyState = 1;
		await target.wrapper.get("video").trigger("loadedmetadata");
		dashMock.instances.at(-1)?.listeners.get(DashSdk.events.STREAM_INITIALIZED)?.();
		Object.assign(state(target.video), {
			readyState: 4,
			videoWidth: 1280,
			videoHeight: 720,
			buffered: ranges([
				[0, 100],
				[300, 350],
				[1000, 1100],
			]),
		});
		await target.wrapper.get("video").trigger("canplay");
	}

	describe.each(players)("$name", fixture => {
		it("keeps waiting after ready, playing and time progression until a frame is presented", async () => {
			const target = mountPlayer(fixture);
			expect(latest(target.wrapper).phase).toBe("preparing");
			await makePlayable(target);
			expect(target.wrapper.emitted("ready")?.length).toBeGreaterThan(0);
			expect(target.video.play).not.toHaveBeenCalled();
			await target.api.play();
			await target.wrapper.get("video").trigger("playing");
			target.video.currentTime = 311;
			await target.wrapper.get("video").trigger("timeupdate");
			expect(target.wrapper.emitted("playing")?.length).toBeGreaterThan(0);
			expect(latest(target.wrapper)).toEqual({
				phase: "waiting-frame",
				currentTime: 311,
				bufferAhead: 39,
			});
			presentFrame(currentFrame(target.video));
			expect(latest(target.wrapper).phase).toBeNull();
			expect(target.video.currentTime).toBe(311);
			expect(target.video.play).toHaveBeenCalledOnce();
		});

		it("ignores a queued old-source frame and waits for the replacement source's frame", async () => {
			const target = mountPlayer(fixture);
			await makePlayable(target);
			const oldFrame = currentFrame(target.video);
			await target.wrapper.setProps({ videoUrl: fixture.nextVideoUrl });
			expect(latest(target.wrapper).phase).toBe("preparing");
			expect(target.video.src).toBe(fixture.nextVideoUrl);
			await makePlayable(target, 320);
			const newFrame = currentFrame(target.video);
			expect(newFrame).not.toBe(oldFrame);
			// The same position alone must not make a cancelled source's frame current.
			presentFrame(oldFrame, target.video.currentTime);
			expect(latest(target.wrapper).phase).toBe("waiting-frame");
			presentFrame(newFrame);
			expect(latest(target.wrapper).phase).toBeNull();
			expect(target.video.play).not.toHaveBeenCalled();
		});
	});

	it("accepts native audio MIME data without waiting for nonexistent video frames", async () => {
		const target = mountPlayer({
			...players[0],
			props: {
				...players[0].props,
				videoUrl: "https://media.example/song.mp3",
				videoMime: "audio/mpeg",
			},
		});
		state(target.video).readyState = 2;
		await target.wrapper.get("video").trigger("loadeddata");
		expect(target.video.videoWidth).toBe(0);
		expect(latest(target.wrapper).phase).toBeNull();
		expect(target.video.requestVideoFrameCallback).not.toHaveBeenCalled();
		expect(target.video.play).not.toHaveBeenCalled();
	});

	it("uses hls.js manifest track information to recognize audio-only playback", async () => {
		const target = mountPlayer(players[1]);
		const engine = hlsMock.instances[0];
		engine.listeners.get(Hls.Events.MANIFEST_PARSED)!(Hls.Events.MANIFEST_PARSED, {
			audio: true,
			video: false,
		});
		state(target.video).readyState = 2;
		await target.wrapper.get("video").trigger("loadeddata");
		expect(target.video.videoWidth).toBe(0);
		expect(latest(target.wrapper).phase).toBeNull();
		expect(target.video.requestVideoFrameCallback).not.toHaveBeenCalled();
	});

	it("recognizes an audio-only HLS media playlist after all source buffers are created", async () => {
		const target = mountPlayer(players[1]);
		const engine = hlsMock.instances[0];
		engine.listeners.get(Hls.Events.MANIFEST_PARSED)!(Hls.Events.MANIFEST_PARSED, {
			audio: false,
			video: false,
		});
		state(target.video).readyState = 2;
		await target.wrapper.get("video").trigger("loadeddata");
		expect(latest(target.wrapper).phase).toBe("waiting-frame");
		engine.listeners.get(Hls.Events.BUFFER_CREATED)!(Hls.Events.BUFFER_CREATED, {
			tracks: { audio: {} },
		});
		expect(target.video.videoWidth).toBe(0);
		expect(latest(target.wrapper).phase).toBeNull();
		expect(target.video.cancelVideoFrameCallback).toHaveBeenCalled();
		expect(target.video.play).not.toHaveBeenCalled();
	});

	it.each([
		{ name: "separate audio/video", tracks: { audio: {}, video: {} } },
		{ name: "combined audio/video", tracks: { audiovideo: {} } },
	])("keeps waiting for a frame when HLS creates $name buffers", async ({ tracks }) => {
		const target = mountPlayer(players[1]);
		const engine = hlsMock.instances[0];
		engine.listeners.get(Hls.Events.MANIFEST_PARSED)!(Hls.Events.MANIFEST_PARSED, {
			audio: false,
			video: false,
		});
		state(target.video).readyState = 4;
		await target.wrapper.get("video").trigger("loadeddata");
		engine.listeners.get(Hls.Events.BUFFER_CREATED)!(Hls.Events.BUFFER_CREATED, { tracks });
		await target.wrapper.get("video").trigger("canplay");
		await target.wrapper.get("video").trigger("playing");
		expect(latest(target.wrapper).phase).toBe("waiting-frame");
		Object.assign(state(target.video), { videoWidth: 1280, videoHeight: 720 });
		presentFrame(currentFrame(target.video));
		expect(latest(target.wrapper).phase).toBeNull();
		expect(target.video.play).not.toHaveBeenCalled();
	});

	it("ignores buffer creation from a previous HLS engine after changing sources", async () => {
		const target = mountPlayer(players[1]);
		const oldEngine = hlsMock.instances[0];
		oldEngine.listeners.get(Hls.Events.BUFFER_CREATED)!(Hls.Events.BUFFER_CREATED, {
			tracks: { audio: {} },
		});
		state(target.video).readyState = 2;
		await target.wrapper.get("video").trigger("loadeddata");
		expect(latest(target.wrapper).phase).toBeNull();

		await target.wrapper.setProps({ videoUrl: players[1].nextVideoUrl });
		const engine = hlsMock.instances[1];
		expect(oldEngine.destroy).toHaveBeenCalledOnce();
		engine.listeners.get(Hls.Events.MANIFEST_PARSED)!(Hls.Events.MANIFEST_PARSED, {
			audio: false,
			video: false,
		});
		state(target.video).readyState = 2;
		await target.wrapper.get("video").trigger("loadeddata");
		expect(latest(target.wrapper).phase).toBe("waiting-frame");
		oldEngine.listeners.get(Hls.Events.BUFFER_CREATED)!(Hls.Events.BUFFER_CREATED, {
			tracks: { audio: {} },
		});
		expect(latest(target.wrapper).phase).toBe("waiting-frame");
		engine.listeners.get(Hls.Events.BUFFER_CREATED)!(Hls.Events.BUFFER_CREATED, {
			tracks: { audio: {} },
		});
		expect(latest(target.wrapper).phase).toBeNull();
		expect(target.video.play).not.toHaveBeenCalled();
	});

	it("uses DASH stream tracks to recognize audio-only playback", async () => {
		const target = mountPlayer(players[2]);
		const engine = dashMock.instances[0];
		engine.tracks.video = [];
		engine.listeners.get(DashSdk.events.STREAM_INITIALIZED)!();
		state(target.video).readyState = 2;
		await target.wrapper.get("video").trigger("loadeddata");
		expect(target.video.videoWidth).toBe(0);
		expect(latest(target.wrapper).phase).toBeNull();
		expect(target.video.requestVideoFrameCallback).not.toHaveBeenCalled();
	});

	it("recognizes audio-only native HLS from browser track lists", async () => {
		hlsMock.supported = false;
		vi.mocked(HTMLMediaElement.prototype.canPlayType).mockReturnValue("maybe");
		const target = mountPlayer(players[1]);
		expect(hlsMock.instances).toHaveLength(0);
		Object.defineProperties(target.video, {
			audioTracks: { value: { length: 1 } },
			videoTracks: { value: { length: 0 } },
		});
		state(target.video).readyState = 2;
		await target.wrapper.get("video").trigger("loadeddata");
		expect(latest(target.wrapper).phase).toBeNull();
		expect(target.video.play).not.toHaveBeenCalled();
	});

	it("does not autoplay DASH on source/manifest/canplay and returns a blocked explicit play to its caller", async () => {
		const target = mountPlayer(players[2]);
		const engine = dashMock.instances[0];
		expect(engine.initialize).toHaveBeenCalledWith(
			target.video,
			players[2].props.videoUrl,
			false,
		);
		engine.listeners.get(DashSdk.events.MANIFEST_LOADED)!();
		expect(target.wrapper.emitted("ready")).toHaveLength(1);
		expect(latest(target.wrapper).phase).toBe("preparing");
		expect(target.video.play).not.toHaveBeenCalled();
		await makePlayable(target);
		expect(target.video.play).not.toHaveBeenCalled();
		const blocked = new DOMException("A user gesture is required", "NotAllowedError");
		vi.mocked(target.video.play).mockRejectedValueOnce(blocked);
		await expect(target.api.play()).rejects.toBe(blocked);
		expect(target.video.play).toHaveBeenCalledOnce();
		expect(target.wrapper.emitted("error")).toBeUndefined();
		expect(latest(target.wrapper).phase).toBe("waiting-frame");
	});

	it("holds a DASH seek until both stream initialization and metadata are available", async () => {
		const target = mountPlayer(players[2]);
		target.api.setPosition(125);
		expect(target.video.currentTime).toBe(0);
		expect(target.api.isRecovering?.()).toBe(true);
		state(target.video).readyState = 1;
		await target.wrapper.get("video").trigger("loadedmetadata");
		expect(target.video.currentTime).toBe(0);
		dashMock.instances[0].listeners.get(DashSdk.events.STREAM_INITIALIZED)!();
		expect(target.video.currentTime).toBe(125);
		expect(target.api.isRecovering?.()).toBe(false);
		state(target.video).seeking = true;
		expect(target.api.isSeeking?.()).toBe(true);
	});

	it("waits for DASH to attach its source while still reporting real playback failures afterward", async () => {
		const target = mountPlayer(players[2]);
		// Real dash.js attaches MediaSource asynchronously after fetching its manifest.
		target.video.removeAttribute("src");
		const unsupported = new DOMException("This stream cannot be decoded", "NotSupportedError");
		vi.mocked(target.video.play).mockRejectedValueOnce(unsupported);
		await target.api.play();
		expect(target.video.play).not.toHaveBeenCalled();
		target.video.src = "blob:https://media.example/dash-source";
		await expect(target.api.play()).rejects.toBe(unsupported);
		expect(target.video.play).toHaveBeenCalledOnce();
	});

	it("applies only the latest DASH position when metadata arrives after initialization", async () => {
		const target = mountPlayer(players[2]);
		dashMock.instances[0].listeners.get(DashSdk.events.STREAM_INITIALIZED)!();
		target.api.setPosition(125);
		target.api.setPosition(150);
		expect(target.video.currentTime).toBe(0);
		state(target.video).readyState = 1;
		await target.wrapper.get("video").trigger("loadedmetadata");
		expect(target.video.currentTime).toBe(150);
		target.video.currentTime = 152;
		await target.wrapper.get("video").trigger("canplay");
		expect(target.video.currentTime).toBe(152);
	});

	it("discards a previous DASH source's pending seek and initialization event", async () => {
		const target = mountPlayer(players[2]);
		const oldEngine = dashMock.instances[0];
		target.api.setPosition(125);
		await target.wrapper.setProps({ videoUrl: players[2].nextVideoUrl });
		state(target.video).readyState = 1;
		await target.wrapper.get("video").trigger("loadedmetadata");
		oldEngine.listeners.get(DashSdk.events.STREAM_INITIALIZED)!();
		expect(target.api.isRecovering?.()).toBe(true);
		dashMock.instances[1].listeners.get(DashSdk.events.STREAM_INITIALIZED)!();
		expect(target.video.currentTime).toBe(0);
		expect(target.api.isRecovering?.()).toBe(false);
	});

	it("restores the current DASH position after a local retry without autoplaying", async () => {
		const target = mountPlayer(players[2]);
		await makePlayable(target, 310);
		await target.api.retry?.();
		expect(target.video.currentTime).toBe(0);
		expect(target.api.isRecovering?.()).toBe(true);
		dashMock.instances[1].listeners.get(DashSdk.events.STREAM_INITIALIZED)!();
		state(target.video).readyState = 1;
		await target.wrapper.get("video").trigger("loadedmetadata");
		expect(target.video.currentTime).toBe(310);
		expect(target.video.play).not.toHaveBeenCalled();
	});

	it("preserves the latest pending DASH seek across a retry before metadata", async () => {
		const target = mountPlayer(players[2]);
		target.api.setPosition(125);
		await target.api.retry?.();
		dashMock.instances[1].listeners.get(DashSdk.events.STREAM_INITIALIZED)!();
		state(target.video).readyState = 1;
		await target.wrapper.get("video").trigger("loadedmetadata");
		expect(target.video.currentTime).toBe(125);
		expect(target.video.play).not.toHaveBeenCalled();
	});
});
