"use strict";

/** @type {import('sequelize-cli').Migration} */
module.exports = {
	async up(queryInterface) {
		if (queryInterface.sequelize.getDialect() !== "postgres") {
			// Only production (postgres) needs this index; Sequelize's sqlite table-rebuild
			// paths (removeColumn/changeColumn) crash while an expression index exists.
			return;
		}
		await queryInterface.sequelize.query(
			'CREATE INDEX "rooms_lower_name" ON "Rooms" (lower(name))',
		);
	},

	async down(queryInterface) {
		await queryInterface.sequelize.query('DROP INDEX IF EXISTS "rooms_lower_name"');
	},
};
