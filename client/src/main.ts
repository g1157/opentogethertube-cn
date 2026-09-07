/* global __COMMIT_HASH__:readonly */
import { createApp } from "vue";
import { QueryClient, VueQueryPlugin } from "@tanstack/vue-query";
import App from "./App.vue";
import vuetify from "./plugins/vuetify";
import { store, key } from "./store";
import { router } from "./router";
import { i18n } from "./i18n";
import { OttRoomConnectionPlugin } from "./plugins/connection";
import { OttSfxPlugin } from "./plugins/sfx";
import { installClientUpdateCheck } from "./util/client-update";

const queryClient = new QueryClient();

createApp(App)
	.use(store, key)
	.use(router)
	.use(VueQueryPlugin, { queryClient })
	.use(i18n)
	.use(vuetify)
	.use(OttRoomConnectionPlugin)
	.use(OttSfxPlugin)
	.mount("#app");

if (import.meta.env.PROD) {
	installClientUpdateCheck({
		// biome-ignore lint/correctness/noUndeclaredVariables: Injected by Vite during the build.
		revision: __COMMIT_HASH__,
		versionUrl: `${import.meta.env.OTT_BASE_URL ?? ""}/api/status/version`,
	});
}
