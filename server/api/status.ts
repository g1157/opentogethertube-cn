import { getLogger } from "../logger.js";
import express from "express";
import { register } from "prom-client";
import { conf } from "../ott-config.js";

const router = express.Router();
// biome-ignore lint/correctness/noUnusedVariables: biome migration
const log = getLogger("api/status");

router.get("/", (req, res) => {
	res.json({
		status: "ok",
	});
});

router.get("/metrics", async (req, res) => {
	const address = req.socket.remoteAddress;
	const local = address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
	if (!local && !(conf.get("api_key") && req.get("apikey") === conf.get("api_key"))) {
		res.sendStatus(403);
		return;
	}
	res.type("text/plain; version=0.0.4").send(await register.metrics());
});

export default router;
