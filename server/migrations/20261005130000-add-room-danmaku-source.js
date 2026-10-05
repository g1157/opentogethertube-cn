"use strict";

/** @type {import('sequelize-cli').Migration} */
module.exports = {
	async up(queryInterface, Sequelize) {
		// Nullable JSON: existing rooms simply have no shared danmaku source.
		await queryInterface.addColumn("Rooms", "danmakuSource", {
			type: Sequelize.JSONB,
			allowNull: true,
			defaultValue: null,
		});
	},
	async down(queryInterface) {
		await queryInterface.removeColumn("Rooms", "danmakuSource");
	},
};
