import URL from "node:url";
import { ServiceAdapter } from "../serviceadapter.js";
import { assertPublicMediaUrl } from "../ffprobe.js";
import {
	LocalFileException,
	UnsupportedMimeTypeException,
	UnsupportedVideoType,
	BadApiArgumentException,
} from "../exceptions.js";
import { getMimeType, isSupportedMimeType } from "../mime.js";
import type { Video } from "ott-common/models/video.js";
import { corsFromHeaders } from "./cors-probe.js";
import { parseIso8601Duration } from "./parsing/iso8601.js";
import { parseDashMetadata } from "./parsing/dash-metadata.js";
import { fetchManifestText } from "./parsing/manifest-fetch.js";

const DASH_URL_REGEX = /\/*\.(mpd)$/;
const DASH_DURATION_REGEX = /^P(?:\d+D)?(?:T(?:\d+H)?(?:\d+M)?(?:\d+(?:\.\d+)?S)?)?$/;

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
		const resp = await fetchManifestText(url.href);
		const metadata = await parseDashMetadata(resp.data);
		if (metadata.dynamic || !metadata.duration) {
			throw new UnsupportedVideoType("livestream");
		}
		if (metadata.duration.length > 128 || !DASH_DURATION_REGEX.test(metadata.duration)) {
			throw new BadApiArgumentException("manifest", "Invalid DASH duration");
		}
		const duration = parseIso8601Duration(metadata.duration);
		if (!Number.isFinite(duration) || duration <= 0) {
			throw new BadApiArgumentException("manifest", "Invalid DASH duration");
		}

		return {
			service: this.serviceId,
			id: url.href,
			title: metadata.title ?? url.pathname?.split("/").slice(-1)[0] ?? url.href,
			description: `Full Link: ${url.href}`,
			mime: "application/dash+xml",
			length: duration,
			width: metadata.width,
			height: metadata.height,
			cors: corsFromHeaders(resp.headers as Record<string, unknown>),
			dash_url: url.href,
		};
	}
}
