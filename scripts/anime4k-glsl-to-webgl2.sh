#!/bin/bash
# Regenerates the WebGL2 Anime4K modules from the official v4.0.1 GLSL sources.
#
# Usage: scripts/anime4k-glsl-to-webgl2.sh <directory holding the official .glsl files>
#
# mpv runs a file's PREKERNEL pass after every MAIN pass of the chain, and Clamp_Highlights relies
# on that: its statistics describe the untouched picture, and its clamp then removes the overshoot
# the restores added. Splitting the file is what keeps that order — and the per-file video reads —
# right for the converter, so the clamp ends up last in the chain instead of first.
set -euo pipefail

src="${1:?usage: scripts/anime4k-glsl-to-webgl2.sh <official glsl dir>}"
root="$(cd "$(dirname "$0")/.." && pwd)"
out="$root/client/src/util/upscale"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

awk '/^\/\/!DESC .*De-Ring-Clamp/ { exit } { print }' \
	"$src/Anime4K_Clamp_Highlights.glsl" > "$tmp/Clamp-Highlights-Statistics.glsl"
awk '/^\/\/!DESC .*De-Ring-Clamp/ { found = 1 } found { print }' \
	"$src/Anime4K_Clamp_Highlights.glsl" > "$tmp/Clamp-Highlights-Clamp.glsl"

node "$root/scripts/anime4k-glsl-to-webgl2.mjs" \
	"$src/Anime4K_Restore_CNN_S.glsl" \
	"$src/Anime4K_Upscale_CNN_x2_S.glsl" \
	"$out/anime4k-glsl.ts"

node "$root/scripts/anime4k-glsl-to-webgl2.mjs" \
	"$tmp/Clamp-Highlights-Statistics.glsl" \
	"$src/Anime4K_Restore_CNN_VL.glsl" \
	"$src/Anime4K_Upscale_CNN_x2_VL.glsl" \
	"$src/Anime4K_Restore_CNN_M.glsl" \
	"$src/Anime4K_Upscale_CNN_x2_M.glsl" \
	"$tmp/Clamp-Highlights-Clamp.glsl" \
	"$out/anime4k-ultra-glsl.ts"

echo "regenerated anime4k-glsl.ts and anime4k-ultra-glsl.ts"
