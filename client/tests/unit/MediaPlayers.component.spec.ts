import { flushPromises, type VueWrapper } from "@vue/test-utils";
import { nextTick } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Hls from "hls.js";
import { PlayerStatus } from "ott-common/models/types";
import type { QueueItem } from "ott-common/models/video";
import DirectPlayer from "@/components/players/DirectPlayer.vue";
import HlsPlayer from "@/components/players/HlsPlayer.vue";
import OmniPlayer from "@/components/players/OmniPlayer.vue";
import type { MediaPlayer } from "@/components/composables/media-player";
import { mountComponent } from "./component-test-utils";

interface HlsDouble {
	config: { maxBufferLength: number; maxMaxBufferLength: number; backBufferLength: number };
	levels: { width: number; height: number }[];
	listeners: Map<string, (event: string, data: unknown) => void>;
	loadSource: ReturnType<typeof vi.fn>;
	startLoad: ReturnType<typeof vi.fn>;
	recoverMediaError: ReturnType<typeof vi.fn>;
	destroy: ReturnType<typeof vi.fn>;
}

const hlsMock = vi.hoisted(() => ({ supported: true, instances: [] as HlsDouble[] }));

vi.mock("hls.js", () => ({
	default: class {
		static isSupported = () => hlsMock.supported;
		static Events = {
			MANIFEST_PARSED: "manifest",
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
		loadSource = vi.fn();
		attachMedia = vi.fn();
		startLoad = vi.fn();
		stopLoad = vi.fn();
		recoverMediaError = vi.fn();
		destroy = vi.fn();
		constructor(public config: HlsDouble["config"]) {
			hlsMock.instances.push(this);
		}
		on(event: string, handler: (event: string, data: unknown) => void) {
			this.listeners.set(event, handler);
		}
	},
}));

vi.mock("@/components/composables/media-audio-boost", () => ({
	useMediaAudioBoost: () => ({ setBoost: vi.fn(), resetFailedSetup: vi.fn() }),
}));

interface VideoState {
	paused: boolean;
	readyState: number;
	error: MediaError | null;
}

const directProps = {
	service: "direct",
	videoUrl: "https://media.example/episode.mp4",
	videoMime: "video/mp4",
};
const originalMediaError = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, "error");

describe("native and HLS player reliability", () => {
	let wrapper: VueWrapper | undefined;
	let videoStates: WeakMap<HTMLMediaElement, VideoState>;

	function state(video: HTMLMediaElement) {
		let value = videoStates.get(video);
		if (!value) {
			value = { paused: true, readyState: 0, error: null };
			videoStates.set(video, value);
		}
		return value;
	}

	beforeEach(() => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		videoStates = new WeakMap();
		hlsMock.instances.length = 0;
		hlsMock.supported = true;
		vi.spyOn(console, "warn").mockImplementation(() => undefined);
		vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(function (
			this: HTMLMediaElement,
		) {
			Object.assign(state(this), { readyState: 0, error: null, paused: true });
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
		vi.spyOn(HTMLMediaElement.prototype, "paused", "get").mockImplementation(function (
			this: HTMLMediaElement,
		) {
			return state(this).paused;
		});
		vi.spyOn(HTMLMediaElement.prototype, "readyState", "get").mockImplementation(function (
			this: HTMLMediaElement,
		) {
			return state(this).readyState;
		});
		Object.defineProperty(HTMLMediaElement.prototype, "error", {
			configurable: true,
			get(this: HTMLMediaElement) {
				return state(this).error;
			},
		});
		vi.spyOn(HTMLMediaElement.prototype, "duration", "get").mockReturnValue(1800);
		vi.spyOn(HTMLMediaElement.prototype, "canPlayType").mockReturnValue("");
	});

	afterEach(() => {
		wrapper?.unmount();
		wrapper = undefined;
		vi.restoreAllMocks();
		if (originalMediaError) {
			Object.defineProperty(HTMLMediaElement.prototype, "error", originalMediaError);
		} else {
			Reflect.deleteProperty(HTMLMediaElement.prototype, "error");
		}
		vi.unstubAllGlobals();
		vi.useRealTimers();
	});

	async function playable(target: Pick<VueWrapper, "get">) {
		const video = target.get("video").element as HTMLVideoElement;
		state(video).error = null;
		state(video).readyState = 4;
		await target.get("video").trigger("canplay");
		return video;
	}

	async function nativeError(target: Pick<VueWrapper, "get">, code: number) {
		const video = target.get("video").element as HTMLVideoElement;
		state(video).error = { code, message: "test media error" } as MediaError;
		state(video).readyState = 2;
		await target.get("video").trigger("error");
	}

	function hlsError(engine: HlsDouble, type: string, response?: { code: number }) {
		engine.listeners.get(Hls.Events.ERROR)?.(Hls.Events.ERROR, {
			fatal: true,
			type,
			details: "test failure",
			response,
		});
	}

	it("starts MP4 loading on play before canplay and passes autoplay rejection back to the caller", async () => {
		({ wrapper } = mountComponent(DirectPlayer, { props: directProps }));
		const video = wrapper.get("video").element as HTMLVideoElement;
		const api = wrapper.vm.$.exposed as MediaPlayer;
		const blocked = new DOMException("A user gesture is required", "NotAllowedError");
		vi.mocked(video.play).mockRejectedValueOnce(blocked);
		expect(video.readyState).toBe(0);
		await expect(api.play()).rejects.toBe(blocked);
		expect(video.play).toHaveBeenCalledOnce();
		expect(wrapper.emitted("ready")).toBeUndefined();
		await api.play();
		expect(video.play).toHaveBeenCalledTimes(2);
		expect(video.paused).toBe(false);
	});

	it("reloads a failed MP4 at its saved position and keeps a pause received during recovery", async () => {
		({ wrapper } = mountComponent(DirectPlayer, { props: directProps }));
		const video = await playable(wrapper);
		const api = wrapper.vm.$.exposed as MediaPlayer;
		expect(video.play).not.toHaveBeenCalled();
		await api.play();
		video.currentTime = 148.5;
		await nativeError(wrapper, 2);
		expect(wrapper.emitted("error")).toBeUndefined();
		expect(api.isRecovering?.()).toBe(true);
		api.pause();
		const loads = vi.mocked(video.load).mock.calls.length;
		await vi.advanceTimersByTimeAsync(1000);
		expect(video.load).toHaveBeenCalledTimes(loads + 1);
		expect(video.currentTime).toBe(0);
		await playable(wrapper);
		expect(api.getPosition()).toBe(148.5);
		expect(video.paused).toBe(true);
		expect(video.play).toHaveBeenCalledTimes(1);
		expect(wrapper.emitted("ready")).toHaveLength(2);
	});

	it("does not call a stalled download buffering when the MP4 still has playable data", async () => {
		({ wrapper } = mountComponent(DirectPlayer, { props: directProps }));
		const video = await playable(wrapper);
		await (wrapper.vm.$.exposed as MediaPlayer).play();
		const count = wrapper.emitted("buffering")?.length ?? 0;
		await wrapper.get("video").trigger("stalled");
		expect(wrapper.emitted("buffering")).toHaveLength(count);
		state(video).readyState = 2;
		await wrapper.get("video").trigger("waiting");
		expect(wrapper.emitted("buffering")).toHaveLength(count + 1);
	});

	it("aborts an old manifest request and ignores its late response after source change", async () => {
		const pending: ((response: Response) => void)[] = [];
		const fetchMock = vi.fn(
			(_url: string, _options: RequestInit) =>
				new Promise<Response>(resolve => pending.push(resolve)),
		);
		vi.stubGlobal("fetch", fetchMock);
		({ wrapper } = mountComponent(DirectPlayer, {
			props: {
				...directProps,
				videoUrl: "https://media.example/old.json",
				videoMime: "application/json",
			},
		}));
		const oldSignal = fetchMock.mock.calls[0][1].signal;
		await wrapper.setProps({ videoUrl: "https://media.example/new.json" });
		expect(oldSignal?.aborted).toBe(true);
		const manifest = (url: string) =>
			({
				ok: true,
				json: async () => ({
					title: "Episode",
					duration: 1800,
					sources: [{ url, contentType: "video/mp4", quality: 720 }],
				}),
			}) as Response;
		pending[1](manifest("https://media.example/new.mp4"));
		await flushPromises();
		pending[0](manifest("https://media.example/old.mp4"));
		await flushPromises();
		expect(wrapper.get("video").attributes("src")).toBe("https://media.example/new.mp4");
		expect(wrapper.emitted("error")).toBeUndefined();
	});

	it("cancels a queued MP4 retry on source change and removes its request on unmount", async () => {
		({ wrapper } = mountComponent(DirectPlayer, { props: directProps }));
		await playable(wrapper);
		await nativeError(wrapper, 2);
		await wrapper.setProps({ videoUrl: "https://media.example/next.mp4" });
		const video = wrapper.get("video").element as HTMLVideoElement;
		const loads = vi.mocked(video.load).mock.calls.length;
		await vi.advanceTimersByTimeAsync(6000);
		expect(video.load).toHaveBeenCalledTimes(loads);
		expect(video.src).toBe("https://media.example/next.mp4");
		wrapper.unmount();
		expect(video.hasAttribute("src")).toBe(false);
		expect(video.paused).toBe(true);
	});

	it("applies HLS buffer preferences without reloading and waits for playable data before ready", async () => {
		const page = mountComponent(HlsPlayer, {
			props: { videoUrl: "https://media.example/episode.m3u8" },
		});
		wrapper = page.wrapper;
		const engine = hlsMock.instances[0];
		expect(engine.config).toEqual({
			maxBufferLength: 60,
			maxMaxBufferLength: 60,
			backBufferLength: 30,
		});
		engine.listeners.get(Hls.Events.MANIFEST_PARSED)?.(Hls.Events.MANIFEST_PARSED, {});
		expect(wrapper.emitted("ready")).toBeUndefined();
		await playable(wrapper);
		expect(wrapper.emitted("ready")).toHaveLength(1);
		page.store.commit("settings/UPDATE", { hlsBufferSeconds: 120 });
		await nextTick();
		expect(engine.config.maxBufferLength).toBe(120);
		expect(engine.config.maxMaxBufferLength).toBe(120);
		expect(hlsMock.instances).toHaveLength(1);
	});

	it("uses HLS network restart and decoder recovery separately and bounds repeated decoder errors", async () => {
		({ wrapper } = mountComponent(HlsPlayer, {
			props: { videoUrl: "https://media.example/episode.m3u8" },
		}));
		const video = await playable(wrapper);
		const engine = hlsMock.instances[0];
		video.currentTime = 72;
		hlsError(engine, Hls.ErrorTypes.NETWORK_ERROR);
		await vi.advanceTimersByTimeAsync(1000);
		expect(engine.startLoad).toHaveBeenCalledWith(72);
		expect(engine.recoverMediaError).not.toHaveBeenCalled();
		await playable(wrapper);
		hlsError(engine, Hls.ErrorTypes.MEDIA_ERROR);
		await vi.advanceTimersByTimeAsync(1000);
		expect(engine.recoverMediaError).toHaveBeenCalledOnce();
		hlsError(engine, Hls.ErrorTypes.MEDIA_ERROR);
		expect(wrapper.emitted("error")?.[0]).toEqual([{ type: "decode", retryable: true }]);
		await vi.advanceTimersByTimeAsync(120000);
		expect(engine.recoverMediaError).toHaveBeenCalledOnce();
	});

	it("reloads an HLS manifest if it never loaded, while denied sources fail without a retry loop", async () => {
		({ wrapper } = mountComponent(HlsPlayer, {
			props: { videoUrl: "https://media.example/episode.m3u8" },
		}));
		const engine = hlsMock.instances[0];
		engine.levels = [];
		hlsError(engine, Hls.ErrorTypes.NETWORK_ERROR);
		await vi.advanceTimersByTimeAsync(1000);
		expect(engine.loadSource).toHaveBeenCalledTimes(2);
		hlsError(engine, Hls.ErrorTypes.NETWORK_ERROR, { code: 403 });
		expect(wrapper.emitted("error")?.[0]).toEqual([{ type: "network", retryable: false }]);
		await vi.advanceTimersByTimeAsync(120000);
		expect(engine.startLoad).toHaveBeenCalledTimes(1);
	});

	it("recovers a native HLS decoder failure even without a matching hls.js error", async () => {
		({ wrapper } = mountComponent(HlsPlayer, {
			props: { videoUrl: "https://media.example/episode.m3u8" },
		}));
		await playable(wrapper);
		const engine = hlsMock.instances[0];
		await nativeError(wrapper, 3);
		await vi.advanceTimersByTimeAsync(1000);
		expect(engine.recoverMediaError).toHaveBeenCalledOnce();
		expect(wrapper.emitted("error")).toBeUndefined();
	});

	it("destroys an old HLS engine and ignores both pending retries and late engine errors", async () => {
		({ wrapper } = mountComponent(HlsPlayer, {
			props: { videoUrl: "https://media.example/episode.m3u8" },
		}));
		const engine = hlsMock.instances[0];
		hlsError(engine, Hls.ErrorTypes.NETWORK_ERROR);
		await wrapper.setProps({ videoUrl: "https://media.example/next.m3u8" });
		expect(engine.destroy).toHaveBeenCalledOnce();
		hlsError(engine, Hls.ErrorTypes.MEDIA_ERROR);
		await vi.advanceTimersByTimeAsync(6000);
		expect(engine.startLoad).not.toHaveBeenCalled();
		expect(engine.recoverMediaError).not.toHaveBeenCalled();
		expect(wrapper.emitted("error")).toBeUndefined();
		wrapper.unmount();
		expect(hlsMock.instances[1].destroy).toHaveBeenCalledOnce();
	});

	it("uses native HLS when MSE is unavailable, and handles its native network errors", async () => {
		hlsMock.supported = false;
		vi.mocked(HTMLMediaElement.prototype.canPlayType).mockReturnValue("maybe");
		({ wrapper } = mountComponent(HlsPlayer, {
			props: { videoUrl: "https://media.example/episode.m3u8" },
		}));
		expect(hlsMock.instances).toHaveLength(0);
		expect(wrapper.get("video").attributes("src")).toBe("https://media.example/episode.m3u8");
		const video = await playable(wrapper);
		video.currentTime = 90;
		await nativeError(wrapper, 2);
		await vi.advanceTimersByTimeAsync(1000);
		await playable(wrapper);
		expect(video.currentTime).toBe(90);
		expect(wrapper.emitted("error")).toBeUndefined();
	});

	it("offers a local reload after failure without changing room playback or sending a room request", async () => {
		const source: QueueItem = {
			service: "direct",
			id: directProps.videoUrl,
			mime: "video/mp4",
		};
		const page = mountComponent(OmniPlayer, { props: { source } });
		wrapper = page.wrapper;
		await flushPromises();
		await nextTick();
		const direct = wrapper.getComponent(DirectPlayer);
		const video = await playable(direct);
		video.currentTime = 156;
		page.store.state.room.isPlaying = false;
		page.store.state.room.playbackPosition = 156;
		await nativeError(direct, 4);
		expect(page.store.state.playerStatus).toBe(PlayerStatus.error);
		expect(wrapper.text()).toContain("不支持的视频或来源");
		await wrapper.get('[data-cy="retry-local-media"]').trigger("click");
		expect(page.store.state.playerStatus).toBe(PlayerStatus.buffering);
		await playable(direct);
		expect(video.currentTime).toBe(156);
		expect(video.paused).toBe(true);
		expect(page.store.state.room.isPlaying).toBe(false);
		expect(page.store.state.room.playbackPosition).toBe(156);
		expect(page.connection.sent).toEqual([]);
		expect(wrapper.find('[data-cy="retry-local-media"]').exists()).toBe(false);
		const readyCount = wrapper.emitted("apiready")?.length ?? 0;
		await wrapper.setProps({ source: { ...source, id: "https://media.example/next.mp4" } });
		await flushPromises();
		expect(wrapper.emitted("apiready")!.length).toBeGreaterThan(readyCount);
	});
});
