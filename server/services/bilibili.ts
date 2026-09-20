import { URL } from "node:url";
import axios from "axios";
import { ServiceAdapter } from "../serviceadapter.js";
import { getLogger } from "../logger.js";
import { assertPublicMediaUrl } from "../ffprobe.js";
import type { Video, VideoMetadata } from "ott-common/models/video.js";
import { InvalidVideoIdException, MissingMetadataException } from "../exceptions.js";
import { conf } from "../ott-config.js";

const log = getLogger("bilibili");

// Matches /video/BV…, /video/av… (with optional ?p=N) and b23.tv short links.
const BILIBILI_VIDEO_PATH_REGEX = /^\/video\/(BV[0-9A-Za-z]+|av\d+)/;
const BILIBILI_SHORT_HOSTS = new Set(["b23.tv", "bilibili.com", "www.bilibili.com", "m.bilibili.com"]);
const BILIBILI_VIDEO_HOSTS = new Set([
	"www.bilibili.com",
	"m.bilibili.com",
	"bilibili.com",
	"www.bilibili.tv",
]);

export interface BilibiliViewPage {
	cid: number;
	page: number;
	part: string;
	duration: number;
}

export interface BilibiliViewResponse {
	code: number;
	message?: string;
	data?: {
		bvid: string;
		aid: number;
		title: string;
		pic: string;
		duration: number;
		owner?: { name?: string };
		pages?: BilibiliViewPage[];
	};
}

export default class BilibiliAdapter extends ServiceAdapter {
	api = axios.create({
		headers: {
			// The public API rejects requests without a browser-ish UA.
			"User-Agent": `Mozilla/5.0 (compatible; OpenTogetherTube; ${conf.get("hostname")})`,
			Referer: "https://www.bilibili.com/",
		},
		timeout: 10000,
	});

	get serviceId(): "bilibili" {
		return "bilibili";
	}

	get isCacheSafe() {
		// View counts and titles change; nothing here is worth caching long term.
		return false;
	}

	canHandleURL(link: string): boolean {
		try {
			const url = new URL(link);
			if (url.protocol !== "https:" && url.protocol !== "http:") {
				return false;
			}
			if (BILIBILI_SHORT_HOSTS.has(url.hostname) && url.hostname === "b23.tv") {
				return true;
			}
			return BILIBILI_VIDEO_HOSTS.has(url.hostname) && BILIBILI_VIDEO_PATH_REGEX.test(url.pathname);
		} catch {
			return false;
		}
	}

	isCollectionURL(_link: string): boolean {
		return false;
	}

	/**
	 * Video ids are `BV…` or `av…`, optionally with a part suffix `@p<N>`.
	 * The web URL always carries a part number, so the player can build its iframe url.
	 */
	getVideoId(link: string): string {
		const url = new URL(link);
		const match = url.pathname.match(BILIBILI_VIDEO_PATH_REGEX);
		if (!match) {
			throw new InvalidVideoIdException("bilibili", link);
		}
		let id = match[1];
		if (id.startsWith("av")) {
			id = id.slice(2);
		}
		const p = this.getPageNumber(link);
		return p > 1 ? `${id}@p${p}` : id;
	}

	getPageNumber(link: string): number {
		const url = new URL(link);
		const p = Number(url.searchParams.get("p") ?? "1");
		return Number.isInteger(p) && p > 1 ? p : 1;
	}

	/**
	 * b23.tv short links redirect to the canonical video URL. Follow the first hop
	 * manually so every target is SSRF-checked before we actually request it.
	 */
	async resolveShortLink(link: string): Promise<string> {
		await assertPublicMediaUrl(link);
		const resp = await this.api.get(link, { maxRedirects: 0, validateStatus: () => true });
		const location = resp.headers?.location;
		if (typeof location !== "string" || !location) {
			// Some short links resolve directly to content; treat the original as canonical.
			return link;
		}
		const target = new URL(location, link);
		await assertPublicMediaUrl(target.href);
		return target.href;
	}

	async fetchVideoInfo(id: string, _properties?: (keyof VideoMetadata)[]): Promise<Video> {
		const [rawId, partSuffix] = id.split("@p");
		const page = Number(partSuffix ?? "1") || 1;

		const query = rawId.startsWith("BV") ? { bvid: rawId } : { aid: rawId };
		log.info(`requesting video info from bilibili: ${rawId} p${page}`);
		const resp = await this.api.get<BilibiliViewResponse>(
			"https://api.bilibili.com/x/web-interface/view",
			{ params: query },
		);
		const body = resp.data;
		if (body.code !== 0 || !body.data) {
			log.warn(`bilibili API error for ${rawId}: ${body.code} ${body.message}`);
			throw new MissingMetadataException(
				body.code === -404
					? "The video does not exist or is not public on bilibili."
					: `bilibili API error ${body.code}: ${body.message ?? "unknown"}`,
			);
		}
		const data = body.data;

		const pages = data.pages ?? [];
		const part = pages.length > 0 ? (pages[page - 1] ?? pages[0]) : undefined;
		const length = part ? part.duration : data.duration;
		if (!Number.isFinite(length) || length <= 0) {
			throw new MissingMetadataException("bilibili did not report a usable duration");
		}

		const idWithPart = page > 1 ? `${data.bvid}@p${page}` : data.bvid;
		return {
			service: this.serviceId,
			id: idWithPart,
			title: pages.length > 1 && part ? `${data.title} · P${part.page} ${part.part}` : data.title,
			description: data.owner?.name
				? `UP: ${data.owner.name} · https://www.bilibili.com/video/${data.bvid}${page > 1 ? `?p=${page}` : ""}`
				: `https://www.bilibili.com/video/${data.bvid}${page > 1 ? `?p=${page}` : ""}`,
			length,
			thumbnail: data.pic,
		};
	}
}
