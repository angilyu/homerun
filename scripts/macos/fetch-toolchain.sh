#!/usr/bin/env bash
# Stage every helper executable the app bundle ships (§5.1) into
# apps/desktop/src-tauri/binaries/ with Tauri's target-triple suffix:
#   - homerund : the runtime from apps/homerund, Bun-compiled, release channel (§11)
#   - claude   : from the Agent SDK's pinned platform package in node_modules, keeping
#                Anthropic's Developer ID signature (F4 in docs/spike-results.md)
# Node and uv are on-demand components, not part of the bundle (§5.5), so nothing is downloaded.
#
#   HOMERUND_VERSION=0.0.2 scripts/macos/fetch-toolchain.sh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
OUT="$ROOT/apps/desktop/src-tauri/binaries"
BUN="$ROOT/node_modules/.bin/bun"; "$BUN" --version | grep -qx 1.4.2 || { echo "need pinned bun 1.4.2 (pnpm install)" >&2; exit 1; }

# Helpers staged by earlier milestones' bundles; the app no longer ships them.
rm -rf "$OUT/npm" "$OUT"/node-* "$OUT"/uv-*
( cd "$ROOT/apps/desktop" && HOMERUND_VERSION="${HOMERUND_VERSION:-0.0.1}" "$BUN" scripts/stage-sidecars.ts --release )
ls -lh "$OUT"
