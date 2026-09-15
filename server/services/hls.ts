import URL from "node:url";
import axios from "axios";
import { corsFromHeaders } from "./cors-probe.js";
import { Parser as M3u8Parser, type PlaylistItem } from "m3u8-parser";
import { OttException } from "ott-common/exceptions.js";
import type { Video } from "ott-common/models/video.js";
import { LocalFileException, UnsupportedMimeTypeException } from "../exceptions.js";
import { getLogger } from "../logger.js";
import { getMimeType, isSupportedMimeType } from "../mime.js";
import { ServiceAdapter } from "../serviceadapter.js";

const log = getLogger("hls");
const HLS_URL_REGEX = /\/*\.(m3u8?)$/;

export default class HlsVideoAdapter extends ServiceAdapter {
	get serviceId(): "hls" {
		return "hls";
	}

	get isCacheSafe(): boolean {
		return false;
	}

	isCollectionURL(link: string): boolean {
		return false;
	}

	getVideoId(link: string): string {
		return link;
	}

	canHandleURL(link: string): boolean {
		const url = URL.parse(link);
		return HLS_URL_REGEX.test((url.path ?? "/").split("?")[0]);
	}

	async fetchVideoInfo(link: string): Promise<Video> {
		const url = URL.parse(link);
		if (url.protocol === "file:") {
			throw new LocalFileException();
		}
		const fileName = (url.pathname ?? "").split("/").slice(-1)[0].trim();
		const extension = fileName.split(".").slice(-1)[0];
		const mime = getMimeType(extension) ?? "unknown";
		if (!isSupportedMimeType(mime)) {
			throw new UnsupportedMimeTypeException(mime);
		}
		return await this.handleM3u8(url);
	}

	async handleM3u8(url: URL.UrlWithStringQuery): Promise<Video> {
		const parser = new M3u8Parser();
		const resp = await axios.get(url.href);
		const cors = corsFromHeaders(resp.headers as Record<string, unknown>);
		parser.push(resp.data);
		parser.end();
		const manifest = parser.manifest;
		// log.silly(`Got m3u8 manifest with ${JSON.stringify(manifest)}`);

		let duration = 0;
		let title: string | undefined;
		let width: number | undefined;
		let height: number | undefined;

		// The m3u8 manifest can be a master playlist containing other playlists or a media playlist containing segments.
		// If it has playlists, we find the lowest bitrate one and extract the duration from it.
		// Otherwise, we assume it's a media playlist and calculate the duration from its segments.
		if (manifest.playlists && manifest.playlists?.length > 0) {
			// Advertised variant dimensions describe the source quality; keep the largest.
			for (const playlist of manifest.playlists) {
				// The parser types do not cover every attribute it forwards.
				const resolution = (playlist.attributes as Record<string, unknown> | undefined)
					?.RESOLUTION;
				if (typeof resolution !== "string") {
					continue;
				}
				const [candidateWidth, candidateHeight] = resolution.split("x").map(Number);
				if (
					Number.isFinite(candidateWidth) &&
					Number.isFinite(candidateHeight) &&
					(!width || candidateWidth > width)
				) {
					width = candidateWidth;
					height = candidateHeight;
				}
			}
			const lowestBitratePlaylist = manifest.playlists.reduce(
				(acc, cur) => {
					if ((cur.attributes?.BANDWIDTH ?? 0) < (acc.attributes?.BANDWIDTH ?? 0)) {
						return cur;
					} else {
						return acc;
					}
				},
				{ attributes: { BANDWIDTH: Infinity } } as PlaylistItem,
			);
			const playlistUrl = URL.resolve(url.href, lowestBitratePlaylist.uri);
			log.silly(`new playlist path ${playlistUrl}`);
			const respStreams = await axios.get(playlistUrl);
			const parser2 = new M3u8Parser();
			parser2.push(respStreams.data);
			parser2.end();
			const manifest2 = parser2.manifest;
			// log.silly(`Got m3u8 manifest with ${JSON.stringify(manifest2)}`);
			duration = manifest2.segments.reduce((acc, cur) => acc + cur.duration, 0);
			title = manifest2.segments[0].title;
		} else {
			duration = manifest.segments.reduce((acc, cur) => acc + cur.duration, 0);
			title = manifest.segments[0].title;
		}

		if (duration === 0) {
			throw new M3u8ParseError("Duration of the selected playlist is 0");
		}

		return {
			service: "hls",
			id: url.href,
			title: title ?? url.href,
			description: `Full Link: ${url.href}`,
			mime: "application/x-mpegURL",
			length: duration,
			width,
			height,
			cors,
			hls_url: url.href,
		};
	}
}

export class M3u8ParseError extends OttException {
	constructor(public readonly message: string) {
		super(message);
		this.name = "M3u8ParseError";
	}
}
