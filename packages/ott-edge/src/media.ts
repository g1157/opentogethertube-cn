import type { QueueItem, Video, VideoAdd } from "ott-common/models/video.js";
import { CustomMediaManifestSchema } from "ott-common/models/zod-schemas.js";
import { ApiError, type Env } from "./types";
import { digest } from "./session";

const MAX_BYTES = 2 * 1024 * 1024;
const MAX_REQUESTS = 16;
const SUPPORTED = new Set(["direct", "hls", "dash"]);
const HTTP_PROTOCOL = /^https?:$/;
const NUMERIC_HOST = /^[\d.]+$/;
const LOCAL_HOST = /(^|\.)(localhost|local|internal|test|invalid)$/;
const CONTENT_RANGE = /^bytes (\d+)-(\d+)\/(\d+)$/;
const LINES = /\r?\n/;
const MP4_EXTENSION = /\.(mp4|m4v|m4a)$/i;
const HLS_EXTENSION = /\.m3u8?$/i;
const DASH_EXTENSION = /\.mpd$/i;
const JSON_EXTENSION = /\.json$/i;
const DASH_ROOT = /<MPD[\s>]/;
const DASH_DURATION =
	/mediaPresentationDuration\s*=\s*["']P(?:(\d+)D)?T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?["']/;

export function mediaUrl(value: string): URL {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new ApiError(400, "请输入完整的视频链接。");
	}
	const host = url.hostname.toLowerCase();
	if (
		!HTTP_PROTOCOL.test(url.protocol) ||
		url.username ||
		url.password ||
		value.length > 4096 ||
		!host.includes(".") ||
		NUMERIC_HOST.test(host) ||
		host.includes(":") ||
		host.startsWith("[") ||
		LOCAL_HOST.test(host)
	) {
		throw new ApiError(
			400,
			"需要可公开访问的 HTTP 或 HTTPS 视频链接。",
			"UnsupportedServiceException",
		);
	}
	url.hash = "";
	return url;
}

export class Probe {
	bytes = 0;
	requests = 0;
	private deadline = Date.now() + 20_000;
	async read(
		url: URL,
		start = 0,
		end?: number,
	): Promise<{ bytes: Uint8Array; total: number | null; url: URL }> {
		const remainingMs = this.deadline - Date.now();
		if (remainingMs <= 0) {
			throw new ApiError(400, "读取片源信息超时，请稍后重试。");
		}
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), Math.min(12_000, remainingMs));
		try {
			let target = url;
			let response: Response | undefined;
			for (let redirect = 0; redirect < 4; redirect++) {
				if (++this.requests > MAX_REQUESTS) {
					throw new ApiError(
						400,
						"本次媒体信息读取次数已达上限，请减少同时添加的视频数量。",
					);
				}
				response = await fetch(target, {
					signal: controller.signal,
					redirect: "manual",
					headers:
						end === undefined
							? {}
							: { Range: `bytes=${start}-${end}`, "Accept-Encoding": "identity" },
				});
				if (![301, 302, 303, 307, 308].includes(response.status)) {
					break;
				}
				await response.body?.cancel();
				const location = response.headers.get("Location");
				if (!location) {
					throw new ApiError(400, "片源返回了无效跳转。");
				}
				target = mediaUrl(new URL(location, target).href);
			}
			if (!response || !response.ok || !response.body) {
				throw new ApiError(400, "暂时无法读取片源信息，请检查链接或稍后重试。");
			}
			let total: number | null = null;
			if (response.status === 206) {
				const range = CONTENT_RANGE.exec(response.headers.get("Content-Range") ?? "");
				if (
					!range ||
					Number(range[1]) !== start ||
					Number(range[2]) < start ||
					Number(range[2]) >= Number(range[3]) ||
					!Number.isSafeInteger(Number(range[3]))
				) {
					throw new ApiError(400, "片源返回了错误的分段位置。");
				}
				total = Number(range[3]);
			} else if (start > 0) {
				await response.body.cancel();
				throw new ApiError(400, "片源不支持读取视频信息所需的 Range 分段请求。");
			} else {
				const length = Number(response.headers.get("Content-Length"));
				if (Number.isSafeInteger(length) && length > 0) {
					total = length;
				}
			}
			const maximum = Math.min(
				end === undefined ? MAX_BYTES : end - start + 1,
				MAX_BYTES - this.bytes,
			);
			if (maximum <= 0) {
				throw new ApiError(400, "媒体信息超过本次读取上限。");
			}
			const reader = response.body.getReader();
			const chunks: Uint8Array[] = [];
			let size = 0;
			try {
				while (size < maximum) {
					const result = await reader.read();
					if (result.done) {
						break;
					}
					if (end === undefined && size + result.value.byteLength > maximum) {
						throw new ApiError(400, "媒体清单超过本次读取上限。");
					}
					const part = result.value.subarray(0, maximum - size);
					chunks.push(part);
					size += part.byteLength;
				}
				if (end === undefined && size === maximum && !(await reader.read()).done) {
					throw new ApiError(400, "媒体清单超过本次读取上限。");
				}
			} finally {
				await reader.cancel();
			}
			this.bytes += size;
			const data = new Uint8Array(size);
			let offset = 0;
			for (const chunk of chunks) {
				data.set(chunk, offset);
				offset += chunk.byteLength;
			}
			return { bytes: data, total, url: target };
		} catch (error) {
			if (error instanceof ApiError) {
				throw error;
			}
			throw new ApiError(400, "片源响应较慢或无法访问，请稍后重试。", "MediaProbeFailed");
		} finally {
			clearTimeout(timeout);
			controller.abort();
		}
	}
}

interface Box {
	type: string;
	offset: number;
	size: number;
	header: number;
}

async function probeMp4(url: URL, probe: Probe): Promise<Partial<Video>> {
	let target = url;
	let total: number | null = null;
	let cached: Uint8Array = new Uint8Array(0);
	let cachedOffset = 0;
	let boxes = 0;
	let duration: number | undefined;
	let video = false;
	let audio = false;
	const decoder = new TextDecoder();

	async function readAt(offset: number, length: number): Promise<Uint8Array> {
		if (offset < cachedOffset || offset + length > cachedOffset + cached.byteLength) {
			const end = Math.min(
				offset + 4095,
				total === null ? Number.MAX_SAFE_INTEGER : total - 1,
			);
			if (!Number.isSafeInteger(offset) || offset < 0 || end < offset + length - 1) {
				throw new ApiError(400, "MP4 媒体信息不完整。");
			}
			const response = await probe.read(target, offset, end);
			if (total !== null && response.total !== null && total !== response.total) {
				throw new ApiError(400, "片源文件在读取期间发生变化，请重试。");
			}
			total ??= response.total;
			target = response.url;
			cached = response.bytes;
			cachedOffset = offset;
		}
		const start = offset - cachedOffset;
		if (start < 0 || start + length > cached.byteLength) {
			throw new ApiError(400, "MP4 媒体信息不完整。");
		}
		return cached.subarray(start, start + length);
	}

	async function readBox(offset: number, parentEnd: number | null): Promise<Box> {
		if (++boxes > 256 || (parentEnd !== null && offset + 8 > parentEnd)) {
			throw new ApiError(400, "MP4 媒体信息结构过于复杂或不完整。");
		}
		const bytes = await readAt(offset, 8);
		let size = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0);
		let header = 8;
		if (size === 1) {
			if (parentEnd !== null && offset + 16 > parentEnd) {
				throw new ApiError(400, "MP4 媒体信息不完整。");
			}
			const extended = await readAt(offset + 8, 8);
			size = Number(new DataView(extended.buffer, extended.byteOffset, 8).getBigUint64(0));
			header = 16;
		}
		const limit = parentEnd ?? total;
		if (size === 0) {
			if (limit === null) {
				throw new ApiError(400, "片源未提供读取 MP4 媒体信息所需的文件大小。");
			}
			size = limit - offset;
		}
		if (
			!Number.isSafeInteger(offset + size) ||
			size < header ||
			(limit !== null && offset + size > limit)
		) {
			throw new ApiError(400, "无效的 MP4 文件结构。");
		}
		return { type: decoder.decode(bytes.subarray(4, 8)), offset, size, header };
	}

	async function walk(start: number, end: number, depth: number): Promise<void> {
		if (depth > 5) {
			throw new ApiError(400, "MP4 媒体信息嵌套过深。");
		}
		for (let offset = start; offset < end; ) {
			const box = await readBox(offset, end);
			const content = offset + box.header;
			const boxEnd = offset + box.size;
			if (box.type === "mvhd") {
				if (content + 1 > boxEnd) {
					throw new ApiError(400, "无效的 MP4 时间信息。");
				}
				const version = (await readAt(content, 1))[0];
				const timeOffset = content + (version === 1 ? 20 : 12);
				const length = version === 1 ? 12 : 8;
				if ((version !== 0 && version !== 1) || timeOffset + length > boxEnd) {
					throw new ApiError(400, "无效的 MP4 时间信息。");
				}
				const bytes = await readAt(timeOffset, length);
				const view = new DataView(bytes.buffer, bytes.byteOffset, length);
				const timescale = view.getUint32(0);
				const ticks = version === 1 ? Number(view.getBigUint64(4)) : view.getUint32(4);
				duration = ticks / timescale;
			} else if (box.type === "hdlr" && content + 12 <= boxEnd) {
				const handler = decoder.decode(await readAt(content + 8, 4));
				video ||= handler === "vide";
				audio ||= handler === "soun";
			} else if (["trak", "mdia"].includes(box.type)) {
				await walk(content, boxEnd, depth + 1);
			}
			// The queue only needs duration and media kind, not sample/chunk tables.
			// Stop once a video track is known; audio-only files inspect every track.
			if (video && duration !== undefined) {
				return;
			}
			offset = boxEnd;
		}
	}

	for (let offset = 0, attempt = 0; attempt < 12; attempt++) {
		const box = await readBox(offset, total);
		if (box.type === "moov") {
			await walk(offset + box.header, offset + box.size, 0);
			if (
				!duration ||
				!Number.isFinite(duration) ||
				duration > 31 * 86400 ||
				(!video && !audio)
			) {
				throw new ApiError(400, "无法确定此 MP4 的有效时长和音视频轨道。");
			}
			return { length: duration, mime: video ? "video/mp4" : "audio/mp4" };
		}
		offset += box.size;
		if (total !== null && offset >= total) {
			break;
		}
	}
	throw new ApiError(400, "未找到此 MP4 的媒体信息。");
}

async function probeHls(url: URL, probe: Probe, depth = 0): Promise<Partial<Video>> {
	if (depth > 2) {
		throw new ApiError(400, "HLS 清单嵌套过深。");
	}
	const response = await probe.read(url);
	const data = new TextDecoder().decode(response.bytes);
	if (!data.trimStart().startsWith("#EXTM3U")) {
		throw new ApiError(400, "链接没有返回有效的 HLS 清单。");
	}
	const lines = data.split(LINES).map(line => line.trim());
	const variant = lines.findIndex(line => line.startsWith("#EXT-X-STREAM-INF:"));
	if (variant >= 0) {
		const relative = lines.slice(variant + 1).find(line => line && !line.startsWith("#"));
		if (!relative) {
			throw new ApiError(400, "HLS 主清单缺少可播放的视频流。");
		}
		return probeHls(mediaUrl(new URL(relative, response.url).href), probe, depth + 1);
	}
	const durations = lines
		.filter(line => line.startsWith("#EXTINF:"))
		.map(line => Number(line.slice(8).split(",")[0]));
	if (!durations.length || durations.some(value => !Number.isFinite(value) || value <= 0)) {
		throw new ApiError(400, "HLS 清单中没有有效的视频分段。");
	}
	return {
		mime: "application/x-mpegURL",
		...(lines.includes("#EXT-X-ENDLIST")
			? { length: durations.reduce((sum, value) => sum + value, 0) }
			: {}),
	};
}

function filename(url: URL): string {
	try {
		return decodeURIComponent(url.pathname.split("/").pop() ?? "视频").slice(0, 255);
	} catch {
		return "视频";
	}
}

export async function resolveMedia(env: Env, input: string, probe = new Probe()): Promise<Video> {
	const url = mediaUrl(input);
	const key = await digest(url.href);
	const cached = await env.DB.prepare(
		"SELECT metadata FROM media_cache WHERE cache_key = ? AND expires_at > ?",
	)
		.bind(key, Date.now())
		.first<{ metadata: string }>();
	if (cached) {
		return JSON.parse(cached.metadata) as Video;
	}
	let video: Video;
	if (MP4_EXTENSION.test(url.pathname)) {
		video = {
			service: "direct",
			id: url.href,
			title: filename(url),
			...(await probeMp4(url, probe)),
		};
	} else if (HLS_EXTENSION.test(url.pathname)) {
		video = {
			service: "hls",
			id: url.href,
			title: filename(url),
			...(await probeHls(url, probe)),
		};
	} else if (DASH_EXTENSION.test(url.pathname)) {
		const text = new TextDecoder().decode((await probe.read(url)).bytes);
		if (!DASH_ROOT.test(text)) {
			throw new ApiError(400, "链接没有返回有效的 DASH 清单。");
		}
		const duration = DASH_DURATION.exec(text);
		const length = duration
			? Number(duration[1] ?? 0) * 86400 +
				Number(duration[2] ?? 0) * 3600 +
				Number(duration[3] ?? 0) * 60 +
				Number(duration[4] ?? 0)
			: undefined;
		video = {
			service: "dash",
			id: url.href,
			title: filename(url),
			mime: "application/dash+xml",
			...(length ? { length } : {}),
		};
	} else if (JSON_EXTENSION.test(url.pathname)) {
		const text = new TextDecoder().decode((await probe.read(url)).bytes);
		let data: unknown;
		try {
			data = JSON.parse(text);
		} catch {
			throw new ApiError(400, "自定义媒体清单不是有效的 JSON。");
		}
		const manifest = CustomMediaManifestSchema.parse(data);
		for (const source of manifest.sources) {
			mediaUrl(source.url);
		}
		for (const track of manifest.textTracks ?? []) {
			mediaUrl(track.url);
		}
		video = {
			service: "direct",
			id: url.href,
			title: manifest.title,
			length: manifest.live ? undefined : manifest.duration,
			mime: "application/json",
			thumbnail: manifest.thumbnail ? mediaUrl(manifest.thumbnail).href : undefined,
		};
	} else {
		throw new ApiError(
			400,
			"此测试版支持 MP4、M3U8、MPD 和自定义媒体清单直链。",
			"UnsupportedServiceException",
		);
	}
	if (
		video.length !== undefined &&
		(!Number.isFinite(video.length) || video.length <= 0 || video.length > 31 * 86400)
	) {
		throw new ApiError(400, "片源时长无效或超出支持范围。");
	}
	await env.DB.prepare(
		"INSERT INTO media_cache(cache_key, metadata, expires_at) VALUES (?, ?, ?) ON CONFLICT(cache_key) DO UPDATE SET metadata = excluded.metadata, expires_at = excluded.expires_at",
	)
		.bind(key, JSON.stringify(video), Date.now() + 30 * 60 * 1000)
		.run();
	return video;
}

export async function resolveAdd(env: Env, value: VideoAdd, probe?: Probe): Promise<QueueItem> {
	if (!SUPPORTED.has(value.service)) {
		throw new ApiError(400, "此测试版只支持直链视频。", "UnsupportedServiceException");
	}
	const video = await resolveMedia(env, value.id, probe);
	if (video.service !== value.service) {
		throw new ApiError(400, "链接与所选视频类型不匹配。");
	}
	return applyExtras(video, value);
}

export function applyExtras(video: QueueItem, value: VideoAdd): QueueItem {
	const extras: Partial<QueueItem> = {};
	for (const key of ["startAt", "endAt"] as const) {
		const number = value[key];
		if (number !== undefined) {
			if (!Number.isFinite(number) || number < 0 || (video.length && number > video.length)) {
				throw new ApiError(400, "视频起止位置无效。");
			}
			extras[key] = number;
		}
	}
	if (value.subtitleUrl !== undefined) {
		extras.subtitleUrl = value.subtitleUrl ? mediaUrl(value.subtitleUrl).href : undefined;
	}
	const result = { ...video, ...extras };
	if (result.endAt !== undefined && result.endAt <= (result.startAt ?? 0)) {
		throw new ApiError(400, "结束位置必须晚于开始位置。");
	}
	return result;
}
