import { DurableObject } from "cloudflare:workers";
import { roomStub } from "./room-index";
import type { Env } from "./types";

const INTERVAL_MS = 6 * 60 * 60 * 1000;
const RETRY_MS = 60_000;
const ROOM_BATCH_SIZE = 20;

/** One persistent alarm replaces an account-wide Cron trigger. */
export class MaintenanceObject extends DurableObject<Env> {
	async ensureScheduled(): Promise<void> {
		await this.ctx.blockConcurrencyWhile(async () => {
			if ((await this.ctx.storage.getAlarm()) === null) {
				await this.ctx.storage.setAlarm(Date.now() + 1000);
			}
		});
	}

	async alarm(): Promise<void> {
		// Keep the next run durable even if this invocation is interrupted during cleanup.
		await this.ctx.storage.setAlarm(Date.now() + INTERVAL_MS);
		try {
			const now = Date.now();
			await this.env.DB.batch([
				this.env.DB.prepare("DELETE FROM sessions WHERE expires_at <= ?").bind(now),
				this.env.DB.prepare("DELETE FROM media_cache WHERE expires_at <= ?").bind(now),
				this.env.DB.prepare("DELETE FROM rate_limits WHERE expires_at <= ?").bind(now),
			]);
			const expired = await this.env.DB.prepare(
				"SELECT instance_id FROM rooms WHERE expires_at <= ? LIMIT ?",
			)
				.bind(now, ROOM_BATCH_SIZE)
				.all<{ instance_id: string }>();
			for (const row of expired.results) {
				if (await roomStub(this.env, row.instance_id).expire()) {
					// Also release expired reservations whose room initialization never completed.
					await this.env.DB.prepare(
						"DELETE FROM rooms WHERE instance_id = ? AND expires_at <= ?",
					)
						.bind(row.instance_id, now)
						.run();
				}
			}
			if (expired.results.length === ROOM_BATCH_SIZE) {
				await this.ctx.storage.setAlarm(Date.now() + RETRY_MS);
			}
		} catch (error) {
			await this.ctx.storage.setAlarm(Date.now() + RETRY_MS);
			console.error("edge cleanup failed", error instanceof Error ? error.name : "Unknown");
		}
	}
}
