/* global __COMMIT_HASH__:readonly */
import { createApp } from "vue";
import App from "./App.vue";
import vuetify from "./plugins/vuetify";
import { store, key } from "./store";
import { router } from "./router";
import { i18n, loadLanguageAsync } from "./i18n";
import { OttRoomConnectionPlugin } from "./plugins/connection";
import { OttSfxPlugin } from "./plugins/sfx";
import { installClientUpdateCheck } from "./util/client-update";
import { installServiceWorker } from "./util/service-worker";

async function start() {
	// The saved preference has to be in place before the first paint, otherwise a returning
	// visitor briefly sees the defaults (theme, volume, and which language to load).
	try {
		await store.dispatch("settings/load");
	} catch (e) {
		console.warn("Could not load the saved settings, using this release's defaults", e);
	}

	// Only English is bundled with the entry chunk; the active language pack is fetched here,
	// before mounting, so the first paint is already in the visitor's language (PF4) instead
	// of English waiting for a switch. A failed download falls back to English inside
	// `loadLanguageAsync`.
	await loadLanguageAsync(store.state.settings.locale);

	createApp(App)
		.use(store, key)
		.use(router)
		.use(i18n)
		.use(vuetify)
		.use(OttRoomConnectionPlugin)
		.use(OttSfxPlugin)
		.mount("#app");

	if (import.meta.env.PROD) {
		installServiceWorker();
		installClientUpdateCheck({
			// biome-ignore lint/correctness/noUndeclaredVariables: Injected by Vite during the build.
			revision: __COMMIT_HASH__,
			versionUrl: `${import.meta.env.OTT_BASE_URL ?? ""}/api/status/version`,
		});
	}
}

void start();
