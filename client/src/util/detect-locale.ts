/**
 * Which language a first-time visitor gets (U1).
 *
 * Before this, `i18n.ts` and the settings store both hardcoded `zh-CN`, so an English
 * browser landing here from a share link opened in Chinese. Detection now runs whenever
 * there is no saved preference, and both the i18n initial value and the settings default
 * go through this one function so the interface language and the stored preference can
 * never disagree.
 */

/**
 * The languages the picker offers. `pirate` ships as a locale file but is not a language
 * anyone's browser asks for, so it stays out of detection.
 */
export const SUPPORTED_LOCALES = ["en", "de", "fr", "ru", "es", "pt-br", "zh-CN"] as const;

export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number];

/**
 * Where a visitor with an unsupported browser language ends up: the fork's primary
 * audience. Any `zh-*` tag also lands here, whichever script or region it names.
 */
export const DETECTED_FALLBACK_LOCALE: SupportedLocale = "zh-CN";

/**
 * Maps one BCP 47 tag onto a supported locale: an exact match first, then the same
 * language with another region (`pt` → `pt-br`, `ru-RU` → `ru`), and any Chinese tag
 * (`zh`, `zh-TW`, `zh-Hans`) to the complete Simplified Chinese translation.
 */
export function matchSupportedLocale(tag: string): SupportedLocale | undefined {
	const normalized = tag.trim().toLowerCase().replace(/_/g, "-");
	if (!normalized) {
		return undefined;
	}
	const exact = SUPPORTED_LOCALES.find(locale => locale.toLowerCase() === normalized);
	if (exact) {
		return exact;
	}
	const language = normalized.split("-")[0];
	if (language === "zh") {
		return "zh-CN";
	}
	return SUPPORTED_LOCALES.find(locale => locale.toLowerCase().split("-")[0] === language);
}

/** First supported locale in a browser's preference list, in the visitor's own order. */
export function pickLocale(tags?: readonly string[] | null): SupportedLocale {
	for (const tag of tags ?? []) {
		if (typeof tag !== "string") {
			continue;
		}
		const match = matchSupportedLocale(tag);
		if (match) {
			return match;
		}
	}
	return DETECTED_FALLBACK_LOCALE;
}

/** A tag list is only a test artefact when no real browser is driving the page. */
export function isTestEnvironment(): boolean {
	// `import.meta.env` is injected by Vite; the guard keeps this usable from plain Node.
	return typeof import.meta.env !== "undefined" && import.meta.env.MODE === "test";
}

/** `navigator.languages` in the visitor's order, `navigator.language` when it is empty. */
function browserLanguages(): readonly string[] {
	if (typeof navigator === "undefined") {
		return [];
	}
	const languages = navigator.languages;
	return languages && languages.length > 0 ? languages : [navigator.language];
}

/**
 * The language a first visit starts in.
 *
 * The browser list is a parameter so the mapping can be tested with explicit input
 * (`[["zh-TW"], "zh-CN"], [["en-GB"], "en"], …`) instead of whatever the runner reports.
 * Only the browser-reading path short-circuits: under Vitest, jsdom's synthetic `en-US`
 * would otherwise make every default depend on the machine running the suite, so the
 * defaults stay the fork's Chinese default there while an explicit list is still honoured.
 */
export function detectLocale(languages?: readonly string[] | null): SupportedLocale {
	if (languages) {
		return pickLocale(languages);
	}
	if (isTestEnvironment()) {
		return DETECTED_FALLBACK_LOCALE;
	}
	return pickLocale(browserLanguages());
}
