import type { ErrorRequestHandler } from "express";
import { ZodError } from "zod";
import { fromZodError } from "zod-validation-error";
import { OttException } from "ott-common/exceptions.js";
import { BadApiArgumentException } from "../exceptions.js";
import { getLogger } from "../logger.js";
import { counterHttpErrors } from "../metrics.js";

const log = getLogger("api/error");

/**
 * Answers the rejections that `asyncHandler` forwards. Without it Express 4 would fall back
 * to its default HTML error page (and, for a rejection nobody forwarded, no response at
 * all). The error names room.ts has always mapped to specific statuses keep their meaning.
 */
const NOT_FOUND = new Set(["RoomNotFoundException"]);
const UNAUTHORIZED = new Set(["RoomPasswordRequired", "InvalidRoomPassword"]);
const FORBIDDEN = new Set(["FeatureDisabledException"]);

function errorName(error: unknown): string {
	return error instanceof Error && error.name ? error.name : "Unknown";
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export const apiErrorHandler: ErrorRequestHandler = (error, req, res, next) => {
	// A handler that already started the response cannot be answered again; let Express
	// close the connection instead of throwing "headers already sent".
	if (res.headersSent) {
		next(error);
		return;
	}

	const name = errorName(error);
	counterHttpErrors.labels({ error: name }).inc();

	// body-parser reports malformed, oversized or unsupported bodies with a numeric
	// `status` before any route runs. Answer them as JSON like the rest of the API instead
	// of letting Express fall back to its HTML error page.
	const status = (error as { status?: unknown } | null)?.status;
	if (typeof status === "number" && status >= 400 && status < 500) {
		res.status(status).json({
			success: false,
			error: {
				name: status === 413 ? "PayloadTooLarge" : "BadRequest",
				message:
					status === 413
						? "The request body is too large."
						: "The request body could not be parsed.",
			},
		});
		return;
	}

	if (error instanceof ZodError) {
		const formatted = fromZodError(error);
		res.status(400).json({
			success: false,
			error: {
				name: "ValidationError",
				message: formatted.message,
			},
		});
		return;
	}

	if (error instanceof OttException) {
		const status = NOT_FOUND.has(name)
			? 404
			: UNAUTHORIZED.has(name)
				? 401
				: FORBIDDEN.has(name)
					? 403
					: 400;
		log.debug(`OttException: path=${req.path} name=${name}`);
		const body: Record<string, unknown> = {
			name,
			message: errorMessage(error),
		};
		if (error instanceof BadApiArgumentException) {
			body.arg = error.arg;
			body.reason = error.reason;
		}
		res.status(status).json({ success: false, error: body });
		return;
	}

	log.error(
		`Unhandled exception: path=${req.path} ${name} ${errorMessage(error)} ${
			error instanceof Error ? (error.stack ?? "") : ""
		}`,
	);
	res.status(500).json({
		success: false,
		error: {
			name: "Unknown",
			message: "An unknown error occurred. Try again later.",
		},
	});
};
