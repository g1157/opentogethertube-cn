import express from "express";
import { getLogger } from "./logger.js";
import roomapi from "./api/room.js";
import userapi from "./api/user.js";
import auth from "./auth/index.js";
import usermanager from "./usermanager.js";
import passport from "passport";
import statusapi from "./api/status.js";
import playbackapi from "./api/playback.js";
import { conf } from "./ott-config.js";
import announceapi from "./api/announce.js";
import dataapi from "./api/data.js";
import danmakuapi from "./api/danmaku.js";
import { apiErrorHandler } from "./api/error-handler.js";
import { asyncHandler } from "./util/async-handler.js";

const log = getLogger("api");
export function buildApiRouter(): express.Router {
	log.debug("Building API router");
	const router = express.Router();

	// Room state, account data and password verdicts depend on the auth token in a cookie or
	// header. A shared cache must not store them even when a route forgot to say so; the
	// routes that intentionally cache (add preview, girigiri tracks) set their own header
	// afterwards and win.
	router.use((_req, res, next) => {
		res.set("Cache-Control", "no-store");
		next();
	});

	router.use("/status", statusapi);
	// Anonymous quality counters; guests watch too, so this stays outside auth.
	router.use("/playback", playbackapi);
	router.use("/auth", auth.router);
	router.use("/data", dataapi);
	// External danmaku search and proxying; guests watch too, so this stays outside auth.
	router.use("/danmaku", danmakuapi);

	router.use((req, res, next) => {
		// eslint-disable-next-line no-unused-vars
		passport.authenticate("bearer", (err, user, info) => {
			// We are intentionally ignoring the case where authentication fails, because
			// we want to allow users who are not logged in to an actual account to
			// be able to use the website.

			// log.error(`bearer auth error: ${err}`);
			if (err) {
				next(err);
				return;
			}
			// log.debug(`bearer auth user: ${user}`);
			// log.debug(`bearer auth info: ${info}`);
			next();
		})(req, res, next);
	});
	// The token lookup is async; a Redis failure must reach the error handler instead of
	// leaving the request open.
	router.use(asyncHandler(auth.authTokenMiddleware));
	router.use("/user", usermanager.router);
	router.use("/user", userapi);
	router.use("/room", roomapi);
	router.use("/announce", announceapi);

	if (conf.get("env") === "development") {
		(async () => {
			router.use("/dev", (await import("./api/dev.js")).default);
		})();
	}

	// Must come after every route so a forwarded rejection is answered as JSON.
	router.use(apiErrorHandler);

	return router;
}
