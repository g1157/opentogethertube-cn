"use strict";

/** @type {import('sequelize-cli').Migration} */
module.exports = {
	async up(queryInterface, Sequelize) {
		await queryInterface.changeColumn("Rooms", "restoreQueueBehavior", {
			type: Sequelize.INTEGER,
			allowNull: false,
			defaultValue: 2,
		});
		await queryInterface.bulkUpdate(
			"Rooms",
			{ restoreQueueBehavior: 2 },
			{
				restoreQueueBehavior: 1,
			},
		);
	},
	async down(queryInterface, Sequelize) {
		await queryInterface.changeColumn("Rooms", "restoreQueueBehavior", {
			type: Sequelize.INTEGER,
			allowNull: false,
			defaultValue: 1,
		});
	},
};
