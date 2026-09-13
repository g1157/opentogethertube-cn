import { uniqueNamesGenerator } from "unique-names-generator";
import { generateChineseNickname } from "ott-common/nicknames.js";

/**
 * Guest nicknames follow the language the client asked for, so a Chinese viewer gets a Chinese
 * name instead of an English adjective_color_animal one. Anything that is not Chinese keeps the
 * upstream generator, including requests without a language header.
 */
export function generateGuestNickname(acceptLanguage?: string | null): string {
	const language = (acceptLanguage ?? "").toLowerCase();
	return language.startsWith("zh") ? generateChineseNickname() : uniqueNamesGenerator();
}
