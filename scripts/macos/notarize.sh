#!/usr/bin/env bash
# Notarize + staple (design §11). REQUIRES the user's Apple Developer account.
#   One-time: xcrun notarytool store-credentials homerun-notary \
#               --apple-id you@example.com --team-id TEAMID --password <app-specific-password>
#   Then:     NOTARY_PROFILE=homerun-notary scripts/macos/notarize.sh path/to/Homerun.app [path/to/Homerun.dmg]
set -euo pipefail
APP="${1:?usage: notarize.sh Homerun.app [Homerun.dmg]}"
DMG="${2:-}"
PROFILE="${NOTARY_PROFILE:?set NOTARY_PROFILE (xcrun notarytool store-credentials)}"
# Capture first: with pipefail, `grep -q` exiting early SIGPIPEs codesign and fails the check.
sig="$(codesign -dvv "$APP" 2>&1)"
grep -q '^Authority=Developer ID Application' <<<"$sig" \
  || { echo "refusing: $APP is not Developer ID signed (run sign.sh with IDENTITY=…)" >&2; exit 1; }
ZIP="$(mktemp -d)/Homerun.zip"
ditto -c -k --keepParent "$APP" "$ZIP"
# notarytool may exit non-zero on "Invalid"; keep going so the log is still fetched.
out="$(xcrun notarytool submit "$ZIP" --keychain-profile "$PROFILE" --wait --output-format json)" || true
echo "$out"
id="$(echo "$out" | plutil -extract id raw - 2>/dev/null || true)"
status="$(echo "$out" | plutil -extract status raw - 2>/dev/null || true)"
[[ -n "$id" ]] && xcrun notarytool log "$id" --keychain-profile "$PROFILE" > "$(dirname "$APP")/notary-log.json" || true
[[ "$status" == "Accepted" ]] || { echo "notarization: $status (see notary-log.json)" >&2; exit 1; }
xcrun stapler staple "$APP"
if [[ -n "$DMG" ]]; then
  xcrun notarytool submit "$DMG" --keychain-profile "$PROFILE" --wait
  xcrun stapler staple "$DMG"
fi
spctl --assess --type execute -vvv "$APP"
