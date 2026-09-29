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
	const binds = block.binds.filter(name => name !== "HOOKED");
	const primary = pickPrimary(body, binds);
	const primaryIsVideo = mainIsVideo && primary === "MAIN";
	const usesBase = BASE_DIRECTIVE.test(body) && primary !== "MAIN";
	const baseIsVideo = mainIsVideo;

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
	lines.push(`#define ${primary}_pos p`);
	lines.push(`#define ${primary}_size uSize`);
	lines.push(`#define ${primary}_pt uTexel`);
	if (usesBase) {
		lines.push("#define MAIN_pos p");
		lines.push(`#define MAIN_tex(uv) (texture(uBase, ${read("(uv)", baseIsVideo)}))`);
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
		baseVideo: baseIsVideo,
		scale: SCALE_MARKER.test(block.header) ? 2 : 1,
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

const [restoreFile, upscaleFile, outFile] = process.argv.slice(2);
const restore = parse(restoreFile).map((block, index) => buildPass(block, index, true));
const upscale = parse(upscaleFile).map((block, index) =>
	buildPass(block, restore.length + index, false),
);

const describe = (pass, index) => `\t{
\t\tname: ${JSON.stringify(pass.name)},
\t\tdesc: ${JSON.stringify(pass.desc)},
\t\tvideo: ${pass.video},
\t\tbase: ${pass.base},
\t\tbaseVideo: ${pass.baseVideo},
\t\tscale: ${pass.scale},
\t\tfragment: PASS_${index},
\t}`;

const fragments = [...restore, ...upscale];
const out = `// Generated from Anime4K v4.0.1 (bloc97/Anime4K, MIT) by
// scripts/anime4k-glsl-to-webgl2.mjs — do not edit by hand. The convolution weights are the
// official ones, byte for byte; only the mpv hook macros were rewritten (see the script).
//
// Chain: Restore_CNN_S (3 passes at the source resolution) then Upscale_CNN_x2_S (3 passes at
// the source resolution plus a depth-to-space pass at 2x). A pass marked video convolves the
// video frame itself, one marked base also samples the picture it adds its result to.

export interface Anime4KPassSpec {
	/** The intermediate the pass writes, or the pass's role. */
	name: string;
	desc: string;
	/** True when the pass reads the video texture rather than a render target. */
	video: boolean;
	/** True when the pass also samples a base picture to add its result to. */
	base: boolean;
	/** True when that base picture is the video texture (the restore chain's base). */
	baseVideo: boolean;
	/** 2 for the depth-to-space pass that carries the x2 upscale, 1 for every other pass. */
	scale: number;
	fragment: string;
}

${fragments.map((pass, index) => `const PASS_${index} = ${JSON.stringify(pass.fragment)};`).join("\n\n")}

export const ANIME4K_RESTORE_PASSES: Anime4KPassSpec[] = [
${restore.map((pass, index) => describe(pass, index)).join(",\n")},
];

export const ANIME4K_UPSCALE_PASSES: Anime4KPassSpec[] = [
${upscale.map((pass, index) => describe(pass, restore.length + index)).join(",\n")},
];
`;

writeFileSync(outFile, out);
console.log(
	`restore: ${restore.map(p => `${p.name}${p.video ? "(video)" : ""}${p.base ? "(+base)" : ""}x${p.scale}`).join(" -> ")}`,
);
console.log(
	`upscale: ${upscale.map(p => `${p.name}${p.video ? "(video)" : ""}${p.base ? "(+base)" : ""}x${p.scale}`).join(" -> ")}`,
);
console.log(`\n--- first pass ---\n${restore[0].fragment.split("\n").slice(0, 22).join("\n")}`);
console.log(
	`\n--- last pass ---\n${upscale[upscale.length - 1].fragment.split("\n").slice(0, 20).join("\n")}`,
);
