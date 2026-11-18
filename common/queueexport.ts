import type { QueueItem } from "./models/video.js";

export function exportQueue(queue: QueueItem[]): string {
	return queue.map(buildUrlForQueueItem).join("\n");
}

export function buildUrlForQueueItem(item: QueueItem): string {
	switch (item.service) {
		case "youtube":
			return `https://youtu.be/${item.id}`;
		case "vimeo":
			return `https://vimeo.com/${item.id}`;
		case "direct":
			return item.id;
		case "hls":
			return item.hls_url ?? item.id;
		case "dash":
			return item.dash_url ?? item.id;
		case "tubi":
			return `https://tubitv.com/movies/${encodeURIComponent(item.id)}`;
		case "reddit":
			return `https://www.reddit.com/comments/${encodeURIComponent(item.id)}/`;
		case "googledrive":
			return `https://drive.google.com/file/d/${encodeURIComponent(item.id)}/view`;
		case "peertube":
		case "invidious": {
			// These ids contain an instance authority and a video id. Split at the final
			// colon so an instance port (or an IPv6 authority) survives the export.
			const separator = item.id.lastIndexOf(":");
			const host = item.id.slice(0, separator);
			const id = item.id.slice(separator + 1);
			const url = new URL(`https://${host}`);
			if (item.service === "peertube") {
				url.pathname = `/w/${encodeURIComponent(id)}`;
			} else {
				url.pathname = "/watch";
				url.searchParams.set("v", id);
			}
			return url.href;
		}
		case "pluto": {
			const [type, id, episode] = item.id.split("/");
			return (
				`https://pluto.tv/en/on-demand/${type}/${encodeURIComponent(id)}` +
				(episode ? `/episode/${encodeURIComponent(episode)}` : "")
			);
		}
		case "odysee":
			return item.id.startsWith("lbry://")
				? `https://odysee.com/${item.id.slice("lbry://".length).replaceAll("#", ":")}`
				: item.id;
		case "bilibili": {
			const [id, part] = item.id.split("@p");
			const bvid = id.startsWith("BV") || id.startsWith("av") ? id : `av${id}`;
			const url = new URL(`https://www.bilibili.com/video/${encodeURIComponent(bvid)}/`);
			if (part) {
				url.searchParams.set("p", part);
			}
			return url.href;
		}
		default:
			// A newly supported service must add an export mapping at compile time.
			return assertUnknownService(item.service);
	}
}

function assertUnknownService(service: never): never {
	throw new Error(`Unknown service: ${String(service)}`);
}
