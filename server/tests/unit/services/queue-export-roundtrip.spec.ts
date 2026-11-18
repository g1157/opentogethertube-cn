import { describe, expect, it } from "vitest";
import { buildUrlForQueueItem } from "ott-common/queueexport.js";
import BilibiliAdapter from "../../../services/bilibili.js";
import GoogleDriveAdapter from "../../../services/googledrive.js";
import InvidiousAdapter from "../../../services/invidious.js";
import OdyseeAdapter from "../../../services/odysee.js";
import PeertubeAdapter from "../../../services/peertube.js";
import PlutoAdapter from "../../../services/pluto.js";
import RedditAdapter from "../../../services/reddit.js";
import TubiAdapter from "../../../services/tubi.js";
import type { QueueItem } from "ott-common/models/video.js";

describe("queue export service round trips", () => {
	const cases = [
		{ adapter: new BilibiliAdapter(), item: { service: "bilibili", id: "BV1xx411c7mD@p3" } },
		{ adapter: new BilibiliAdapter(), item: { service: "bilibili", id: "12345@p2" } },
		{
			adapter: new GoogleDriveAdapter("review-key"),
			item: { service: "googledrive", id: "file-id" },
		},
		{
			adapter: new InvidiousAdapter(),
			item: { service: "invidious", id: "inv.example.com:8443:video-id" },
		},
		{
			adapter: new OdyseeAdapter(),
			item: { service: "odysee", id: "lbry://@channel#abc/video#def" },
		},
		{
			adapter: new OdyseeAdapter(),
			item: { service: "odysee", id: "https://cdn.odycdn.com/video.mp4" },
		},
		{
			adapter: new PeertubeAdapter(),
			item: { service: "peertube", id: "tube.example.com:8443:video-id" },
		},
		{ adapter: new PlutoAdapter(), item: { service: "pluto", id: "series/abc123/def456" } },
		{ adapter: new PlutoAdapter(), item: { service: "pluto", id: "movies/abc123" } },
		{ adapter: new RedditAdapter(), item: { service: "reddit", id: "abc123" } },
		{ adapter: new TubiAdapter(), item: { service: "tubi", id: "123456" } },
	] satisfies { adapter: { getVideoId(link: string): string }; item: QueueItem }[];
	it.each(cases)("keeps $item.service id $item.id", ({ adapter, item }) => {
		expect(adapter.getVideoId(buildUrlForQueueItem(item))).toBe(item.id);
	});
});
