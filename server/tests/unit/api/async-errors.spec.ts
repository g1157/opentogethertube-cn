import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { OttException } from "ott-common/exceptions.js";
import { BadApiArgumentException } from "../../../exceptions.js";
import { apiErrorHandler } from "../../../api/error-handler.js";
import { asyncHandler } from "../../../util/async-handler.js";

function appWith(handler: express.RequestHandler) {
	const app = express();
	app.get("/test", asyncHandler(handler));
	app.use(apiErrorHandler);
	return app;
}

describe("async route failures", () => {
	it("answers a rejected handler instead of leaving the request open", async () => {
		const app = appWith(async () => {
			throw new Error("database went away");
		});

		const response = await request(app).get("/test").expect(500);
		expect(response.body).toEqual({
			success: false,
			error: {
				name: "Unknown",
				message: "An unknown error occurred. Try again later.",
			},
		});
		// The internal message must not reach the client.
		expect(JSON.stringify(response.body)).not.toContain("database went away");
	});

	it("answers a synchronously thrown handler", async () => {
		const app = appWith(() => {
			throw new BadApiArgumentException("input", "missing");
		});

		const response = await request(app).get("/test").expect(400);
		expect(response.body.error).toMatchObject({
			name: "BadApiArgumentException",
			arg: "input",
			reason: "missing",
		});
	});

	it("keeps an OttException a 400 with its own name", async () => {
		const app = appWith(async () => {
			throw new OttException("nope");
		});
		// OttException itself has no name override, so the mapper falls back to the base name.
		const response = await request(app).get("/test").expect(400);
		expect(response.body.error.message).toBe("nope");
	});

	it("maps a Zod rejection to a validation response", async () => {
		const schema = z.object({ input: z.string() });
		const app = appWith(async () => {
			schema.parse({});
		});

		const response = await request(app).get("/test").expect(400);
		expect(response.body.error.name).toBe("ValidationError");
	});

	it("answers a malformed JSON body as an API error", async () => {
		const app = express();
		app.use(express.json());
		app.post("/test", (_req, res) => res.json({ success: true }));
		app.use(apiErrorHandler);

		const response = await request(app)
			.post("/test")
			.set("Content-Type", "application/json")
			.send('{"broken":')
			.expect(400);
		expect(response.body).toEqual({
			success: false,
			error: {
				name: "BadRequest",
				message: "The request body could not be parsed.",
			},
		});
	});

	it("lets a resolved handler answer normally", async () => {
		const app = appWith(async (_req, res) => {
			res.json({ success: true });
		});

		const response = await request(app).get("/test").expect(200);
		expect(response.body).toEqual({ success: true });
	});
});
