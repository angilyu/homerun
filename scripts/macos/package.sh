#!/usr/bin/env bash
# Build → sign → (notarize) → DMG for one version.
#
#   VERSION=0.0.2 scripts/macos/package.sh
#
# Env: VERSION (default 0.0.1), IDENTITY / SPIKE_KEYCHAIN / THIRD_PARTY (see sign.sh),
#      NOTARY_PROFILE (optional; runs notarize.sh — needs the user's Apple account),
#      OUT (output dir, default dist/macos/$VERSION; e.g. dist/macos/devid-$VERSION),
#      NO_DMG=1 (skip the DMG).
#   Updater (§11), all optional:
#      UPDATER_KEY      minisign secret key, outside the repo. Its public half ($UPDATER_KEY.pub,
#                       or UPDATER_PUBKEY) is compiled in, and updater-artifacts.sh writes the
#                       signed payload and latest.json. Without it the build carries the
#                       placeholder key and never updates itself (fail closed).
#      UPDATE_URL       where the payload will be served (default: the GitHub release v$VERSION)
#      UPDATER_ENDPOINT a localhost http latest.json instead of GitHub's. Makes an update-test
#                       build, which honours the HOMERUN_TEST_* switches; never ship one.
#      RUNTIME_CHANNEL=development  a dev-channel homerund (update-test builds only), so the mock
#                       API can stand in for the model.
# Output: $OUT/{Homerun.app,Homerun.dmg[,Homerun.app.tar.gz,Homerun.app.tar.gz.sig,latest.json]}
#
# Tauri's bundler cannot give each helper its own entitlements, so it builds an
# unsigned .app and sign.sh does the inside-out signing afterwards. The updater payload is made
# from the signed (and notarized) app, not by the bundler.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
VERSION="${VERSION:-0.0.1}"
OUT="${OUT:-$ROOT/dist/macos/$VERSION}"
TAURI=(pnpm --dir "$ROOT/apps/desktop" exec tauri)
BUN="$ROOT/node_modules/.bin/bun"

PUBKEY=""
if [[ -n "${UPDATER_KEY:-}" ]]; then
  PUBKEY="$(cat "${UPDATER_PUBKEY:-$UPDATER_KEY.pub}")"
fi
case "${UPDATER_ENDPOINT:-}" in
  "" | http://127.0.0.1:*) ;;
  *) echo "UPDATER_ENDPOINT is for local update tests (http://127.0.0.1:PORT/…)" >&2; exit 1 ;;
esac
if [[ "${RUNTIME_CHANNEL:-release}" == development ]]; then
  [[ -n "${UPDATER_ENDPOINT:-}" ]] || { echo "RUNTIME_CHANNEL=development is for update-test builds (set UPDATER_ENDPOINT)" >&2; exit 1; }
  ( cd "$ROOT/apps/desktop" && "$BUN" scripts/stage-sidecars.ts >/dev/null )
else
  HOMERUND_VERSION="$VERSION" "$ROOT/scripts/macos/fetch-toolchain.sh" >/dev/null
fi

CONFIG="$(VERSION="$VERSION" PUBKEY="$PUBKEY" ENDPOINT="${UPDATER_ENDPOINT:-}" "$BUN" -e '
const e = process.env;
const updater = {};
if (e.PUBKEY) updater.pubkey = e.PUBKEY;
if (e.ENDPOINT) Object.assign(updater, { endpoints: [e.ENDPOINT], dangerousInsecureTransportProtocol: true });
console.log(JSON.stringify({ version: e.VERSION, ...(Object.keys(updater).length ? { plugins: { updater } } : {}) }));
')"
"${TAURI[@]}" build --bundles app --no-sign --config "$CONFIG" >/dev/null

rm -rf "$OUT" && mkdir -p "$OUT"
ditto "$ROOT/apps/desktop/src-tauri/target/release/bundle/macos/Homerun.app" "$OUT/Homerun.app"
"$ROOT/scripts/macos/sign.sh" "$OUT/Homerun.app"

if [[ -n "${NOTARY_PROFILE:-}" ]]; then "$ROOT/scripts/macos/notarize.sh" "$OUT/Homerun.app"; fi

if [[ -n "${UPDATER_KEY:-}" ]]; then
  "$ROOT/scripts/macos/updater-artifacts.sh" "$OUT/Homerun.app" "$VERSION" \
    "${UPDATE_URL:-https://github.com/angilyu/homerun/releases/download/v$VERSION/Homerun.app.tar.gz}" >/dev/null
fi

if [[ "${NO_DMG:-0}" == 1 ]]; then ls -la "$OUT"; exit 0; fi
# DMG (what users download).
STAGE="$(mktemp -d)"; ditto "$OUT/Homerun.app" "$STAGE/Homerun.app"; ln -s /Applications "$STAGE/Applications"
hdiutil create -quiet -volname "Homerun" -srcfolder "$STAGE" -ov -format UDZO "$OUT/Homerun.dmg"
rm -rf "$STAGE"
if [[ "${IDENTITY:--}" == Developer\ ID* ]]; then
  codesign --force --sign "$IDENTITY" --timestamp "$OUT/Homerun.dmg"
  [[ -n "${NOTARY_PROFILE:-}" ]] && { xcrun notarytool submit "$OUT/Homerun.dmg" --keychain-profile "$NOTARY_PROFILE" --wait; xcrun stapler staple "$OUT/Homerun.dmg"; }
fi
ls -la "$OUT"
