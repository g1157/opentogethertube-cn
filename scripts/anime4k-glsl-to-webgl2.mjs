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
// In mpv the name MAIN means "the picture as it stands at this point in the chain". It starts out
// as the video frame and stays that way until a pass writes the picture — everything before that
// samples a texture that is stored flipped relative to the render targets, so those reads flip.
// The mainIsVideo flag the converter threads through the files decides exactly that.
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
const DIRECTIVE_LINE = /^\/\/![^\n]*\n/gm;
const HOOK_SIGNATURE = /^vec4 hook\s*\(\s*\)\s*\{/m;
// Trailing whitespace is common in the official sources; `;$` alone misses those lines.
const RETURN_STATEMENT = /^(\s*)return\s+([^\n;]+);\s*$/gm;
const SCALE_MARKER = /2 \*/;
const DESC_SPLIT = /^\/\/!DESC /m;
const BIND_LINE = /^\/\/!BIND (.+)$/gm;
const SAVE_LINE = /^\/\/!SAVE (.+)$/m;

function buildPass(block, index, mainIsVideo) {
	// HOOKED is mpv's name for "the picture this hook runs on"; in a shader it is MAIN.
	const body = block.body.replace(DIRECTIVE_LINE, "").replace(/HOOKED_/g, "MAIN_");
	const binds = block.binds.map(name => (name === "HOOKED" ? "MAIN" : name));
	const primary = pickPrimary(body, binds);
	const primaryIsVideo = mainIsVideo && primary === "MAIN";
	// Every texture the hook samples, primary first. The CNN chains split each layer into a pair
	// of feature-map halves and the next layer reads both, so a pass can genuinely need two.
	const readers = [
		primary,
		...binds.filter(
			name => name !== primary && new RegExp(`\\b${name}_(tex|texOff|pos)\\b`).test(body),
		),
	];
	// The combination layers (3x1x1x112) gather a whole model's worth of feature-map halves at
	// once, so the sampler count follows the pass rather than the other way round.
	if (readers.length > 15) {
		throw new Error(`${block.desc}: ${readers.length} textures is past WebGL2's unit count`);
	}
	// mpv's MAIN is "the picture as it stands at this point in the chain", i.e. the input of the
	// segment the pass belongs to; STATSMAX and friends stay named.
	const readNames = readers.map(name => (name === "MAIN" ? "input" : name));
	const readIsVideo = readers.map(name => mainIsVideo && name === "MAIN");

	const read = (uv, flip) => (flip ? `vec2((${uv}).x, 1.0 - (${uv}).y)` : uv);
	const lines = [FRAGMENT_HEADER, ""];
	readers.slice(1).forEach((_, unit) => {
		lines.push(`uniform sampler2D uTexture${unit + 1};`);
	});
	if (readers.length > 1) {
		lines.push("");
	}
	// uTexel/uSize describe the first reader; a second one is taken to share its geometry, which
	// holds for the feature-map halves this exists for.
	readers.forEach((name, unit) => {
		const sampler = unit === 0 ? "uTexture" : `uTexture${unit}`;
		lines.push(
			`#define ${name}_texOff(off) (texture(${sampler}, ${read(
				`(p + (off) * uTexel)`,
				readIsVideo[unit],
			)}))`,
		);
		lines.push(
			`#define ${name}_tex(uv) (texture(${sampler}, ${read("(uv)", readIsVideo[unit])}))`,
		);
		lines.push(`#define ${name}_pos p`);
		lines.push(`#define ${name}_size uSize`);
		lines.push(`#define ${name}_pt uTexel`);
	});
	// mpv defines these for every hook; a pass may use them without binding MAIN by that name.
	lines.push("#ifndef MAIN_pos", "#define MAIN_pos p", "#endif");
	lines.push("#ifndef MAIN_size", "#define MAIN_size uSize", "#endif");
	lines.push("#ifndef MAIN_pt", "#define MAIN_pt uTexel", "#endif");
	lines.push("");
	// Only the hook's own returns become writes to the output; helper functions kept above it
	// (Clamp_Highlights has get_luma) must keep their returns intact.
	const hookAt = body.search(HOOK_SIGNATURE);
	const helpers = hookAt > 0 ? body.slice(0, hookAt) : "";
	const hook = body
		.slice(Math.max(hookAt, 0))
		.replace(HOOK_SIGNATURE, "void main() {\n\tvec2 p = vUv;")
		.replace(RETURN_STATEMENT, "$1outColor = $2;\n$1return;");
	const converted = helpers + hook;
	lines.push(converted.trim());
	return {
		name: block.save ?? "output",
		desc: block.desc,
		header: block.header,
		video: primaryIsVideo,
		reads: readNames,
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
// mpv's MAIN starts out as the video texture and stops being it the moment a pass replaces the
// picture — a `//!SAVE MAIN`, or no SAVE at all, both do. Files that only write feature maps leave
// it alone, which is why a statistics-only file at the head does not turn the video into a render
// target: the file that runs next still samples the video and has to flip its reads.
let pictureIsVideo = true;
const segments = files.map(file => {
	const blocks = parse(file);
	const passes = blocks.map(block => buildPass(block, 0, pictureIsVideo));
	if (blocks.some(block => !block.save || block.save === "MAIN")) {
		pictureIsVideo = false;
	}
	return { file: file.replace(LEADING_PATH, "").replace(GLSL_SUFFIX, ""), passes };
});
let cursor = 0;
const segmentRanges = segments.map(segment => segment.passes.map(() => cursor++));
const all = segments.flatMap(segment => segment.passes);

const header = [
	"// Generated from the official Anime4K v4.0.1 GLSL by scripts/anime4k-glsl-to-webgl2.mjs —",
	"// do not edit by hand. The convolution weights are the official ones, byte for byte; only the",
	"// mpv hook macros were rewritten (see the script). The passes run in file order, and a pass's",
	'// `"input"` is whatever holds the picture at that point: the video until a pass writes MAIN,',
	"// a render target afterwards. A pass marked upscaleOnly carries Anime4K's own",
	"// `//!WHEN OUTPUT > 1.2x MAIN` condition, so the driver only runs it when the target is",
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
	'\t/** The textures this pass samples, primary first. `"input"` is the segment\'s own input. */',
	"\treads: string[];",
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
