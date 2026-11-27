import { nextTick } from "vue";
import messages from "@/locales/en";
import axios from "axios";
import { createI18n } from "vue-i18n";
import { detectLocale } from "@/util/detect-locale";

/**
 * Only English is imported up front in a production build: it is the fallback every other
 * locale relies on, so it has to be in memory before the first translation runs.
 * Everything else — including `zh-CN`, the most likely one here — is loaded by
 * `loadLanguageAsync`, which `main.ts` awaits before mounting so the first paint is
 * already in the right language (PF4). The test setup registers its pack the same way, so
 * no locale but English is ever in the entry chunk.
 */
export const i18n = createI18n({
	allowComposition: true,
	locale: import.meta.env.VUE_APP_I18N_LOCALE || detectLocale(),
	fallbackLocale: import.meta.env.VUE_APP_I18N_FALLBACK_LOCALE || "en",
});
i18n.global.setLocaleMessage("en", messages);

/** Language packs already in memory, so a second selection is a switch, not a download. */
const loadedLanguages: string[] = ["en"];

/**
 * Registers a pack that was imported some other way — the test setup pins Chinese this way
 * so no test has to wait for a chunk. Production always goes through `loadLanguageAsync`.
 */
export function registerLocaleMessages(lang: string, localeMessages: Record<string, unknown>) {
	i18n.global.setLocaleMessage(lang, localeMessages);
	if (!loadedLanguages.includes(lang)) {
		loadedLanguages.push(lang);
	}
}

/** In-flight chunk loads, so two callers asking for the same locale share one request. */
const pendingLoads = new Map<string, Promise<{ default: typeof messages }>>();

/** The one language pack that is always in memory, so it is the only safe fallback. */
const FALLBACK_LANGUAGE = "en";

function setI18nLanguage(lang: string) {
	if (i18n.mode === "legacy") {
		i18n.global.locale = lang;
	} else {
		i18n.global.locale.value = lang;
	}
	axios.defaults.headers.common["Accept-Language"] = lang;
	document.querySelector("html")?.setAttribute("lang", lang);
	return lang;
}

export async function loadLanguageAsync(lang: string): Promise<string> {
	// If the language was already loaded (English always is), only switch to it.
	if (loadedLanguages.includes(lang)) {
		return setI18nLanguage(lang);
	}

	try {
		let pending = pendingLoads.get(lang);
		if (!pending) {
			pending = import(`@/locales/${lang}.ts`);
			pendingLoads.set(lang, pending);
		}
		const loaded = await pending;
		i18n.global.setLocaleMessage(lang, loaded.default);
		if (!loadedLanguages.includes(lang)) {
			loadedLanguages.push(lang);
		}
		setI18nLanguage(lang);
		await nextTick();
		return lang;
	} catch (e) {
		// An offline first visit or a stale chunk name must not leave the app without
		// messages: fall back to English, which is always in memory, and try again next time.
		pendingLoads.delete(lang);
		console.warn(
			`Failed to load the "${lang}" language pack, staying on ${FALLBACK_LANGUAGE}`,
			e,
		);
		return setI18nLanguage(FALLBACK_LANGUAGE);
	}
}
