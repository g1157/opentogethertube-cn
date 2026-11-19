import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import InfoExtractor from "../../infoextractor.js";
import DirectVideoAdapter from "../../services/direct.js";
import { ServiceAdapter } from "../../serviceadapter.js";
import storage from "../../storage.js";
import { Room } from "../../room.js";
import { buildClients, redisClient } from "../../redisclient.js";
import { UnsupportedMimeTypeException } from "../../exceptions.js";
import { CachedVideo, loadModels, sequelize } from "../../models/index.js";
import { RoomRequestType } from "ott-common/models/messages.js";
import { Role } from "ott-common/models/types.js";
import type {
	QueueItemExtras,
	Video,
	VideoId,
	VideoMetadata,
	VideoService,
} from "ott-common/models/video.js";

const LOCAL_FILE_ID = "file:///C:/private/video.mp4";
const REQUIRED_FIELDS: (keyof VideoMetadata)[] = [
	"title",
	"description",
	"length",
	"thumbnail",
	"mime",
];

function completeVideo(service: VideoService, id: string): Video {
	return {
		service,
		id,
		title: service + ":" + id,
		description: "server metadata",
		length: 60,
		thumbnail: "https://example.invalid/image.jpg",
		mime: "video/mp4",
	};
}

class ControlledAdapter extends ServiceAdapter {
	readonly rejected = new Set<string>();
	readonly responses = new Map<string, Video>();
	constructor(
		private readonly service: VideoService,
		private readonly cacheSafe: boolean,
	) {
		super();
	}
	get serviceId(): VideoService {
		return this.service;
	}
	get isCacheSafe(): boolean {
		return this.cacheSafe;
	}
	async fetchVideoInfo(id: string, _properties?: (keyof VideoMetadata)[]): Promise<Video> {
		if (this.rejected.has(id)) {
			throw new UnsupportedMimeTypeException("text/html");
		}
		return this.responses.get(id) ?? completeVideo(this.service, id);
	}
}

// Real Direct file rejection and real base-adapter failure skipping are exercised.
// Cache persistence and metadata responses are isolated: no SQL, HTTP or ffprobe process.
describe("batch media admission", () => {
	let direct: DirectVideoAdapter;
	let adapters: Map<VideoService, ServiceAdapter>;
	const rooms: Room[] = [];
	let nextRoom = 0;

	function register(service: VideoService, cacheSafe: boolean): ControlledAdapter {
		const adapter = new ControlledAdapter(service, cacheSafe);
		adapters.set(service, adapter);
		return adapter;
	}

	beforeAll(async () => {
		loadModels();
		await buildClients();
	});
	afterAll(async () => {
		await sequelize.close();
	});
	beforeEach(() => {
		direct = new DirectVideoAdapter();
		adapters = new Map([["direct", direct]]);
		register("hls", false);
		vi.spyOn(InfoExtractor, "getServiceAdapter").mockImplementation(service => {
			const adapter = adapters.get(service as VideoService);
			if (!adapter) {
				throw new Error("Missing test adapter: " + service);
			}
			return adapter;
		});
		vi.spyOn(storage, "getVideoInfoFields").mockReturnValue([...REQUIRED_FIELDS]);
		vi.spyOn(storage, "getManyVideoInfo").mockImplementation(async ids =>
			ids.map(({ service, id }: VideoId) => ({ service, id })),
		);
		vi.spyOn(InfoExtractor, "updateCache").mockResolvedValue(undefined);
	});
	afterEach(async () => {
		vi.restoreAllMocks();
		for (const room of rooms.splice(0)) {
			room.throttledSync.cancel();
			room.saveStateToRedisDebounced.cancel();
			await redisClient.del("room:" + room.name);
		}
	});

	it("does not restore a local file rejected by the real Direct adapter", async () => {
		const fetch = vi.spyOn(direct, "fetchVideoInfo");
		expect(
			await InfoExtractor.getManyVideoInfo([{ service: "direct", id: LOCAL_FILE_ID }]),
		).toEqual([]);
		expect(fetch).toHaveBeenCalledTimes(1);
	});

	it("does not enqueue a local file after the batch adapter rejects it", async () => {
		const room = new Room({ name: "batch-admission-" + nextRoom++, isTemporary: true });
		rooms.push(room);
		room.throttledSync.cancel();
		vi.spyOn(room, "throttledSync").mockReturnValue(undefined);
		vi.spyOn(room, "publish").mockResolvedValue(undefined);
		await expect(
			room.addToQueue(
				{
					type: RoomRequestType.AddRequest,
					videos: [{ service: "direct", id: LOCAL_FILE_ID }],
				},
				{ clientId: "owner", username: "owner", role: Role.Owner },
			),
		).rejects.toThrow();
		expect(room.queue.length).toBe(0);
	});

	it("does not let complete client metadata bypass non-cache-safe admission", async () => {
		const fetch = vi.spyOn(direct, "fetchVideoInfo");
		const clientVideo = completeVideo("direct", LOCAL_FILE_ID);
		expect(await InfoExtractor.getManyVideoInfo([clientVideo])).toEqual([]);
		expect(fetch).toHaveBeenCalledTimes(1);
		expect(storage.getManyVideoInfo).not.toHaveBeenCalled();
	});

	it("does not treat client metadata as a trusted cache miss result", async () => {
		vi.mocked(storage.getManyVideoInfo).mockRestore();
		const read = vi.spyOn(CachedVideo, "findAll").mockResolvedValue([]);
		const adapter = register("invidious", true);
		adapter.rejected.add("blocked");
		const fetch = vi.spyOn(adapter, "fetchVideoInfo");
		expect(
			await InfoExtractor.getManyVideoInfo([completeVideo("invidious", "blocked")]),
		).toEqual([]);
		expect(read).toHaveBeenCalledTimes(1);
		expect(fetch).toHaveBeenCalledTimes(1);
	});

	it("still validates non-cache-safe IDs when there are no cache metadata columns", async () => {
		vi.mocked(storage.getVideoInfoFields).mockReturnValue([]);
		const fetch = vi.spyOn(direct, "fetchVideoInfo");
		expect(
			await InfoExtractor.getManyVideoInfo([{ service: "direct", id: LOCAL_FILE_ID }]),
		).toEqual([]);
		expect(fetch).toHaveBeenCalledTimes(1);
	});

	it("does not restore an item skipped after MIME validation fails", async () => {
		const adapter = register("direct", false);
		adapter.rejected.add("blocked");
		expect(
			await InfoExtractor.getManyVideoInfo([{ service: "direct", id: "blocked" }]),
		).toEqual([]);
	});

	it("keeps admitted metadata and queue extras while excluding failed neighbors", async () => {
		const adapter = register("direct", false);
		adapter.rejected.add("blocked");
		const extras: QueueItemExtras = {
			startAt: 5,
			endAt: 30,
			subtitleUrl: "https://example.invalid/subtitles.vtt",
		};
		const input: Video & QueueItemExtras = {
			...completeVideo("direct", "valid"),
			title: "client title",
			...extras,
		};
		const fetch = vi.spyOn(adapter, "fetchVideoInfo");
		expect(
			await InfoExtractor.getManyVideoInfo([input, { service: "direct", id: "blocked" }]),
		).toEqual([{ ...completeVideo("direct", "valid"), ...extras }]);
		expect(fetch).toHaveBeenCalledTimes(2);
	});

	it("keeps a complete trusted cache hit but not a failed incomplete entry", async () => {
		const adapter = register("youtube", true);
		adapter.rejected.add("blocked");
		const cached = completeVideo("youtube", "cached");
		vi.mocked(storage.getManyVideoInfo).mockResolvedValue([
			cached,
			{ service: "youtube", id: "blocked" },
		]);
		expect(
			await InfoExtractor.getManyVideoInfo([
				{ service: "youtube", id: "cached" },
				{ service: "youtube", id: "blocked" },
			]),
		).toEqual([cached]);
	});

	it("does not fetch complete trusted cache hits", async () => {
		const adapter = register("youtube", true);
		const fetch = vi.spyOn(adapter, "fetchManyVideoInfo");
		const cached = completeVideo("youtube", "cached");
		vi.mocked(storage.getManyVideoInfo).mockResolvedValue([cached]);
		expect(
			await InfoExtractor.getManyVideoInfo([{ service: "youtube", id: "cached" }]),
		).toEqual([cached]);
		expect(fetch).not.toHaveBeenCalled();
	});

	it("matches identical IDs by original service and preserves caller order", async () => {
		register("youtube", true);
		register("vimeo", true);
		const input: VideoId[] = [
			{ service: "youtube", id: "shared" },
			{ service: "vimeo", id: "shared" },
			{ service: "youtube", id: "other" },
			{ service: "vimeo", id: "shared" },
		];
		expect(await InfoExtractor.getManyVideoInfo(input)).toEqual(
			input.map(({ service, id }) => completeVideo(service, id)),
		);
	});

	it.each([
		{ service: "peertube" as const, cacheSafe: false },
		{ service: "invidious" as const, cacheSafe: true },
	])("correlates $service aliases whose service and ID both change", async ({
		service,
		cacheSafe,
	}) => {
		const adapter = register(service, cacheSafe);
		const aliased = completeVideo("direct", "https://example.invalid/resolved.mp4");
		adapter.responses.set("instance|original", aliased);
		const input: VideoId = { service, id: "instance|original" };
		expect(await InfoExtractor.getManyVideoInfo([input])).toEqual([aliased]);
		expect(input).toEqual({ service, id: "instance|original" });
	});

	it("does not mutate a caller's ID when a same-ID direct source becomes HLS", async () => {
		const adapter = register("direct", false);
		const id = "https://example.invalid/master.m3u8";
		const aliased = completeVideo("hls", id);
		adapter.responses.set(id, aliased);
		const input: VideoId = { service: "direct", id };
		expect(await InfoExtractor.getManyVideoInfo([input])).toEqual([aliased]);
		expect(input).toEqual({ service: "direct", id });
	});

	it("retains compatibility with legacy bulk adapters returning shuffled same-ID results", async () => {
		const adapter = register("youtube", true);
		const first = completeVideo("youtube", "first");
		const second = completeVideo("youtube", "second");
		const fetch = vi.spyOn(adapter, "fetchManyVideoInfo").mockResolvedValue([second, first]);
		expect(
			await InfoExtractor.getManyVideoInfo([
				{ service: "youtube", id: "first" },
				{ service: "youtube", id: "second" },
			]),
		).toEqual([first, second]);
		expect(fetch).toHaveBeenCalledTimes(1);
	});
});
