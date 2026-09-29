import { describe, expect, it } from "vitest";
import { ANIME4K_WEBGL_SHADERS } from "@/util/upscale/anime4k-webgl";
import { EASU_FRAGMENT_SHADER, SHARPEN_FRAGMENT_SHADER, VERTEX_SHADER } from "@/util/upscale/cas";
import { CLEAN_FRAGMENT_SHADER } from "@/util/upscale/film";

/**
 * Words GLSL ES 3.00 keeps for itself, so a shader that assigns one of them cannot compile.
 * `flat` is an interpolation qualifier, and using it as a variable name in the clean pass made
 * the film tier fall back to plain sharpening in every browser — the tier never ran anywhere.
 * The sources are scanned instead of compiled so that class of mistake cannot reach a GPU again.
 */
const RESERVED_WORDS = [
	"active",
	"asm",
	"cast",
	"class",
	"common",
	"double",
	"enum",
	"extern",
	"external",
	"filter",
	"fixed",
	"flat",
	"goto",
	"half",
	"inline",
	"input",
	"interface",
	"long",
	"namespace",
	"noinline",
	"output",
	"packed",
	"partition",
	"patch",
	"precise",
	"public",
	"resource",
	"short",
	"sizeof",
	"static",
	"superp",
	"template",
	"this",
	"typedef",
	"union",
	"unsigned",
	"using",
];

const SHADERS: Record<string, string> = {
	"sharpen vertex": VERTEX_SHADER,
	"sharpen fragment": SHARPEN_FRAGMENT_SHADER,
	"EASU fragment": EASU_FRAGMENT_SHADER,
	"film clean fragment": CLEAN_FRAGMENT_SHADER,
	...Object.fromEntries(
		ANIME4K_WEBGL_SHADERS.map((source, index) => [`anime4k webgl pass ${index + 1}`, source]),
	),
};

describe("GLSL ES 3.00 shader sources", () => {
	for (const [name, source] of Object.entries(SHADERS)) {
		it(`${name} avoids reserved words`, () => {
			// Comments may name the words they warn about; only code has to be clean.
			const code = source.replace(/\/\/[^\n]*/g, "");
			for (const word of RESERVED_WORDS) {
				expect(code, `${name} uses the reserved word "${word}"`).not.toMatch(
					new RegExp(`\\b${word}\\b`),
				);
			}
		});
	}
});
