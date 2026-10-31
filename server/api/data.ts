import { getLogger } from "../logger.js";
import { conf } from "../ott-config.js";
import express, { type RequestHandler, type ErrorRequestHandler } from "express";
import type { OttApiResponseAddPreview, OttResponseBody } from "ott-common/models/rest-api.js";
import { OttException } from "ott-common/exceptions.js";
import { BadApiArgumentException } from "../exceptions.js";
import InfoExtract from "../infoextractor.js";
import { consumeRateLimitPoints } from "../rate-limit.js";
import { counterHttpErrors } from "../metrics.js";
import { mediaFileStatus } from "../services/media-access.js";

const router = express.Router();
const log = getLogger("api/data");
const addPreview: RequestHandler<
	any,
	OttResponseBody<OttApiResponseAddPreview>,
	any,
	{ input: string; adapter?: string; verify?: string }
> = async (req, res, next) => {
	if (typeof req.query.input !== "string" || req.query.input.trim() === "") {
		throw new BadApiArgumentException("input", "missing or invalid");
	}
	const input = req.query.input.trim();
	const adapter = typeof req.query.adapter === "string" ? req.query.adapter : undefined;

	// One request must not become an unbounded probe fan-out: a multi-line add is charged
	// per URL, and InfoExtract also caps the number of lines it will resolve.
	const urlLines = input.split("\n").filter(line => InfoExtract.isURL(line.trim())).length;
	const points = input.includes("\n")
		? 5 * Math.max(1, urlLines)
		: InfoExtract.isURL(input)
			? 5
			: 75;
	if (!(await consumeRateLimitPoints(res, req.ip, points))) {
		return;
	}
	try {
		log.info(`Getting queue add preview for ${input}`);
		const result = await InfoExtract.resolveVideoQuery(
			input,
			conf.get("add_preview.search.provider"),
			adapter,
		);

		// A direct link whose file is gone must not come back as a video just because
		// ffprobe failed on it. The same-series probe is strict (only 2xx/3xx counts); a
		// normal preview still accepts a host that refuses the check, because that refusal
		// may be anti-hotlink protection on a file that is there.
		if (result.videos.length === 1) {
			const video = result.videos[0];
			if (video.service === "direct") {
				const status = await mediaFileStatus(video.id);
				const missing = status === 404 || status === 410;
				const unverified = status === null || status < 200 || status >= 400;
				if (req.query.verify === "1" ? unverified : missing) {
					log.info(`Verified ${video.id} as unavailable (status ${status ?? "none"})`);
					res.status(404).json({
						success: false,
						error: {
							name: "VideoNotFoundException",
							message: "The media file does not exist.",
						},
					});
					return;
				}
			}
		}

		res.setHeader(
			"Cache-Control",
			`public, max-age=${result.cacheDuration}, immutable, stale-while-revalidate=86400`,
		);

		res.json({
			success: true,
			result: result.videos,
			highlighted: result.highlighted,
		});
		log.info(`Sent add preview response with ${result.videos.length} items`);
	} catch (err) {
		if (
			err.name === "UnsupportedServiceException" ||
			err.name === "InvalidAddPreviewInputException" ||
			err.name === "OutOfQuotaException" ||
			err.name === "InvalidVideoIdException" ||
			err.name === "FeatureDisabledException" ||
			err.name === "UnsupportedMimeTypeException" ||
			err.name === "LocalFileException" ||
			err.name === "MissingMetadataException" ||
			err.name === "UnsupportedVideoType" ||
			err.name === "UpstreamInvidiousException" ||
			err.name === "VideoNotFoundException" ||
			err.name === "FfprobeTimeoutError" ||
			err.name === "FfprobeError" ||
			err.name === "M3u8ParseError" ||
			err.name === "OdyseeUnavailableVideo" ||
			err.name === "OttException"
		) {
			log.error(`Unable to get add preview: ${err.name}`);
			res.status(400).json({
				success: false,
				error: {
					name: err.name,
					message: err.message,
				},
			});
		} else {
			log.error(`Unable to get add preview: ${err} ${err.stack}`);
			res.status(500).json({
				success: false,
				error: {
					name: "Unknown",
					message: "Unknown error occurred.",
				},
			});
		}
	}
};

router.get("/previewAdd", async (req, res, next) => {
	try {
		// @ts-expect-error the type definition for query parameters makes ts angry, but its correct
		await addPreview(req, res, next);
	} catch (e) {
		errorHandler(e, req, res, next);
	}
});

const errorHandler: ErrorRequestHandler = (err: Error, req, res) => {
	counterHttpErrors.labels({ error: err.name }).inc();
	if (err instanceof OttException) {
		log.debug(`OttException: path=${req.path} name=${err.name}`);
		if (err.name === "BadApiArgumentException") {
			const e = err as BadApiArgumentException;
			res.status(400).json({
				success: false,
				error: {
					name: "BadApiArgumentException",
					message: err.message,
					arg: e.arg,
					reason: e.reason,
				},
			});
		} else {
			res.status(400).json({
				success: false,
				error: {
					name: err.name,
					message: err.message,
				},
			});
		}
	} else {
		log.error(`Unhandled exception: path=${req.path} ${err.name} ${err.message} ${err.stack}`);
		res.status(500).json({
			success: false,
			error: {
				name: "Unknown",
				message: "An unknown error occurred. Try again later.",
			},
		});
	}
};

export default router;
