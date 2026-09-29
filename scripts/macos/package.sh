#!/usr/bin/env bash
# Build → sign → (notarize) → DMG for one version.
#
#   VERSION=0.0.2 scripts/macos/package.sh
#
# Env: VERSION (default 0.0.1), IDENTITY / SPIKE_KEYCHAIN / THIRD_PARTY (see sign.sh),
#      NOTARY_PROFILE (optional; runs notarize.sh — needs the user's Apple account),
#      OUT (output dir, default dist/macos/$VERSION; e.g. dist/macos/devid-$VERSION).
# Output: $OUT/{Homerun.app,Homerun.dmg}
#
# Tauri's bundler cannot give each helper its own entitlements, so it builds an
# unsigned .app and sign.sh does the inside-out signing afterwards. The signed updater and its
# payload return with milestone 8 (§16); the spike version is in docs/spike-results.md entry 8.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
VERSION="${VERSION:-0.0.1}"
OUT="${OUT:-$ROOT/dist/macos/$VERSION}"
TAURI=(pnpm --dir "$ROOT/apps/desktop" exec tauri)

HOMERUND_VERSION="$VERSION" "$ROOT/scripts/macos/fetch-toolchain.sh" >/dev/null

"${TAURI[@]}" build --bundles app --no-sign --config "{\"version\":\"$VERSION\"}" >/dev/null

rm -rf "$OUT" && mkdir -p "$OUT"
ditto "$ROOT/apps/desktop/src-tauri/target/release/bundle/macos/Homerun.app" "$OUT/Homerun.app"
"$ROOT/scripts/macos/sign.sh" "$OUT/Homerun.app"

if [[ -n "${NOTARY_PROFILE:-}" ]]; then "$ROOT/scripts/macos/notarize.sh" "$OUT/Homerun.app"; fi

# DMG (what users download).
STAGE="$(mktemp -d)"; ditto "$OUT/Homerun.app" "$STAGE/Homerun.app"; ln -s /Applications "$STAGE/Applications"
hdiutil create -quiet -volname "Homerun" -srcfolder "$STAGE" -ov -format UDZO "$OUT/Homerun.dmg"
rm -rf "$STAGE"
if [[ "${IDENTITY:--}" == Developer\ ID* ]]; then
  codesign --force --sign "$IDENTITY" --timestamp "$OUT/Homerun.dmg"
  [[ -n "${NOTARY_PROFILE:-}" ]] && { xcrun notarytool submit "$OUT/Homerun.dmg" --keychain-profile "$NOTARY_PROFILE" --wait; xcrun stapler staple "$OUT/Homerun.dmg"; }
fi
ls -la "$OUT"
