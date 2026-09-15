/* eslint-disable no-unused-vars */

import type { ServerMessageEvent } from "ott-common/models/messages";

/**
 * How a notice behaves while the player is fullscreen. Absent means "social", which
 * fullscreen suppresses: only notices that explain the picture (critical) or what happened
 * to playback (content) are worth space over a full-screen video.
 */
export type ToastLevel = "critical" | "content" | "social";

/**
 * A toast notification.
 */
export interface Toast {
	id: symbol;
	content: string;
	duration?: number;
	style: ToastStyle;
	event?: ServerMessageEvent;
	level?: ToastLevel;
}

export enum ToastStyle {
	Neutral,
	Success,
	Error,
	Important,
}
