import type { ALL_VIDEO_SERVICES } from "../constants.js";

export type VideoService = (typeof ALL_VIDEO_SERVICES)[number];

export interface VideoId {
	service: VideoService;
	id: string;
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
