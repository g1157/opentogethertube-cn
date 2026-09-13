"use strict";

/**
 * Rooms store their grants as a serialized `[Role, GrantMask][]` snapshot, and the runtime
 * uses those persisted masks instead of merging new defaults. Without this backfill every
 * existing room (including the owner's) would silently refuse notes.
 *
 * Written as a read-modify-write in JS on purpose: JSONB native operators are postgres
 * only and would break sqlite deployments.
 */

const NOTES_PERMISSION_BIT = 1 << 27;

function flipBit(permissions, enable) {
	let grants;
	try {
		grants = typeof permissions === "string" ? JSON.parse(permissions) : permissions;
	} catch {
		return null;
	}
	if (!Array.isArray(grants)) {
		// The pre-2021 object format is not worth migrating here.
		return null;
	}
	return grants.map(([role, mask]) => [
		role,
		enable ? mask | NOTES_PERMISSION_BIT : mask & ~NOTES_PERMISSION_BIT,
	]);
}

async function rewritePermissions(queryInterface, enable) {
	const dialect = queryInterface.sequelize.getDialect();
	const [rows] = await queryInterface.sequelize.query('SELECT id, permissions FROM "Rooms"');
	let updated = 0;
	for (const row of rows) {
		const permissions = flipBit(row.permissions, enable);
		if (permissions === null) {
			console.warn(`Skipping room ${row.id}: unexpected permissions format`);
			continue;
		}
		const serialized = JSON.stringify(permissions);
		if (dialect === "postgres") {
			await queryInterface.sequelize.query(
				'UPDATE "Rooms" SET permissions = :permissions::jsonb WHERE id = :id',
				{ replacements: { permissions: serialized, id: row.id } },
			);
		} else if (dialect === "sqlite") {
			await queryInterface.sequelize.query(
				'UPDATE "Rooms" SET permissions = :permissions WHERE id = :id',
				{ replacements: { permissions: serialized, id: row.id } },
			);
		} else {
			throw new Error(`Unsupported dialect: ${dialect}`);
		}
		updated++;
	}
	console.log(`Updated notes permission on ${updated} room(s)`);
}

/** @type {import('sequelize-cli').Migration} */
module.exports = {
	async up(queryInterface) {
		await rewritePermissions(queryInterface, true);
	},

	async down(queryInterface) {
		await rewritePermissions(queryInterface, false);
	},
};
