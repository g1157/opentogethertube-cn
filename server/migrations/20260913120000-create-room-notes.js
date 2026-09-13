"use strict";

/** @type {import('sequelize-cli').Migration} */
module.exports = {
	async up(queryInterface, Sequelize) {
		await queryInterface.createTable("RoomNotes", {
			id: {
				type: Sequelize.INTEGER,
				primaryKey: true,
				autoIncrement: true,
			},
			roomName: {
				type: Sequelize.STRING,
				allowNull: false,
			},
			authorName: {
				type: Sequelize.STRING,
				allowNull: false,
			},
			authorId: {
				type: Sequelize.STRING,
				allowNull: false,
			},
			text: {
				type: Sequelize.TEXT,
				allowNull: false,
			},
			createdAt: {
				type: Sequelize.DATE,
				allowNull: false,
			},
			updatedAt: {
				type: Sequelize.DATE,
				allowNull: false,
			},
		});
		await queryInterface.addIndex("RoomNotes", ["roomName"]);
	},

	async down(queryInterface) {
		await queryInterface.dropTable("RoomNotes");
	},
};
