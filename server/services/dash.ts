import URL from "node:url";
import { ServiceAdapter } from "../serviceadapter.js";
import { assertPublicMediaUrl } from "../ffprobe.js";
import {
	LocalFileException,
	UnsupportedMimeTypeException,
	UnsupportedVideoType,
} from "../exceptions.js";
import { getMimeType, isSupportedMimeType } from "../mime.js";
import { getLogger } from "../logger.js";
import type { Video } from "ott-common/models/video.js";
import { DashMPD } from "@liveinstantly/dash-mpd-parser";
import axios from "axios";
import { corsFromHeaders } from "./cors-probe.js";
import { parseIso8601Duration } from "./parsing/iso8601.js";

const log = getLogger("dash");
const DASH_URL_REGEX = /\/*\.(mpd)$/;

export default class DashVideoAdapter extends ServiceAdapter {
	get serviceId(): "dash" {
		return "dash";
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
		return DASH_URL_REGEX.test((url.path ?? "/").split("?")[0]);
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
		return await this.handleMpd(url);
	}

	async handleMpd(url: URL.UrlWithStringQuery): Promise<Video> {
		// Manifest URLs are user supplied; never follow redirects that could land on an
		// intranet address and only fetch hosts that resolve publicly.
		await assertPublicMediaUrl(url.href);
		const resp = await axios.get(url.href, { maxRedirects: 0 });
		const mpd = new DashMPD();
		mpd.parse(resp.data);
		const manifest = mpd.getJSON();

		return this.parseMpdManifest(
			url,
			manifest,
			corsFromHeaders(resp.headers as Record<string, unknown>),
		);
	}

	parseMpdManifest(url: URL.UrlWithStringQuery, manifest: any, cors?: boolean): Video {
		// docs for how the parser works: https://github.com/liveinstantly/dash-mpd-parser

		log.debug(JSON.stringify(manifest));

		const durationRaw: string = manifest["MPD"]["@mediaPresentationDuration"];
		if (!durationRaw) {
			throw new UnsupportedVideoType("livestream");
		}
		const duration = parseIso8601Duration(durationRaw);

		const title = this.extractTitle(manifest);

		// The largest advertised video representation describes the source quality.
		let width: number | undefined;
		let height: number | undefined;
		const periods = [manifest["MPD"]?.["Period"]].flat().filter(Boolean);
		for (const period of periods) {
			const adaptationSets = [period["AdaptationSet"]].flat().filter(Boolean);
			for (const adaptationSet of adaptationSets) {
				const representations = [adaptationSet["Representation"]].flat().filter(Boolean);
				for (const representation of representations) {
					const candidateWidth = Number(representation["@width"]);
					const candidateHeight = Number(representation["@height"]);
					if (
						Number.isFinite(candidateWidth) &&
						Number.isFinite(candidateHeight) &&
						(!width || candidateWidth > width)
					) {
						width = candidateWidth;
						height = candidateHeight;
					}
				}
			}
		}

		return {
			service: this.serviceId,
			id: url.href,
			title: title ?? url.pathname?.split("/").slice(-1)[0] ?? url.href,
			description: `Full Link: ${url.href}`,
			mime: "application/dash+xml",
			length: duration,
			width,
			height,
			cors,
			dash_url: url.href,
		};
	}

	/**
	 * Attempts to find a title for the video from the manifest. Returns undefined if no title is found.
	 *
	 * Video metadata is not always available in the manifest, and it's not standardized, so this method will probably usually fail.
	 */
	extractTitle(manifest: any): string | undefined {
		try {
			if ("ProgramInformation" in manifest["MPD"]) {
				return manifest?.MPD?.ProgramInformation?.Title;
			}

			const periods = manifest?.MPD?.Period;
			for (const period of periods) {
				const adaptationSets = period["AdaptationSet"];
				for (const adaptationSet of adaptationSets) {
					const representations = adaptationSet["Representation"];
					for (const representation of representations) {
						if ("Title" in representation) {
							return representation["Title"];
						}
					}
				}
			}
		} catch (e) {
			log.warn("Error extracting title from manifest", e);
		}

		return undefined;
	}
}
