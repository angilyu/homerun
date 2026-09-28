#!/usr/bin/env bash
# Inside-out code signing for Homerun.app (design §11, §16.1 item 6).
#
#   scripts/macos/sign.sh path/to/Homerun.app
#
# Env:
#   IDENTITY        "-" (ad-hoc, default) | "Developer ID Application: … (TEAMID)" | SHA-1 hash
#   SPIKE_KEYCHAIN  optional keychain file holding IDENTITY; added to the user search list
#                   only for the duration of this script, then the original list is restored
#   THIRD_PARTY     resign (default, F4 option B) | keep (F4 option A: leave the vendor's
#                   Developer ID signature on claude/node/uv untouched) | hybrid (recommended:
#                   keep Anthropic's signature on claude, re-sign node and uv with ours)
#   TEAM_ID + PROVISIONING_PROFILE
#                   (Developer ID only) add keychain-access-groups "<TEAM_ID>.dev.homerun.shared"
#                   to homerund — see docs/spike-results.md item 7 for why this also needs
#                   homerund wrapped in its own nested bundle before it can work.
#
# Order: nested code first (Resources Mach-Os, then Contents/MacOS helpers), the bundle last.
# Never uses --deep for signing (Apple: --deep is for verification only).
set -euo pipefail
APP="${1:?usage: sign.sh path/to/Homerun.app}"
HERE="$(cd "$(dirname "$0")" && pwd)"
ENT="$HERE/entitlements"
IDENTITY="${IDENTITY:--}"
THIRD_PARTY="${THIRD_PARTY:-resign}"
MACOS="$APP/Contents/MacOS"

if [[ "$IDENTITY" == Developer\ ID* ]]; then TS=(--timestamp); else TS=(--timestamp=none); fi

restore_kc=""
if [[ -n "${SPIKE_KEYCHAIN:-}" ]]; then
  orig=$(security list-keychains -d user | xargs)
  restore_kc="$orig"
  # shellcheck disable=SC2086
  security list-keychains -d user -s $orig "$SPIKE_KEYCHAIN"
  [[ -f "$(dirname "$SPIKE_KEYCHAIN")/keychain-password" ]] &&
    security unlock-keychain -p "$(cat "$(dirname "$SPIKE_KEYCHAIN")/keychain-password")" "$SPIKE_KEYCHAIN"
fi
cleanup() { [[ -n "$restore_kc" ]] && security list-keychains -d user -s $restore_kc; true; }
trap cleanup EXIT

sign() { # path identifier entitlements
  codesign --force --sign "$IDENTITY" --options runtime "${TS[@]}" \
    --identifier "$2" --entitlements "$3" "$1"
}

# 1. Any Mach-O shipped as a resource (npm has none today; future native modules would).
while IFS= read -r -d '' f; do
  if file -b "$f" | grep -q "Mach-O"; then
    sign "$f" "dev.homerun.res.$(basename "$f")" "$ENT/uv.plist"
  fi
done < <(find "$APP/Contents/Resources" -type f -print0)

# 2. Third-party helpers (F4).
for h in claude node uv; do
  [[ -f "$MACOS/$h" ]] || continue
  if [[ "$THIRD_PARTY" == keep || ( "$THIRD_PARTY" == hybrid && "$h" == claude ) ]]; then
    info="$(codesign -dvvv "$MACOS/$h" 2>&1 || true)"
    echo "keep vendor signature: $h ($(grep -m1 '^Authority=' <<<"$info" || echo unsigned))"
    if [[ "$h" == claude ]]; then # must still be Anthropic's hardened, untouched signature
      codesign --verify --strict -R '=anchor apple generic and certificate leaf[subject.OU] = "Q6L2SF6YDW"' "$MACOS/$h"
      grep -q 'flags=0x10000(runtime)' <<<"$info" || { echo "claude is not hardened" >&2; exit 1; }
    fi
  else
    sign "$MACOS/$h" "dev.homerun.helper.$h" "$ENT/$h.plist"
  fi
done

# 3. Our runtime.
HOMERUND_ENT="$ENT/homerund.plist"
if [[ -n "${TEAM_ID:-}" ]]; then
  HOMERUND_ENT="$(mktemp -t homerund-ent).plist"
  cp "$ENT/homerund.plist" "$HOMERUND_ENT"
  /usr/libexec/PlistBuddy -c "Add :keychain-access-groups array" \
    -c "Add :keychain-access-groups:0 string $TEAM_ID.dev.homerun.shared" \
    -c "Add :com.apple.application-identifier string $TEAM_ID.dev.homerun.app" \
    -c "Add :com.apple.developer.team-identifier string $TEAM_ID" "$HOMERUND_ENT"
  [[ -n "${PROVISIONING_PROFILE:-}" ]] && cp "$PROVISIONING_PROFILE" "$APP/Contents/embedded.provisionprofile"
fi
sign "$MACOS/homerund" "dev.homerun.homerund" "$HOMERUND_ENT"

# 4. The bundle (signs the shell's main executable and seals Resources). No exceptions on the shell.
codesign --force --sign "$IDENTITY" --options runtime "${TS[@]}" --entitlements "$ENT/shell.plist" "$APP"

codesign --verify --deep --strict --verbose=2 "$APP"
echo "signed $APP (identity=$IDENTITY third_party=$THIRD_PARTY)"
