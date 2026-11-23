import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { buildApiRouter } from "../../../api.js";

describe("API cache policy", () => {
	it("defaults every API response to no-store", async () => {
		const app = express();
		app.use("/api", buildApiRouter());

		const response = await request(app).get("/api/status").expect(200);
		expect(response.headers["cache-control"]).toBe("no-store");
	});
});
