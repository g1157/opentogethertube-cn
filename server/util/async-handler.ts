import type { RequestHandler } from "express";

/** A route handler narrowed to its own params/body types, which Express's base type rejects. */
type NarrowHandler = (...args: never[]) => unknown;

/**
 * Express 4 invokes a handler and ignores the promise it returns. A rejected async handler
 * therefore leaves the request open until the client times out, while Node reports an
 * unhandled rejection. Forward the rejection to `next` so the router's error handler can
 * answer with a real status instead.
 *
 * This also works for middleware, which has the same `(req, res, next)` shape.
 */
export function asyncHandler(handler: RequestHandler): RequestHandler;
export function asyncHandler<H extends NarrowHandler>(handler: H): RequestHandler;
export function asyncHandler(handler: NarrowHandler): RequestHandler {
	return (req, res, next) => {
		let result: unknown;
		try {
			result = (handler as unknown as RequestHandler)(req, res, next);
		} catch (error) {
			next(error);
			return;
		}
		// eslint-disable-next-line promise/prefer-await-to-then, promise/no-callback-in-promise -- next() is Express's error channel, not a callback continuation.
		void Promise.resolve(result).catch(next);
	};
}
