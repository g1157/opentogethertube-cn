import { type Sequelize, Model, DataTypes, type Optional } from "sequelize";
import type { RoomNote as SharedRoomNote } from "ott-common/models/messages.js";

export interface RoomNoteAttributes {
	id: number;
	roomName: string;
	authorName: string;
	authorId: string;
	text: string;
}

type RoomNoteCreationAttributes = Optional<RoomNoteAttributes, "id">;

export class RoomNote
	extends Model<RoomNoteAttributes, RoomNoteCreationAttributes>
	implements RoomNoteAttributes
{
	declare id: number;
	public declare readonly createdAt: Date;
	public declare readonly updatedAt: Date;
	declare roomName: string;
	declare authorName: string;
	declare authorId: string;
	declare text: string;

	toShared(): SharedRoomNote {
		return {
			id: this.id,
			authorName: this.authorName,
			text: this.text,
			createdAt: this.createdAt.toISOString(),
		};
	}
}

export const createModel = (sequelize: Sequelize) => {
	RoomNote.init(
		{
			id: {
				type: DataTypes.INTEGER,
				primaryKey: true,
				autoIncrement: true,
			},
			// Notes follow the room name because the in-memory Room has no database id.
			roomName: {
				type: DataTypes.STRING,
				allowNull: false,
			},
			authorName: {
				type: DataTypes.STRING,
				allowNull: false,
			},
			authorId: {
				type: DataTypes.STRING,
				allowNull: false,
			},
			text: {
				type: DataTypes.TEXT,
				allowNull: false,
			},
		},
		{
			sequelize,
			modelName: "RoomNote",
			tableName: "RoomNotes",
			indexes: [{ fields: ["roomName"] }],
		},
	);

	return RoomNote;
};

export default createModel;
