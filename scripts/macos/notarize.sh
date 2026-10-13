#!/usr/bin/env bash
# Notarize + staple (design §11). REQUIRES the user's Apple Developer account.
#
#   scripts/macos/notarize.sh path/to/Homerun.app [path/to/Homerun.dmg]
#   scripts/macos/notarize.sh path/to/Homerun.dmg          (a DMG alone, e.g. from package.sh)
#
# Credentials, one of:
#   NOTARY_PROFILE  a notarytool keychain profile (local use). One-time:
#                     xcrun notarytool store-credentials homerun-notary \
#                       --apple-id you@example.com --team-id TEAMID --password <app-specific-password>
#   NOTARY_KEY + NOTARY_KEY_ID + NOTARY_ISSUER
#                   an App Store Connect API key (CI: the .p8 file, its key ID and the issuer ID)
# The submission's log is written next to the item as notary-log.json (or notary-log-dmg.json).
set -euo pipefail
set +x
ITEM="${1:?usage: notarize.sh Homerun.app [Homerun.dmg] | notarize.sh Homerun.dmg}"
DMG="${2:-}"
if [[ -n "${NOTARY_KEY:-}" ]]; then
  [[ -f "$NOTARY_KEY" ]] || { echo "no API key at NOTARY_KEY" >&2; exit 1; }
  AUTH=(--key "$NOTARY_KEY" --key-id "${NOTARY_KEY_ID:?set NOTARY_KEY_ID}" --issuer "${NOTARY_ISSUER:?set NOTARY_ISSUER}")
elif [[ -n "${NOTARY_PROFILE:-}" ]]; then
  AUTH=(--keychain-profile "$NOTARY_PROFILE")
else
  echo "set NOTARY_PROFILE, or NOTARY_KEY + NOTARY_KEY_ID + NOTARY_ISSUER" >&2; exit 1
fi

developer_id() { # Capture first: with pipefail, `grep -q` exiting early SIGPIPEs codesign.
  local sig; sig="$(codesign -dvv "$1" 2>&1)"
  grep -q '^Authority=Developer ID Application' <<<"$sig" \
    || { echo "refusing: $1 is not Developer ID signed (run sign.sh with IDENTITY=…)" >&2; exit 1; }
}

submit() { # file-to-upload log-path
  local out id status
  # notarytool may exit non-zero on "Invalid"; keep going so the log is still fetched.
  out="$(xcrun notarytool submit "$1" "${AUTH[@]}" --wait --output-format json)" || true
  echo "$out"
  id="$(echo "$out" | plutil -extract id raw - 2>/dev/null || true)"
  status="$(echo "$out" | plutil -extract status raw - 2>/dev/null || true)"
  [[ -n "$id" ]] && xcrun notarytool log "$id" "${AUTH[@]}" > "$2" || true
  [[ "$status" == "Accepted" ]] || { echo "notarization: ${status:-no response} (see $(basename "$2"))" >&2; exit 1; }
}

notarize_dmg() {
  developer_id "$1"
  submit "$1" "$(dirname "$1")/notary-log-dmg.json"
  xcrun stapler staple "$1"
}

if [[ "$ITEM" == *.dmg ]]; then notarize_dmg "$ITEM"; exit 0; fi

APP="$ITEM"
developer_id "$APP"
ZIP="$(mktemp -d)/Homerun.zip"
ditto -c -k --keepParent "$APP" "$ZIP"
submit "$ZIP" "$(dirname "$APP")/notary-log.json"
rm -rf "$(dirname "$ZIP")"
xcrun stapler staple "$APP"
if [[ -n "$DMG" ]]; then notarize_dmg "$DMG"; fi
spctl --assess --type execute -vvv "$APP"
