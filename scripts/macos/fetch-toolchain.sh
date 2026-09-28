#!/usr/bin/env bash
# Stage every helper executable the app bundle ships (§5.1, §5.5) into
# apps/desktop/src-tauri/binaries/ with Tauri's target-triple suffix.
#   - homerund : Bun-compiled runtime (built here)
#   - claude   : from the pinned @anthropic-ai/claude-agent-sdk-darwin-arm64 package
#   - node     : official Node.js LTS, sha256-pinned (+ npm as a resource)
#   - uv       : Astral uv, sha256-pinned
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
OUT="$ROOT/apps/desktop/src-tauri/binaries"
VENDOR="$ROOT/.vendor"
TRIPLE="aarch64-apple-darwin"
NODE_VERSION="v24.21.0"
NODE_SHA256="bed7eea5325e1108f32ce5228ddd6a5f0f08a499ee42aa7442aea583702f6057"
UV_VERSION="0.12.19"
UV_SHA256="a9a8df1eedeb192f2e47e40e2faabfb387db4b850209118786d42f89dde3e0ba"
HOMERUND_VERSION="${HOMERUND_VERSION:-0.0.1}"
BUN="$ROOT/node_modules/.bin/bun"; "$BUN" --version | grep -qx 1.4.2 || { echo "need pinned bun 1.4.2 (pnpm install)" >&2; exit 1; }

mkdir -p "$OUT" "$VENDOR"

fetch() { # url sha256 dest
  if [[ ! -f "$3" ]] || ! echo "$2  $3" | shasum -a 256 -c --status; then
    curl -fsSL "$1" -o "$3"
  fi
  echo "$2  $3" | shasum -a 256 -c --status || { echo "sha256 mismatch for $1" >&2; exit 1; }
}

# Node
NODE_TGZ="$VENDOR/node-$NODE_VERSION-darwin-arm64.tar.gz"
fetch "https://nodejs.org/dist/$NODE_VERSION/node-$NODE_VERSION-darwin-arm64.tar.gz" "$NODE_SHA256" "$NODE_TGZ"
rm -rf "$VENDOR/node" && mkdir -p "$VENDOR/node" && tar -xzf "$NODE_TGZ" -C "$VENDOR/node" --strip-components 1
cp "$VENDOR/node/bin/node" "$OUT/node-$TRIPLE"
rm -rf "$OUT/npm" && cp -R "$VENDOR/node/lib/node_modules/npm" "$OUT/npm"

# uv
UV_TGZ="$VENDOR/uv-$UV_VERSION.tar.gz"
fetch "https://github.com/astral-sh/uv/releases/download/$UV_VERSION/uv-aarch64-apple-darwin.tar.gz" "$UV_SHA256" "$UV_TGZ"
rm -rf "$VENDOR/uv" && mkdir -p "$VENDOR/uv" && tar -xzf "$UV_TGZ" -C "$VENDOR/uv" --strip-components 1
cp "$VENDOR/uv/uv" "$OUT/uv-$TRIPLE"

# claude (keeps Anthropic's Developer ID signature as shipped; see F4 in docs/spike-results.md)
CLAUDE_SRC="$(ls -d "$ROOT"/node_modules/.pnpm/@anthropic-ai+claude-agent-sdk-darwin-arm64@*/node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude | head -1)"
cp "$CLAUDE_SRC" "$OUT/claude-$TRIPLE"

# homerund: the desktop shell still speaks the milestone 0 spike protocol (run.start, keychain.*,
# helpers.check), so the bundle keeps the spike runtime until the shell moves to the real protocol (M7).
( cd "$ROOT/spikes/homerund-m0" && "$ROOT/node_modules/.bin/bun" build --compile --minify --define "HOMERUND_VERSION=\"$HOMERUND_VERSION\"" ./src/main.ts --outfile "$OUT/homerund-$TRIPLE" >/dev/null )

chmod 755 "$OUT"/*-"$TRIPLE"
ls -lh "$OUT"
