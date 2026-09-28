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
#                   (Developer ID only) embed the profile and give the shell (the bundle's main
#                   executable) keychain-access-groups "<TEAM_ID>.com.angilyu.homerun.shared".
#                   The shell owns all keychain access (design §11); homerund gets none.
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
    sign "$f" "com.angilyu.homerun.res.$(basename "$f")" "$ENT/uv.plist"
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
    sign "$MACOS/$h" "com.angilyu.homerun.helper.$h" "$ENT/$h.plist"
  fi
done

# 3. Our runtime. Plain entitlements: the runtime never calls Security.framework (design §11, entry 15).
sign "$MACOS/homerund" "com.angilyu.homerun.homerund" "$ENT/homerund.plist"

# 4. The bundle (signs the shell's main executable and seals Resources). No exceptions on the shell.
# With TEAM_ID + PROVISIONING_PROFILE the shell gets the data-protection keychain group. These are
# restricted entitlements: without a matching embedded profile AMFI kills the app at launch.
SHELL_ENT="$ENT/shell.plist"
if [[ -n "${TEAM_ID:-}" ]]; then
  [[ -f "${PROVISIONING_PROFILE:-}" ]] || { echo "TEAM_ID needs PROVISIONING_PROFILE (a Developer ID profile)" >&2; exit 1; }
  PROF="$(mktemp -t hr-profile).plist"; security cms -D -i "$PROVISIONING_PROFILE" > "$PROF"
  [[ "$(/usr/libexec/PlistBuddy -c 'Print :Entitlements:com.apple.application-identifier' "$PROF")" == "$TEAM_ID.com.angilyu.homerun" ]] \
    || { echo "profile is not for $TEAM_ID.com.angilyu.homerun" >&2; exit 1; }
  SHELL_ENT="$(mktemp -t shell-ent).plist"
  cp "$ENT/shell.plist" "$SHELL_ENT"
  /usr/libexec/PlistBuddy -c "Add :keychain-access-groups array" \
    -c "Add :keychain-access-groups:0 string $TEAM_ID.com.angilyu.homerun.shared" \
    -c "Add :com.apple.application-identifier string $TEAM_ID.com.angilyu.homerun" \
    -c "Add :com.apple.developer.team-identifier string $TEAM_ID" "$SHELL_ENT"
  cp "$PROVISIONING_PROFILE" "$APP/Contents/embedded.provisionprofile"
fi
codesign --force --sign "$IDENTITY" --options runtime "${TS[@]}" --entitlements "$SHELL_ENT" "$APP"

codesign --verify --deep --strict --verbose=2 "$APP"
echo "signed $APP (identity=$IDENTITY third_party=$THIRD_PARTY)"
