import fs from "node:fs/promises";
import pg from "pg";

if (process.env.OTT_INSTANCE_ID !== "ott-next") {
	throw new Error("This import is restricted to the isolated ott-next instance.");
}
const rooms = JSON.parse(await fs.readFile(process.argv[2], "utf8"));
const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
await db.connect();
const restored = [];
try {
	await db.query("BEGIN");
	for (const room of rooms) {
		if (room.isTemporary !== false || typeof room.name !== "string") {
			continue;
		}
		const queue = Array.isArray(room.queue) ? [...room.queue] : [];
		if (room.currentSource) {
			let position = Number(room.playbackPosition) || 0;
			if (room.isPlaying && room._playbackStart) {
				const elapsed = (Date.now() - Date.parse(room._playbackStart)) / 1000;
				if (Number.isFinite(elapsed) && elapsed > 0) {
					position += elapsed * (Number(room.playbackSpeed) || 1);
				}
			}
			if (Number.isFinite(room.currentSource.length)) {
				position = Math.min(position, room.currentSource.length);
			}
			queue.unshift({ ...room.currentSource, startAt: Math.max(0, position) });
		}
		if (queue.length === 0 && Array.isArray(room.prevQueue)) {
			queue.push(...room.prevQueue);
		}
		if (queue.length === 0) {
			continue;
		}
		const seen = new Set();
		const unique = queue.filter(item => {
			const key = JSON.stringify([item.service, item.id]);
			if (seen.has(key)) {
				return false;
			}
			seen.add(key);
			return true;
		});
		const result = await db.query(
			'UPDATE "Rooms" SET "prevQueue" = $1::jsonb, "restoreQueueBehavior" = 2 WHERE lower(name) = lower($2)',
			[JSON.stringify(unique), room.name],
		);
		if (result.rowCount > 0) {
			restored.push({ room: room.name, savedLinks: unique.length });
		}
	}
	await db.query("COMMIT");
	console.log(JSON.stringify({ restored }));
} catch (error) {
	await db.query("ROLLBACK");
	throw error;
} finally {
	await db.end();
}
