import type { VideoService } from "ott-common/models/video.js";
import { InvalidVideoIdException } from "../../exceptions.js";

const INSTANCE_VIDEO_ID = /^[A-Za-z0-9_-]{1,128}$/;

/** Apply the instance policy to service/id admissions as well as pasted watch URLs. */
export function parseInstanceVideoId(
	service: VideoService,
	videoId: string,
	allowedHosts: string[],
	allowHostnamePorts = false,
): { host: string; id: string } {
	const invalid = () => new InvalidVideoIdException(service, videoId);
	const separator = videoId.lastIndexOf(":");
	if (separator <= 0 || !INSTANCE_VIDEO_ID.test(videoId.slice(separator + 1))) {
		throw invalid();
	}
	const authority = videoId.slice(0, separator);
	let instance: URL;
	try {
		instance = new URL("https://" + authority);
	} catch {
		throw invalid();
	}
	if (
		instance.username ||
		instance.password ||
		instance.pathname !== "/" ||
		instance.search ||
		instance.hash ||
		instance.host !== authority.toLowerCase()
	) {
		throw invalid();
	}
	const allowed = allowedHosts.some(host => {
		try {
			const configured = new URL("https://" + host);
			return (
				configured.host === instance.host ||
				(allowHostnamePorts &&
					!configured.port &&
					configured.hostname === instance.hostname)
			);
		} catch {
			return false;
		}
	});
	if (!allowed) {
		throw invalid();
	}
	return { host: instance.host, id: videoId.slice(separator + 1) };
}
