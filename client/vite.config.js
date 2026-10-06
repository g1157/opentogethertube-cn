import childProcess from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import vue from "@vitejs/plugin-vue";
import { defineConfig, searchForWorkspaceRoot } from "vite";
import vuetify from "vite-plugin-vuetify";

const require = createRequire(import.meta.url);

/**
 * vite-plugin-vuetify rewrites components in SFC templates into imports such as
 * `vuetify/components/VBtn`, which Vite's initial dependency scan cannot see. Left to
 * discovery, the first render of each new component triggers a re-optimization and a full
 * page reload — several of them per cold start, which reads as an extremely slow page load.
 * Listing the subpaths up front moves that work to server start and keeps the session
 * reload-free.
 */
function vuetifyComponentEntries() {
	try {
		const componentsDir = path.dirname(require.resolve("vuetify/components"));
		return (
			fs
				.readdirSync(componentsDir, { withFileTypes: true })
				.filter(entry => entry.isDirectory())
				.map(entry => entry.name)
				// VOverflowBtn (deprecated) imports a CSS file that no longer ships; pre-bundling
				// it would fail the whole optimizer run.
				.filter(name => name !== "VOverflowBtn")
				.map(name => `vuetify/components/${name}`)
		);
	} catch {
		// Vuetify is not resolvable (e.g. an install is in progress): fall back to discovery.
		return [];
	}
}

function gitCommit() {
	if (process.env.GIT_COMMIT) {
		return process.env.GIT_COMMIT.trim();
	}
	try {
		return childProcess.execSync("git rev-parse --short HEAD").toString().trim();
		// biome-ignore lint/correctness/noUnusedVariables: biome migration
	} catch (e) {
		// eslint-disable-next-line no-console
		console.warn("Failed to get git commit hash");
		return "unknown";
	}
}
// https://vitejs.dev/config/
export default defineConfig({
	define: {
		__COMMIT_HASH__: JSON.stringify(gitCommit()),
	},
	// Strip debug logging from production bundles; dev keeps it and console.debug/warn/error stay.
	esbuild: {
		pure: ["console.log", "console.info"],
	},
	base: process.env.OTT_BASE_URL || "/",
	plugins: [
		vue(),
		vuetify({
			autoImport: true,
			styles: {
				configFile: path.resolve(
					searchForWorkspaceRoot(process.cwd()),
					"client/src/vuetify-settings.scss",
				),
			},
		}),
	],
	// css: {
	// 	preprocessorOptions: {
	// 		scss: {
	// 			// unfortunately, some of our dependencies use deprecated sass features, and we can't really do much about it
	// 			silenceDeprecations: ["import", "global-builtin"],
	// 			quietDeps: true,
	// 		},
	// 	},
	// },
	resolve: {
		alias: {
			"@": path.resolve(searchForWorkspaceRoot(process.cwd()), "client/src"),
		},
	},
	server: {
		port: 8080,
		proxy: {
			"^/api": {
				target: "http://localhost:3000",
				ws: true,
			},
		},
	},
	envDir: path.resolve(searchForWorkspaceRoot(process.cwd()), "env"),
	envPrefix: ["VITE_", "VUE_APP_", "OTT_"],
	build: {
		rollupOptions: {
			output: {
				manualChunks(id) {
					if (!id.includes("node_modules")) {
						return;
					}
					// Keep lazily imported players and the WebGL shaders bundle (with three.js)
					// in their own async chunks instead of the startup vendor chunk.
					// anime4k-webgpu is reached only through a dynamic import in
					// util/upscale/anime4k.ts; without this it lands in the startup vendor
					// chunk and every page pays for 3.4MB of WebGPU code nobody asked for.
					if (
						id.includes("hls.js") ||
						id.includes("dashjs") ||
						id.includes("node_modules/shaders") ||
						id.includes("node_modules/three") ||
						id.includes("anime4k-webgpu")
					) {
						return;
					}
					return "vendor";
				},
			},
		},
	},
	// Vitest loads this config too and handles vuetify through its own deps pipeline (see
	// test.server.deps.inline below); forcing the dev pre-bundle there breaks its module
	// runner with raw .css imports, so keep the include list dev-only.
	optimizeDeps: process.env.VITEST
		? undefined
		: {
				include: [
					"vuetify",
					"vuetify/components",
					"vuetify/directives",
					...vuetifyComponentEntries(),
				],
			},
	test: {
		environment: "jsdom",
		server: {
			deps: {
				inline: ["vuetify"],
			},
		},
	},
});
