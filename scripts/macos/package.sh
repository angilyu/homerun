#!/usr/bin/env bash
# Build → sign → (notarize) → DMG + updater artifact for one version.
#
#   VERSION=0.0.2 scripts/macos/package.sh
#
# Env: VERSION (default 0.0.1), IDENTITY / SPIKE_KEYCHAIN / THIRD_PARTY (see sign.sh),
#      NOTARY_PROFILE (optional; runs notarize.sh — needs the user's Apple account),
#      UPDATER_ENDPOINT (default http://127.0.0.1:8799/latest.json, the local spike server).
# Output: dist/macos/$VERSION/{Homerun.app,Homerun.dmg,Homerun.app.tar.gz,Homerun.app.tar.gz.sig}
#
# Tauri's bundler cannot give each helper its own entitlements, so it builds an
# unsigned .app and sign.sh does the inside-out signing afterwards.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
VERSION="${VERSION:-0.0.1}"
OUT="$ROOT/dist/macos/$VERSION"
KEYDIR="$ROOT/.spike/updater"
KEY="$KEYDIR/homerun-updater.key"
ENDPOINT="${UPDATER_ENDPOINT:-http://127.0.0.1:8799/latest.json}"
TAURI=(pnpm --dir "$ROOT/apps/desktop" exec tauri)

mkdir -p "$KEYDIR" && chmod 700 "$KEYDIR"
# Updater signing key (minisign). Never committed: .spike/ is gitignored.
[[ -f "$KEY" ]] || "${TAURI[@]}" signer generate --ci -p "" -w "$KEY" >/dev/null
PUBKEY="$(cat "$KEY.pub")"

HOMERUND_VERSION="$VERSION" "$ROOT/scripts/macos/fetch-toolchain.sh" >/dev/null

CONFIG=$(printf '{"version":"%s","plugins":{"updater":{"pubkey":"%s","endpoints":["%s"]}}}' "$VERSION" "$PUBKEY" "$ENDPOINT")
"${TAURI[@]}" build --bundles app --config "$CONFIG" >/dev/null

rm -rf "$OUT" && mkdir -p "$OUT"
ditto "$ROOT/apps/desktop/src-tauri/target/release/bundle/macos/Homerun.app" "$OUT/Homerun.app"
"$ROOT/scripts/macos/sign.sh" "$OUT/Homerun.app"

if [[ -n "${NOTARY_PROFILE:-}" ]]; then "$ROOT/scripts/macos/notarize.sh" "$OUT/Homerun.app"; fi

# DMG (what users download) and the updater payload (what the app downloads).
STAGE="$(mktemp -d)"; ditto "$OUT/Homerun.app" "$STAGE/Homerun.app"; ln -s /Applications "$STAGE/Applications"
hdiutil create -quiet -volname "Homerun" -srcfolder "$STAGE" -ov -format UDZO "$OUT/Homerun.dmg"
rm -rf "$STAGE"
if [[ "${IDENTITY:--}" == Developer\ ID* ]]; then
  codesign --force --sign "$IDENTITY" --timestamp "$OUT/Homerun.dmg"
  [[ -n "${NOTARY_PROFILE:-}" ]] && { xcrun notarytool submit "$OUT/Homerun.dmg" --keychain-profile "$NOTARY_PROFILE" --wait; xcrun stapler staple "$OUT/Homerun.dmg"; }
fi
COPYFILE_DISABLE=1 tar -czf "$OUT/Homerun.app.tar.gz" -C "$OUT" Homerun.app
"${TAURI[@]}" signer sign -f "$KEY" -p "" "$OUT/Homerun.app.tar.gz" >/dev/null
ls -la "$OUT"
