import type { ALL_VIDEO_SERVICES } from "../constants.js";

export type VideoService = (typeof ALL_VIDEO_SERVICES)[number];

export interface VideoId {
	service: VideoService;
	id: string;
}

/**
 * What a source's host requires of the player's own requests, probed when the link is
 * added. Only `referrerPolicy` changes how the client plays; the rest is diagnostics.
 */
export interface MediaAccess {
	/** The referrer policy the browser must use; absent means the default works. */
	referrerPolicy?: "no-referrer";
	/** The host only answers requests carrying its own site's Referer, so a browser on
	 * another origin cannot play it at all. */
	requiresOriginReferer?: boolean;
	/** The response type does not match the media it carries, such as TS segments served
	 * as image/png. */
	containerMismatch?: boolean;
}

export interface VideoMetadata {
	title: string;
	description: string;
	length: number;
	thumbnail: string;
	mime: string;
	/** Source resolution in pixels, when the adapter could read it. */
	width?: number;
	height?: number;
	/**
	 * Whether the source answered with an Access-Control-Allow-Origin header. False means
	 * the browser must load it without crossOrigin; undefined means we could not tell.
	 */
	cors?: boolean;
	/** How the player's requests to the source must be shaped, when it is not obvious. */
	mediaAccess?: MediaAccess;
	highlight?: true;
	hls_url?: string;
	dash_url?: string;
	src_url?: string;
	subtitleUrl?: string;
}

export type Video = VideoId & Partial<VideoMetadata>;
export interface QueueItemExtras {
	startAt?: number;
	endAt?: number;
	subtitleUrl?: string;
}

export type VideoAdd = VideoId & QueueItemExtras;
export interface QueueItem extends Video, QueueItemExtras {}
