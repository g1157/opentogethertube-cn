"use strict";

/** @type {import('sequelize-cli').Migration} */
module.exports = {
	async up(queryInterface, Sequelize) {
		await queryInterface.addColumn("Rooms", "bufferGateMode", {
			type: Sequelize.STRING,
			allowNull: false,
			defaultValue: "off",
		});
	},
	async down(queryInterface) {
		await queryInterface.removeColumn("Rooms", "bufferGateMode");
	},
};
