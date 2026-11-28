import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { gzipSync } from "node:zlib";

// PF10: Vuetify's component styles are already injected per component by
// vite-plugin-vuetify (each component module imports its own CSS, and the plugin compiles
// that import through vuetify-settings.scss). Only the shared base sheet comes from
// `import "vuetify/styles"`. This guard keeps it that way: the full Vuetify stylesheet is
// 598 KB (74 KB gzip), the vendor bundle here is a fraction of that, and none of the
// components the app never imports may reappear.
const ASSETS_DIR = new URL("../dist/assets/", import.meta.url);
const MAX_VENDOR_BYTES = 170_000;
const MAX_VENDOR_GZIP_BYTES = 24_000;

// Components this app never renders. Their presence means the full stylesheet (or a
// component barrel import) crept back in.
const UNUSED_SELECTORS = [
	".v-data-table",
	".v-color-picker",
	".v-date-picker",
	".v-carousel",
	".v-timeline",
	".v-stepper",
];

// Utilities and the colour pack are disabled in vuetify-settings.scss.
const FORBIDDEN_UTILITIES = [".bg-red", ".text-red", ".d-flex"];

function main() {
	let files;
	try {
		files = readdirSync(ASSETS_DIR).filter(file => file.endsWith(".css"));
	} catch {
		process.stderr.write("No client/dist/assets found. Run the client build first.\n");
		process.exitCode = 1;
		return;
	}
	assert(files.length > 0, "The client build produced no CSS assets");
	const entries = files
		.map(file => {
			const path = new URL(file, ASSETS_DIR);
			const bytes = statSync(path).size;
			const gzip = gzipSync(readFileSync(path)).length;
			return { file, bytes, gzip };
		})
		.sort((a, b) => b.bytes - a.bytes);
	const vendor = entries.find(entry => entry.file.startsWith("vendor-"));
	assert(vendor, "No vendor-*.css asset found");

	const errors = [];
	if (vendor.bytes > MAX_VENDOR_BYTES) {
		errors.push(
			`vendor CSS is ${(vendor.bytes / 1000).toFixed(1)} KB, budget ${(
				MAX_VENDOR_BYTES / 1000
			).toFixed(0)} KB`,
		);
	}
	if (vendor.gzip > MAX_VENDOR_GZIP_BYTES) {
		errors.push(
			`vendor CSS is ${(vendor.gzip / 1000).toFixed(1)} KB gzip, budget ${(
				MAX_VENDOR_GZIP_BYTES / 1000
			).toFixed(0)} KB`,
		);
	}
	const css = readFileSync(new URL(vendor.file, ASSETS_DIR), "utf8");
	for (const selector of [...UNUSED_SELECTORS, ...FORBIDDEN_UTILITIES]) {
		if (css.includes(selector)) {
			errors.push(`vendor CSS contains ${selector}, the full stylesheet may be back`);
		}
	}

	process.stdout.write("client CSS assets:\n");
	for (const entry of entries.slice(0, 6)) {
		process.stdout.write(
			`  ${entry.file.padEnd(40)} ${(entry.bytes / 1000).toFixed(1).padStart(7)} KB ${(
				entry.gzip / 1000
			)
				.toFixed(1)
				.padStart(6)} KB gzip\n`,
		);
	}
	if (errors.length) {
		process.stderr.write(`${errors.join("\n")}\n`);
		process.exitCode = 1;
	} else {
		process.stdout.write(
			`PASS: Vuetify CSS is per-component (vendor ${(vendor.bytes / 1000).toFixed(
				1,
			)} KB / ${(vendor.gzip / 1000).toFixed(1)} KB gzip, no unused components or utilities).\n`,
		);
	}
}

main();
