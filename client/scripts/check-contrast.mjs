import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

// Pair roles within Vuetify; these are not blanket cross-file equivalences.
// Teal intentionally differs: CSS signal is #6ff0e2 (f33df4d), while Vuetify
// secondary remains #ffd166. Check each palette's contrast independently.
const vuetifyTokens = {
	"primary": "primary",
	"signal": "secondary",
	"background": "background",
	"card": "surface",
	"foreground": "on-background",
	"card-foreground": "on-surface",
	"primary-foreground": "on-primary",
	"warning": "warning",
};

// Only roles changed by the light-theme contrast fix must stay synchronized.
// Vuetify has no ring or accent-foreground token: the changed CSS focus ring
// follows primary, and light's changed accent text shares the warning colour.
const changedTokens = {
	light: {
		"primary": "primary",
		"signal": "secondary",
		"warning": "warning",
		"accent-foreground": "warning",
		"ring": "primary",
	},
	strawberry: { primary: "primary", signal: "secondary", warning: "warning", ring: "primary" },
	mint: { primary: "primary", signal: "secondary", warning: "warning", ring: "primary" },
};

const pairs = [
	["foreground", "background", 4.5],
	["foreground", "card", 4.5],
	["card-foreground", "card", 4.5],
	["primary-foreground", "primary", 4.5],
	["primary", "background", 4.5],
	["primary", "card", 4.5],
	["signal", "background", 4.5],
	["signal", "card", 4.5],
	["warning", "card", 4.5],
	["accent-foreground", "accent", 4.5],
	["muted-foreground", "background", 4.5],
	["muted-foreground", "card", 4.5],
	["ring", "background", 3],
];

function normalizeHex(value) {
	assert.match(
		value ?? "",
		/^#(?:[\da-f]{3}|[\da-f]{6})$/i,
		`Expected opaque hex colour: ${value}`,
	);
	const hex = value.slice(1).toLowerCase();
	return `#${hex.length === 3 ? [...hex].map(char => char + char).join("") : hex}`;
}

// WCAG 2.x relative luminance of opaque sRGB colours (not rounded for comparisons).
export function contrastRatio(foreground, background) {
	const luminance = value => {
		const hex = normalizeHex(value).slice(1);
		const channels = [0, 2, 4].map(offset => {
			const channel = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
			return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
		});
		return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
	};
	const a = luminance(foreground);
	const b = luminance(background);
	return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

function parseCss(source) {
	const themes = new Map();
	for (const [, name, block] of source.matchAll(
		/\[data-theme=["']([^"']+)["']\]\s*\{([^{}]*)\}/g,
	)) {
		assert(!themes.has(name), `Duplicate CSS theme: ${name}`);
		const colors = Object.fromEntries(
			[...block.matchAll(/--([\w-]+)\s*:\s*([^;]+);/g)].map(([, key, value]) => [
				key,
				value.trim(),
			]),
		);
		const scheme = block.match(/\bcolor-scheme:\s*(dark|light)\s*;/)?.[1];
		assert(scheme, `Missing color-scheme: ${name}`);
		themes.set(name, { colors, dark: scheme === "dark" });
	}
	assert(themes.size > 0, "No CSS theme blocks found");
	return themes;
}

function parseVuetify(source) {
	const definitions = new Map();
	for (const [, name, block] of source.matchAll(
		/const\s+(\w+)\s*:\s*ThemeDefinition\s*=\s*\{([\s\S]*?)\n\};/g,
	)) {
		assert(!definitions.has(name), `Duplicate Vuetify definition: ${name}`);
		const colorBlock = block.match(/\bcolors:\s*\{([^{}]*)\}/)?.[1];
		assert(colorBlock, `Missing Vuetify colours: ${name}`);
		const colors = {};
		for (const entry of colorBlock
			.split(",")
			.map(value => value.trim())
			.filter(Boolean)) {
			const match = entry.match(
				/^(?:"([\w-]+)"|'([\w-]+)'|(\w+))\s*:\s*["'](#[\da-f]+)["']$/i,
			);
			assert(match, `Unsupported Vuetify colour declaration: ${name}: ${entry}`);
			const key = match[1] ?? match[2] ?? match[3];
			assert(!(key in colors), `Duplicate Vuetify colour: ${name}.${key}`);
			colors[key] = normalizeHex(match[4]);
		}
		const dark = block.match(/\bdark:\s*(true|false)\s*,/)?.[1];
		assert(dark, `Missing Vuetify dark flag: ${name}`);
		definitions.set(name, { colors, dark: dark === "true" });
	}
	assert(definitions.size > 0, "No Vuetify ThemeDefinition objects found");
	const registry = source.match(/\bthemes:\s*\{([^{}]*)\}/)?.[1];
	assert(registry, "Missing Vuetify theme registry");
	const themes = new Map();
	for (const entry of registry
		.split(",")
		.map(value => value.trim())
		.filter(Boolean)) {
		const match = entry.match(/^(\w+)\s*:\s*(\w+)$/);
		assert(match, `Unsupported Vuetify theme registration: ${entry}`);
		const [, name, definition] = match;
		assert(!themes.has(name), `Duplicate Vuetify theme: ${name}`);
		assert(definitions.has(definition), `Missing Vuetify definition: ${definition}`);
		themes.set(name, definitions.get(definition));
	}
	assert.equal(themes.size, definitions.size, "Unregistered Vuetify ThemeDefinition");
	return themes;
}

export function checkContrast(cssSource, vuetifySource) {
	const stripComments = source => source.replace(/\/\*[\s\S]*?\*\//g, "");
	const css = parseCss(stripComments(cssSource));
	const vuetify = parseVuetify(stripComments(vuetifySource).replace(/\/\/[^\n]*/g, ""));
	assert.deepEqual(
		[...css.keys()].sort(),
		[...vuetify.keys()].sort(),
		"Theme names differ between files",
	);
	const rows = [];
	const errors = [];
	const worst = {};
	for (const [theme, { colors, dark }] of css) {
		const componentTheme = vuetify.get(theme);
		assert.equal(dark, componentTheme.dark, `Theme mode differs: ${theme}`);
		for (const [cssKey, vuetifyKey] of Object.entries(changedTokens[theme] ?? {})) {
			const cssColor = normalizeHex(colors[cssKey]);
			const componentColor = normalizeHex(componentTheme.colors[vuetifyKey]);
			if (cssColor !== componentColor) {
				errors.push(
					`${theme}: CSS --${cssKey} ${cssColor} != Vuetify ${vuetifyKey} ${componentColor}`,
				);
			}
		}
		worst[theme] = Infinity;
		for (const [fg, bg, threshold] of pairs) {
			const sources = [["CSS", colors[fg], colors[bg]]];
			if (vuetifyTokens[fg] && vuetifyTokens[bg]) {
				sources.push([
					"Vuetify",
					componentTheme.colors[vuetifyTokens[fg]],
					componentTheme.colors[vuetifyTokens[bg]],
				]);
			}
			for (const [source, foreground, background] of sources) {
				const ratio = contrastRatio(foreground, background);
				const passed = ratio >= threshold;
				rows.push({
					theme,
					source,
					fg: `${fg} ${foreground}`,
					bg: `${bg} ${background}`,
					ratio,
					threshold,
					passed,
				});
				worst[theme] = Math.min(worst[theme], ratio);
				if (!passed)
					errors.push(
						`${theme} (${source}): ${fg}/${bg} ${ratio.toFixed(4)} < ${threshold}`,
					);
			}
		}
	}
	return { rows, errors, worst };
}

function main() {
	try {
		const css = readFileSync(new URL("../src/styles/cinema.scss", import.meta.url), "utf8");
		const vuetify = readFileSync(new URL("../src/plugins/vuetify.ts", import.meta.url), "utf8");
		const { rows, errors, worst } = checkContrast(css, vuetify);
		process.stdout.write(
			"theme       source   fg                                  bg                            ratio  min  result\n",
		);
		for (const row of rows) {
			process.stdout.write(
				`${row.theme.padEnd(11)} ${row.source.padEnd(8)} ${row.fg.padEnd(
					35,
				)} ${row.bg.padEnd(29)} ${row.ratio.toFixed(4).padStart(6)} ${row.threshold.toFixed(
					1,
				)}  ${row.passed ? "PASS" : "FAIL"}\n`,
			);
		}
		process.stdout.write(
			`\nWorst ratio per theme: ${Object.entries(worst)
				.map(([theme, ratio]) => `${theme} ${ratio.toFixed(4)}`)
				.join(", ")}\n`,
		);
		if (errors.length) {
			process.stderr.write(`\n${errors.join("\n")}\n`);
			process.exitCode = 1;
		} else {
			process.stdout.write(
				`PASS: ${Object.keys(worst).length} themes, ${
					rows.length
				} contrast pairs; changed light-theme colours agree (legacy teal difference preserved).\n`,
			);
		}
	} catch (error) {
		process.stderr.write(`Contrast check failed: ${error.message}\n`);
		process.exitCode = 1;
	}
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) main();
