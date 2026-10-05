"use strict";

/** @type {import('sequelize-cli').Migration} */
module.exports = {
	async up(queryInterface, Sequelize) {
		await queryInterface.addColumn("Rooms", "passwordHash", {
			type: Sequelize.STRING,
			allowNull: true,
			defaultValue: null,
		});
	},

	async down(queryInterface) {
		// Sequelize's sqlite removeColumn rebuilds the table via describeTable, which trips
		// over expression indexes; drop the column directly (both dialects support this).
		await queryInterface.sequelize.query('ALTER TABLE "Rooms" DROP COLUMN "passwordHash"');
	},
};
