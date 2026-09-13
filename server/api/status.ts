import { getLogger } from "../logger.js";
import express from "express";
import { register } from "prom-client";
import { conf } from "../ott-config.js";
import { setNoStoreHeaders } from "../client-assets.js";
import { getVoiceUsageSnapshot } from "../voice-budget.js";

const router = express.Router();
// biome-ignore lint/correctness/noUnusedVariables: biome migration
const log = getLogger("api/status");

router.get("/", (req, res) => {
	res.json({
		status: "ok",
		searchEnabled: conf.get("add_preview.search.enabled"),
	});
});

router.get("/version", (_req, res) => {
	setNoStoreHeaders(res);
	res.json({ revision: process.env.OTT_CLIENT_REVISION ?? null });
});

function isLocalOrAdmin(req: express.Request): boolean {
	const address = req.socket.remoteAddress;
	const local = address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
	return local || Boolean(conf.get("api_key") && req.get("apikey") === conf.get("api_key"));
}

router.get("/metrics", async (req, res) => {
	if (!isLocalOrAdmin(req)) {
		res.sendStatus(403);
		return;
	}
	res.type("text/plain; version=0.0.4").send(await register.metrics());
});

/**
 * Local estimate of voice relay usage, in the unit Cloudflare bills on. This is not the invoice;
 * reconcile it against the Cloudflare dashboard so the budget brake tracks real spend.
 */
router.get("/voice", async (req, res) => {
	if (!isLocalOrAdmin(req)) {
		res.sendStatus(403);
		return;
	}
	setNoStoreHeaders(res);
	res.json(await getVoiceUsageSnapshot());
});

export default router;
