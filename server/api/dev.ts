import { getLogger } from "../logger.js";
import express from "express";
import { rateLimiter } from "../rate-limit.js";
import roommanager from "../roommanager.js";
import { RoomRequestType } from "ott-common/models/messages.js";
import usermanager from "../usermanager.js";
import faker from "faker";
import tokens from "../auth/tokens.js";
import { setApiKey } from "../admin.js";
import { User as UserModel } from "../models/index.js";
import type { User } from "../models/user.js";
import { asyncHandler } from "../util/async-handler.js";

const router = express.Router();
const log = getLogger("api/dev");

function loginAsync(req: express.Request, user: User): Promise<void> {
	return new Promise((resolve, reject) => {
		req.login(user, err => (err ? reject(err) : resolve()));
	});
}

router.post(
	"/reset-rate-limit",
	asyncHandler(async (req, res) => {
		await rateLimiter.delete(req.ip);
		log.warn(`Reset rate limit for: ${req.ip}`);
		res.json({ success: true });
	}),
);

router.post(
	"/reset-rate-limit/user",
	asyncHandler(async (_req, res) => {
		await usermanager.clearAllRateLimiting();
		log.warn(`Reset all user manager rate limits`);
		res.json({ success: true });
	}),
);

router.post(
	"/room/:name/add-fake-user",
	asyncHandler(async (req, res) => {
		let user;
		const token = await tokens.mint();
		if (req.body.register) {
			user = await usermanager.registerUser({
				email: faker.internet.email(),
				username: faker.internet.userName(),
				password: faker.internet.password(12),
			});
			await tokens.setSessionInfo(token, { isLoggedIn: true, user_id: user.id });
		} else {
			await tokens.setSessionInfo(token, { isLoggedIn: false, username: "fake_user" });
		}

		const result = await roommanager.getRoom(req.params.name);
		if (!result.ok) {
			res.json({
				success: false,
				error: {
					name: "RoomNotFound",
					message: "Room not found",
				},
			});
			return;
		}
		const room = result.value;
		try {
			await room.processUnauthorizedRequest(
				{
					type: RoomRequestType.JoinRequest,
					info: {
						id: "fake",
						user_id: user ? user.id : undefined,
					},
				},
				{ token: token },
			);
			res.json({ success: true });
		} catch (e) {
			res.json({
				success: false,
				error: {
					name: e.name,
					message: e.message,
				},
			});
		}
	}),
);

router.post("/set-admin-api-key", (req, res) => {
	setApiKey(req.body.newkey);
	res.json({ success: true });
});

router.post(
	"/user/create-social",
	asyncHandler(async (req, res) => {
		const user = await usermanager.registerUserSocial({
			username: req.body.username,
			discordId: req.body.discordId ?? faker.random.alphaNumeric(12),
		});
		res.json({
			success: true,
			user: {
				id: user.id,
				username: user.username,
			},
		});
	}),
);

router.post(
	"/user/force-login",
	asyncHandler(async (req, res) => {
		const user = await UserModel.findOne({ where: { username: req.body.username } });
		if (!user) {
			res.status(404).json({
				success: false,
				error: {
					name: "UserNotFound",
					message: "User not found",
				},
			});
			return;
		}

		await loginAsync(req, user);
		req.ottsession = { isLoggedIn: true, user_id: user.id };
		await tokens.setSessionInfo(req.token!, req.ottsession);
		res.json({ success: true });
	}),
);

router.post(
	"/user/set-discord-link",
	asyncHandler(async (req, res) => {
		const user = await UserModel.findOne({ where: { username: req.body.username } });
		if (!user) {
			res.status(404).json({
				success: false,
				error: {
					name: "UserNotFound",
					message: "User not found",
				},
			});
			return;
		}

		user.discordId = req.body.discordId ?? faker.random.alphaNumeric(12);
		await user.save();
		res.json({ success: true });
	}),
);

export default router;
