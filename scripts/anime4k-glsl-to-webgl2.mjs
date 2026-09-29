// Turns the official Anime4K mpv/GLSL shaders into WebGL2 fragment shaders for this repo.
//
// mpv's hook system provides, per pass: a bound input texture, a save target, and the macros
// <NAME>_tex(uv) / <NAME>_texOff(offset) / <NAME>_pos / <NAME>_size / <NAME>_pt. WebGL2 has no
// such system, so each pass here gets one sampler for its convolution input, one for the base
// picture it may add back, and the same macros redefined over vUv.
//
// Storage conventions, verified against the existing sharpen/film chains (see cas.ts): the
// video texture is stored flipped (its row 0 is the picture's bottom row), render targets and
// the canvas are stored video-style (row 0 is the picture's top row). Every shader therefore
// works in video-style coordinates; reads of the video flip, reads of a render target do not,
// and writes never flip.
//
// In mpv the name MAIN means "the picture as it stands at this point in the chain": the video
// frame inside the restore shader, and the restored picture inside the upscale shader. That is
// what the mainIsVideo switch decides.
import { readFileSync, writeFileSync } from "node:fs";

const FRAGMENT_HEADER = `#version 300 es
precision highp float;
uniform sampler2D uTexture;
uniform vec2 uTexel;
uniform vec2 uSize;
in vec2 vUv;
out vec4 outColor;`;

const LEADING_PATH = /^.*[/]/;
const GLSL_SUFFIX = /[.]glsl$/;
const UPSCALE_CONDITION = /1\.200 >/;
const BASE_DIRECTIVE = /\bMAIN_(tex|pos)\b/;
const DIRECTIVE_LINE = /^\/\/![^\n]*\n/gm;
const HOOK_SIGNATURE = /^vec4 hook\s*\(\s*\)\s*\{/m;
const RETURN_STATEMENT = /^(\s*)return\s+([^\n;]+);$/gm;
const SCALE_MARKER = /2 \*/;
const DESC_SPLIT = /^\/\/!DESC /m;
const BIND_LINE = /^\/\/!BIND (.+)$/gm;
const SAVE_LINE = /^\/\/!SAVE (.+)$/m;

function buildPass(block, index, mainIsVideo) {
	const body = block.body.replace(DIRECTIVE_LINE, "");
	const binds = block.binds.map(name => (name === "HOOKED" ? "MAIN" : name));
	const primary = pickPrimary(body, binds);
	const primaryIsVideo = mainIsVideo && primary === "MAIN";
	// The pass may sample a second texture: MAIN (the picture at this point in the chain) or,
	// for Clamp_Highlights, the statistics it computed a moment ago.
	const otherBind = binds.find(
		name => name !== primary && new RegExp(`\\b${name}_tex\\b`).test(body),
	);
	const usesBase = (BASE_DIRECTIVE.test(body) && primary !== "MAIN") || Boolean(otherBind);
	// mpv's MAIN is "the picture as it stands at this point in the chain", i.e. the input
	// of the segment the pass belongs to; STATSMAX and friends stay named.
	const baseName = !otherBind || otherBind === "MAIN" ? "input" : otherBind;
	const baseIsVideo = baseName === "input" && mainIsVideo;

	const read = (uv, flip) => (flip ? `vec2((${uv}).x, 1.0 - (${uv}).y)` : uv);
	const lines = [FRAGMENT_HEADER, ""];
	if (usesBase) {
		lines.push("uniform sampler2D uBase;", "");
	}
	if (primaryIsVideo) {
		lines.push("#define MAIN_pos p");
	}
	lines.push(
		`#define ${primary}_texOff(off) (texture(uTexture, ${read(
			`(p + (off) * uTexel)`,
			primaryIsVideo,
		)}))`,
	);
	lines.push(`#define ${primary}_tex(uv) (texture(uTexture, ${read("(uv)", primaryIsVideo)}))`);
	lines.push(`#define MAIN_size uSize`);
	lines.push(`#define MAIN_pt uTexel`);
	lines.push(`#define ${primary}_pos p`);
	lines.push(`#define ${primary}_size uSize`);
	lines.push(`#define ${primary}_pt uTexel`);
	if (usesBase) {
		lines.push(`#define ${baseName === "input" ? "MAIN" : baseName}_pos p`);
		lines.push(
			`#define ${baseName === "input" ? "MAIN" : baseName}_tex(uv) (texture(uBase, ${read("(uv)", baseIsVideo)}))`,
		);
	}
	lines.push("");
	let converted = body.replace(HOOK_SIGNATURE, "void main() {\n\tvec2 p = vUv;");
	converted = converted.replace(RETURN_STATEMENT, "$1outColor = $2;\n$1return;");
	lines.push(converted.trim());
	return {
		name: block.save ?? "output",
		desc: block.desc,
		header: block.header,
		video: primaryIsVideo,
		base: usesBase,
		baseName,
		baseVideo: baseIsVideo,
		scale: SCALE_MARKER.test(block.header) ? 2 : 1,
		pingPong: Boolean(block.save) && primary === block.save,
		upscaleOnly: UPSCALE_CONDITION.test(block.header),
		fragment: lines.join("\n"),
	};
}

function pickPrimary(body, binds) {
	const referenced = binds.filter(name =>
		new RegExp(`\\b${name}_(tex|texOff|pos)\\b`).test(body),
	);
	const withOffsets = referenced.find(name => new RegExp(`\\b${name}_texOff\\b`).test(body));
	if (withOffsets) {
		return withOffsets;
	}
	const nonBase = referenced.filter(name => name !== "MAIN");
	return nonBase[nonBase.length - 1] ?? referenced[0] ?? "MAIN";
}

function parse(file) {
	const text = readFileSync(file, "utf8");
	return text
		.split(DESC_SPLIT)
		.slice(1)
		.map(chunk => {
			const lines = chunk.split("\n");
			const headerLines = [];
			let index = 0;
			// The header is the contiguous run of //! directives that opens the block.
			headerLines.push("//!DESC " + lines[0]);
			for (index = 1; index < lines.length && lines[index].startsWith("//!"); index++) {
				headerLines.push(lines[index]);
			}
			const header = headerLines.join("\n");
			return {
				desc: lines[0].trim(),
				header,
				binds: [...header.matchAll(BIND_LINE)].map(m => m[1].trim()),
				save: header.match(SAVE_LINE)?.[1].trim(),
				body: lines.slice(index).join("\n").trimEnd(),
			};
		});
}

const files = process.argv.slice(2, -1);
const outFile = process.argv[process.argv.length - 1];
const segments = files.map((file, index) => ({
	file: file.replace(LEADING_PATH, "").replace(GLSL_SUFFIX, ""),
	passes: parse(file).map(block => buildPass(block, 0, index === 0)),
}));
let cursor = 0;
const segmentRanges = segments.map(segment => segment.passes.map(() => cursor++));
const all = segments.flatMap(segment => segment.passes);

const header = [
	"// Generated from the official Anime4K v4.0.1 GLSL by scripts/anime4k-glsl-to-webgl2.mjs —",
	"// do not edit by hand. The convolution weights are the official ones, byte for byte; only the",
	"// mpv hook macros were rewritten (see the script). Segments run in order, each reading the",
	"// previous segment's output. A pass marked upscaleOnly carries Anime4K's own",
	"// `//!WHEN OUTPUT > 1.2x MAIN` condition, so the driver only inserts it when the target is",
	"// large enough for the x2 stage.",
	"//",
	"// Sources: " + segments.map(segment => segment.file).join(", "),
].join("\n");

const passInterface = [
	"export interface Anime4KPassSpec {",
	"\t/** The intermediate the pass writes. */",
	"\tname: string;",
	"\tdesc: string;",
	"\t/** True when the pass reads the video texture rather than a render target. */",
	"\tvideo: boolean;",
	"\t/** True when the pass also samples a second texture. */",
	"\tbase: boolean;",
	'\t/** Which texture that is: "input" (the segment\'s own input) or a save name like STATSMAX. */',
	"\tbaseName: string;",
	"\t/** True when that second texture is the video texture (restore segments). */",
	"\tbaseVideo: boolean;",
	"\t/** 2 for a depth-to-space pass that carries the x2 upscale, 1 otherwise. */",
	"\tscale: number;",
	"\t/** True when the pass reads and writes the same name and needs double buffering. */",
	"\tpingPong: boolean;",
	"\t/** True when Anime4K only runs this pass above 1.2x magnification. */",
	"\tupscaleOnly: boolean;",
	"\tfragment: string;",
	"}",
].join("\n");

const fragments = all
	.map((pass, index) => "const PASS_" + index + " = " + JSON.stringify(pass.fragment) + ";")
	.join("\n\n");

const specs = all
	.map((pass, index) => {
		const { fragment, header, ...rest } = pass;
		return "\t{ ..." + JSON.stringify(rest) + ", fragment: PASS_" + index + " },";
	})
	.join("\n");

const out = [
	header,
	"",
	passInterface,
	"",
	fragments,
	"",
	"export const ANIME4K_PASSES: Anime4KPassSpec[] = [",
	specs,
	"];",
	"",
	"/** The chain as consecutive groups of pass indices; each group reads the previous group's output. */",
	"export const ANIME4K_SEGMENTS: number[][] = " + JSON.stringify(segmentRanges) + ";",
	"",
	"export const ANIME4K_SHADERS: string[] = ANIME4K_PASSES.map(pass => pass.fragment);",
	"",
].join("\n");

writeFileSync(outFile, out);
console.log(
	segments.map(segment => segment.file + ": " + segment.passes.length + " passes").join(" | "),
);
