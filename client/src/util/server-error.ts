import { i18n } from "@/i18n";

interface ServerErrorLike {
	name?: unknown;
	message?: unknown;
}

/**
 * Turn a server exception into a localized, user-safe message.
 *
 * The server's own message is written to the console for debugging; the UI never shows it
 * verbatim, because those strings are English and may contain internal details.
 */
export function serverErrorMessage(error: ServerErrorLike | null | undefined): string {
	console.error("Server error:", error);
	const name = typeof error?.name === "string" ? error.name : "";
	if (name !== "" && i18n.global.te(`errors.${name}`)) {
		return i18n.global.t(`errors.${name}`);
	}
	return i18n.global.t("errors.unknown");
}
