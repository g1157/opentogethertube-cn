import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import InfoExtractor from "../../infoextractor.js";
import { ServiceAdapter } from "../../serviceadapter.js";
import DirectVideoAdapter from "../../services/direct.js";
import * as ffprobe from "../../ffprobe.js";
import * as mediaAccess from "../../services/media-access.js";
import storage from "../../storage.js";
import type {
	QueueItemExtras,
	Video,
	VideoId,
	VideoMetadata,
	VideoService,
} from "ott-common/models/video.js";

const ID = "https://example.invalid/movie.mp4";
const FIELDS: (keyof VideoMetadata)[] = ["title", "description", "length", "thumbnail", "mime"];
const FALSY_FIELDS = [
	["cors", false],
	["isLive", false],
	["length", 0],
] as const;

function fetchedVideo(service: VideoService = "direct"): Video {
	return {
		service,
		id: ID,
		title: "fresh title",
		description: "fresh description",
		length: 45,
		thumbnail: "https://example.invalid/fresh.jpg",
		mime: "video/mp4",
	};
}

class MetadataAdapter extends ServiceAdapter {
	constructor(
		private readonly service: VideoService,
		private readonly cacheSafe: boolean,
		public response: Video = fetchedVideo(service),
	) {
		super();
	}
	get serviceId(): VideoService {
		return this.service;
	}
	get isCacheSafe(): boolean {
		return this.cacheSafe;
	}
	async fetchVideoInfo(): Promise<Video> {
		return { ...this.response };
	}
}

describe.each(["single", "batch"] as const)("fetched falsy metadata via %s extraction", mode => {
	let source: Video & QueueItemExtras;
	let adapter: MetadataAdapter;
	let adapters: Map<VideoService, ServiceAdapter>;

	beforeEach(() => {
		// Missing description forces a metadata refresh even for a cache-safe service.
		source = {
			service: "direct",
			id: ID,
			title: "cached title",
			length: 120,
			thumbnail: "https://example.invalid/cached.jpg",
			mime: "video/mp4",
			cors: true,
			isLive: true,
		};
		adapter = new MetadataAdapter("direct", false);
		adapters = new Map([["direct", adapter]]);
		vi.spyOn(InfoExtractor, "getServiceAdapter").mockImplementation(service => {
			const selected = adapters.get(service as VideoService);
			if (!selected) {
				throw new Error("Missing test adapter: " + service);
			}
			return selected;
		});
		vi.spyOn(storage, "getVideoInfoFields").mockReturnValue([...FIELDS]);
		vi.spyOn(storage, "getVideoInfo").mockImplementation(async (service, id) => ({
			...source,
			service,
			id,
		}));
		vi.spyOn(storage, "getManyVideoInfo").mockImplementation(async (ids: VideoId[]) =>
			ids.map(({ service, id }) => ({ ...source, service, id })),
		);
		vi.spyOn(InfoExtractor, "updateCache").mockResolvedValue(undefined);
	});
	afterEach(() => {
		vi.restoreAllMocks();
	});

	async function extract(): Promise<Video> {
		if (mode === "single") {
			return InfoExtractor.getVideoInfo(source.service, source.id);
		}
		const videos = await InfoExtractor.getManyVideoInfo([source]);
		expect(videos).toHaveLength(1);
		return videos[0];
	}

	it.each(FALSY_FIELDS)("preserves fetched %s=%s over the old value", async (field, value) => {
		adapter.response = { ...adapter.response, [field]: value };
		const video = await extract();
		expect(video[field]).toBe(value);
		expect(video.title).toBe("fresh title");
	});

	it("preserves a new cors:false verdict when no previous verdict exists", async () => {
		delete source.cors;
		adapter.response.cors = false;
		expect(await extract()).toHaveProperty("cors", false);
	});

	it("keeps the existing fallback for undefined, null and empty-string metadata", async () => {
		adapter.response = {
			...adapter.response,
			title: "",
			description: undefined,
			thumbnail: null,
			length: undefined,
			cors: undefined,
		} as unknown as Video;
		const video = await extract();
		expect(video).toMatchObject({
			title: "cached title",
			thumbnail: "https://example.invalid/cached.jpg",
			length: 120,
			cors: true,
		});
		expect(video.description).toBeUndefined();
	});

	it("keeps the real Direct adapter's negative CORS verdict", async () => {
		adapters.set("direct", new DirectVideoAdapter());
		vi.spyOn(ffprobe, "probeMediaInfo").mockResolvedValue({
			format: { duration: "10", format_name: "mp4" },
			streams: [{ codec_type: "video", width: 320, height: 180 }],
		});
		const access = vi.spyOn(mediaAccess, "probeMediaAccess").mockResolvedValue({ cors: false });
		const video = await extract();
		expect(video).toMatchObject({ cors: false, length: 10, mime: "video/mp4" });
		expect(access).toHaveBeenCalledTimes(1);
	});

	it("passes explicit false and zero to the cache update hook for cache-safe services", async () => {
		source.service = "youtube";
		adapter = new MetadataAdapter("youtube", true, {
			...fetchedVideo("youtube"),
			cors: false,
			isLive: false,
			length: 0,
		});
		adapters.set("youtube", adapter);
		const video = await extract();
		const expected = expect.objectContaining({
			service: "youtube",
			cors: false,
			isLive: false,
			length: 0,
		});
		expect(video).toMatchObject({ cors: false, isLive: false, length: 0 });
		expect(InfoExtractor.updateCache).toHaveBeenCalledWith(
			mode === "single" ? expected : [expected],
		);
	});

	if (mode === "batch") {
		it("retains caller queue extras and leaves the caller object unchanged", async () => {
			source.startAt = 0;
			source.endAt = 20;
			source.subtitleUrl = "https://example.invalid/subtitle.vtt";
			const original = { ...source };
			adapter.response.cors = false;
			const video = await extract();
			expect(video).toMatchObject({ startAt: 0, endAt: 20, subtitleUrl: source.subtitleUrl });
			expect(source).toEqual(original);
		});

		it("preserves explicit false and zero through original-ID alias mapping", async () => {
			adapter.response = {
				...fetchedVideo("hls"),
				id: "https://example.invalid/canonical.m3u8",
				cors: false,
				isLive: false,
				length: 0,
			};
			adapters.set("hls", new MetadataAdapter("hls", false, adapter.response));
			expect(await extract()).toMatchObject({
				service: "hls",
				id: "https://example.invalid/canonical.m3u8",
				cors: false,
				isLive: false,
				length: 0,
			});
		});
	}
});
