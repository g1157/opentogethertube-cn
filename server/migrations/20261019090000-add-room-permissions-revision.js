"use strict";

/** @type {import('sequelize-cli').Migration} */
module.exports = {
	async up(queryInterface, Sequelize) {
		await queryInterface.addColumn("Rooms", "permissionsRevision", {
			type: Sequelize.INTEGER,
			allowNull: true,
			defaultValue: null,
		});
	},

	async down(queryInterface) {
		// Same sqlite workaround as the other Rooms column migrations: the expression index
		// on lower(name) breaks Sequelize's table rebuild, but a direct drop works on both.
		await queryInterface.sequelize.query(
			'ALTER TABLE "Rooms" DROP COLUMN "permissionsRevision"',
		);
	},
};
