#!/usr/bin/env bash
# The release CLI as it ships (design §5.2), nightly in desktop-macos:
#   - packages an ad-hoc Homerun.app (release channel, no DMG) unless one is given;
#   - apps/cli's macOS tests: the keychain FFI against a throwaway keychain and the peer check
#     (test/macos/ffi.test.ts), then the bundled CLI against the bundled homerund
#     (test/macos/bundled.test.ts): its signature and entitlements, the development switches
#     refused, approvals refused, the peer check passing for the real homerund and failing,
#     before any byte is sent, for anything else.
# No API key, no network, nothing approved (so nothing is written to the login keychain).
#
#   scripts/macos/cli-test.sh [path/to/Homerun.app]
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
APP="${1:-}"
if [[ -z "$APP" ]]; then
  OUT="$ROOT/dist/cli-test"
  VERSION=0.0.1 OUT="$OUT" NO_DMG=1 "$ROOT/scripts/macos/package.sh" >/dev/null
  APP="$OUT/Homerun.app"
fi
APP="$(cd "$APP" && pwd)"
[[ -x "$APP/Contents/MacOS/homerun-cli" ]] || { echo "no homerun-cli in $APP" >&2; exit 1; }
cd "$ROOT/apps/cli"
HOMERUN_TEST_APP="$APP" "$ROOT/node_modules/.bin/bun" test test/macos
