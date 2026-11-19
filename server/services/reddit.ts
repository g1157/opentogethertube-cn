const REDDIT_VIDEO_ID = /^[A-Za-z0-9]{1,32}$/;

import { fetchPublicJson } from "./parsing/json-fetch.js";
import { URL } from "node:url";
import axios from "axios";
import { ServiceAdapter } from "../serviceadapter.js";
import { getLogger } from "../logger.js";
import type { Video, VideoMetadata } from "ott-common/models/video.js";
import { InvalidVideoIdException } from "../exceptions.js";
import { conf } from "../ott-config.js";

const log = getLogger("reddit");
const REDDIT_SUBREDDIT_PATH_REGEX = /^\/r\/.+$/;
const REDDIT_COMMENTS_PATH_REGEX = /\/comments\/.+/;

export interface RedditListing<T> {
	kind: "Listing";
	data: {
		modhash: string;
		children: T[];
	};
}

export interface RedditPost {
	kind: "t3";
	data: RedditPostData | RedditVideoPostData;
}

export interface RedditPostData {
	subreddit: string;
	title: string;
	selftext: string;
	is_video: boolean;
	permalink: string;
	url: string;
	thumbnail: string;
	id: string;
}

export interface RedditVideoPostData extends RedditPostData {
	is_video: true;
	is_reddit_media_domain: boolean;
	media: RedditMedia | RedditEmbedMedia;
	secure_media: RedditMedia | RedditEmbedMedia;
}

export interface RedditMedia {
	reddit_video: {
		hls_url: string;
		dash_url: string;
		duration: number;
		height: number;
		width: number;
		fallback_url: string;
		transcoding_status: string;
		is_gif: boolean;
		scrubber_media_url: string;
	};
}

export interface RedditEmbedMedia {
	type: string;
	oembed: {
		author_url: string;
		provider_name: string;
		type: string;
		thumbnail_url: string;
		title: string;
	};
}

export interface RedditComment {
	kind: "t1";
	data: {
		body: string;
	};
}

export type RedditListableThing = RedditPost | RedditComment;
export type RedditThing = RedditPost | RedditComment | RedditListing<RedditListableThing>;

function isRedditTarget(url: URL): boolean {
	return (
		(url.protocol === "http:" || url.protocol === "https:") &&
		!url.username &&
		!url.password &&
		!url.port &&
		(url.hostname === "reddit.com" || url.hostname.endsWith(".reddit.com"))
	);
}

export default class RedditAdapter extends ServiceAdapter {
	api = axios.create({
		headers: { "User-Agent": `OpenTogetherTube @ ${conf.get("hostname")}` },
	});

	get serviceId(): "reddit" {
		return "reddit";
	}

	get isCacheSafe() {
		return false;
	}

	canHandleURL(link: string): boolean {
		const url = new URL(link);
		return (
			isRedditTarget(url) &&
			(REDDIT_SUBREDDIT_PATH_REGEX.test(url.pathname) ||
				REDDIT_COMMENTS_PATH_REGEX.test(url.pathname))
		);
	}

	isCollectionURL(link: string): boolean {
		return !link.includes("comments");
	}

	async resolveURL(link: string): Promise<(Video | { url: string })[]> {
		if (!this.canHandleURL(link)) {
			throw new InvalidVideoIdException(this.serviceId, link);
		}
		const url = new URL(link);
		if (!url.pathname.endsWith(".json")) {
			url.pathname += ".json";
		}
		log.info(`Requesting posts: ${url.toString()}`);
		const resp = await this.fetchRedditUrl(url.toString());
		const fetchResult = Array.isArray(resp) ? resp : [resp];
		return this.extractVideos(fetchResult[0]);
	}

	async fetchRedditUrl(
		link: string,
	): Promise<RedditListing<RedditListableThing>[] | RedditListing<RedditListableThing>> {
		const target = new URL(link);
		if (!isRedditTarget(target)) {
			throw new InvalidVideoIdException(this.serviceId, link);
		}
		// Use the canonical HTTPS endpoint instead of depending on a cross-host redirect.
		target.protocol = "https:";
		target.hostname = "www.reddit.com";
		const resp = await fetchPublicJson<
			RedditListing<RedditListableThing>[] | RedditListing<RedditListableThing>
		>(target.toString(), this.api);
		if (Array.isArray(resp.data)) {
			return resp.data;
		}
		return resp.data;
	}

	public extractVideos(thing: RedditThing): (Video | { url: string })[] {
		const videos: (Video | { url: string })[] = [];
		if (thing.kind === "Listing") {
			for (const listedThing of thing.data.children) {
				videos.push(...this.extractVideos(listedThing));
			}
		} else if (thing.kind === "t3") {
			if (thing.data.is_video && "media" in thing.data) {
				if ("reddit_video" in thing.data.media) {
					videos.push({
						service: "reddit",
						id: thing.data.id,
						title: thing.data.title,
						description: thing.data.permalink,
						length: thing.data.media.reddit_video.duration,
						thumbnail: thing.data.thumbnail,
						hls_url: thing.data.media.reddit_video.hls_url,
						mime: "application/x-mpegURL",
					});
				}
			} else {
				if (thing.data.url.length > 0) {
					videos.push({
						url: thing.data.url,
					});
				}
			}
		}
		return videos;
	}

	getVideoId(url: string): string {
		const fragments = url.split("/");
		const idx = fragments.indexOf("comments");
		return fragments[idx + 1];
	}

	async fetchVideoInfo(id: string, _properties?: (keyof VideoMetadata)[]): Promise<Video> {
		if (!REDDIT_VIDEO_ID.test(id)) {
			throw new InvalidVideoIdException(this.serviceId, id);
		}
		const resp = await this.fetchRedditUrl(`https://www.reddit.com/comments/${id}.json`);
		if (!Array.isArray(resp) || !resp[0]) {
			throw new InvalidVideoIdException(this.serviceId, id);
		}
		const video = this.extractVideos(resp[0])[0];
		if (!video || "url" in video) {
			throw new InvalidVideoIdException(this.serviceId, id);
		}
		return video;
	}
}
