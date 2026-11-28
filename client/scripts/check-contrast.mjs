import assert from "node:assert/strict";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { loadPalettes, themeCssVariables } from "./generate-theme-css.mjs";

// Pair roles within Vuetify; these are not blanket cross-file equivalences.
// Teal intentionally differs: CSS signal is #6ff0e2 (f33df4d), while Vuetify
// secondary remains #ffd166. Check each palette's contrast independently.
const changedTokens = {
	light: {
		primary: "primary",
		signal: "secondary",
		warning: "warning",
		"accent-foreground": "warning",
		ring: "primary",
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

const HEX_RE = /^#(?:[\da-f]{3}|[\da-f]{6})$/i;

function normalizeHex(value) {
	assert.match(value ?? "", HEX_RE, `Expected opaque hex colour: ${value}`);
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

/**
 * Check the resolved pairs for every palette in the single theme source. The CSS values
 * are derived from the same JSON as the Vuetify colours, so this is a contrast audit
 * rather than a drift check; the light/strawberry/mint assertions stay because those are
 * the roles the contrast fix deliberately tied together.
 */
export function checkContrast(palettes) {
	const rows = [];
	const errors = [];
	const worst = {};
	for (const [theme, palette] of Object.entries(palettes)) {
		const colors = themeCssVariables(palette, theme);
		const componentColors = palette.colors;
		for (const [cssKey, vuetifyKey] of Object.entries(changedTokens[theme] ?? {})) {
			const cssColor = normalizeHex(colors[cssKey]);
			const componentColor = normalizeHex(componentColors[vuetifyKey]);
			if (cssColor !== componentColor) {
				errors.push(
					`${theme}: CSS --${cssKey} ${cssColor} != Vuetify ${vuetifyKey} ${componentColor}`,
				);
			}
		}
		worst[theme] = Infinity;
		for (const [fg, bg, threshold] of pairs) {
			const ratio = contrastRatio(colors[fg], colors[bg]);
			const passed = ratio >= threshold;
			rows.push({ theme, fg, bg, ratio, threshold, passed });
			worst[theme] = Math.min(worst[theme], ratio);
			if (!passed) {
				errors.push(`${theme}: ${fg}/${bg} ${ratio.toFixed(4)} < ${threshold}`);
			}
		}
	}
	return { rows, errors, worst };
}

function main() {
	try {
		const { rows, errors, worst } = checkContrast(loadPalettes());
		if (process.argv.includes("--verbose")) {
			process.stdout.write(
				"theme       fg                                  bg                            ratio  min  result\n",
			);
			for (const row of rows) {
				process.stdout.write(
					`${row.theme.padEnd(11)} ${row.fg.padEnd(35)} ${row.bg.padEnd(
						29,
					)} ${row.ratio.toFixed(4).padStart(6)} ${row.threshold.toFixed(1)}  ${
						row.passed ? "PASS" : "FAIL"
					}\n`,
				);
			}
			process.stdout.write("\n");
		}
		if (errors.length) {
			process.stderr.write(`${errors.join("\n")}\n`);
			process.exitCode = 1;
		} else {
			process.stdout.write(
				`PASS: ${Object.keys(worst).length} themes, ${
					rows.length
				} contrast pairs; worst ${Object.entries(worst)
					.map(([theme, ratio]) => `${theme} ${ratio.toFixed(4)}`)
					.join(", ")}. Use --verbose for the table.\n`,
			);
		}
	} catch (error) {
		process.stderr.write(`Contrast check failed: ${error.message}\n`);
		process.exitCode = 1;
	}
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
	main();
}
