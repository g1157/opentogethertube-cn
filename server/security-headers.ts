import express, { type ErrorRequestHandler, type RequestHandler } from "express";
import { getLogger } from "./logger.js";
import { consumeRateLimitPoints } from "./rate-limit.js";

const log = getLogger("security/csp");
const DIRECTIVE = /^([a-z][a-z0-9-]{0,63})(?:\s|$)/;
const REPORT_POINTS = 25; // Separate IP bucket: at most 40 reports/hour with the default budget.

function reportOrigin(value: unknown): string | undefined {
	if (typeof value !== "string" || value.length > 2048) {
		return undefined;
	}
	if (["inline", "eval", "self"].includes(value)) {
		return value;
	}
	try {
		const url = new URL(value);
		// Origins omit credentials, room paths, signed media queries and fragments.
		return url.protocol === "http:" || url.protocol === "https:" ? url.origin : "other";
	} catch {
		return "other";
	}
}

function summarizeReport(body: unknown) {
	if (!body || typeof body !== "object" || !("csp-report" in body)) {
		return null;
	}
	const report = body["csp-report"];
	if (!report || typeof report !== "object" || Array.isArray(report)) {
		return null;
	}
	const fields = report as Record<string, unknown>;
	const directive = fields["effective-directive"] ?? fields["violated-directive"];
	const match = typeof directive === "string" ? DIRECTIVE.exec(directive) : null;
	if (!match) {
		return null;
	}
	return {
		directive: match[1],
		documentOrigin: reportOrigin(fields["document-uri"]),
		blockedOrigin: reportOrigin(fields["blocked-uri"]),
		sourceOrigin: reportOrigin(fields["source-file"]),
	};
}

function cspReports(): express.Router {
	const router = express.Router();
	const limit: RequestHandler = async (req, res, next) => {
		try {
			if (await consumeRateLimitPoints(res, `csp-report:${req.ip}`, REPORT_POINTS)) {
				next();
			}
		} catch (error) {
			next(error);
		}
	};
	router.post(
		"/",
		limit,
		(req, res, next) => {
			if (!req.is("application/csp-report")) {
				res.sendStatus(415);
				return;
			}
			next();
		},
		express.json({ type: "application/csp-report", limit: "16kb", inflate: false }),
		(req, res) => {
			const summary = summarizeReport(req.body);
			if (!summary) {
				res.sendStatus(400);
				return;
			}
			// Do not log the raw report, original policy, script sample, or request URL.
			log.warn(`CSP report: ${JSON.stringify(summary)}`);
			res.status(204).end();
		},
	);
	const errors: ErrorRequestHandler = (error, _req, res, _next) => {
		const status = [400, 413, 415].includes(error.status) ? error.status : 503;
		// Body-parser errors contain the submitted body; keep them out of general error logs.
		res.sendStatus(status);
	};
	router.use(errors);
	return router;
}

/** Install before static files, sessions and the general JSON parser. */
export function installSecurityHeaders(app: express.Express, baseUrl = ""): void {
	const base = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
	const reportPath = `${base}/api/csp-report`;
	app.disable("x-powered-by");
	app.use((req, res, next) => {
		res.set({
			"X-Content-Type-Options": "nosniff",
			"Referrer-Policy": "strict-origin-when-cross-origin",
			"Permissions-Policy": "camera=(), microphone=(), geolocation=()",
			"X-Frame-Options": "SAMEORIGIN",
			// Deliberately no script whitelist or enforcement while gathering compatibility reports.
			"Content-Security-Policy-Report-Only": `base-uri 'self'; object-src 'none'; frame-ancestors 'self'; report-uri ${reportPath}`,
		});
		// Express honors only the configured trusted proxy chain; never inspect XFP directly.
		if (req.secure) {
			res.set("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
		}
		next();
	});
	app.use(reportPath, cspReports());
}
