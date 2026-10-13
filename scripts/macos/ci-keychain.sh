#!/usr/bin/env bash
# A throwaway, unlocked keychain holding the Developer ID identity for a CI release (design §11).
#
#   scripts/macos/ci-keychain.sh setup     prints the "Developer ID Application: … (TEAM)" identity
#   scripts/macos/ci-keychain.sh cleanup   deletes the keychain and restores the search list
#
# Env (setup): APPLE_CERTIFICATE_P12_BASE64, APPLE_CERTIFICATE_PASSWORD. Both: KEYCHAIN (default
# $RUNNER_TEMP/homerun-signing.keychain-db). The keychain's own password is random, masked in the
# log, and never stored. It stays in the user search list for the rest of the job, because
# package.sh signs the app and then the DMG; run cleanup in an always() step.
set -euo pipefail
set +x
KC="${KEYCHAIN:-${RUNNER_TEMP:?set KEYCHAIN or RUNNER_TEMP}/homerun-signing.keychain-db}"
LIST="$KC.search-list"

case "${1:-}" in
  setup)
    : "${APPLE_CERTIFICATE_P12_BASE64:?}" "${APPLE_CERTIFICATE_PASSWORD:?}"
    pass="$(openssl rand -hex 24)"
    [[ -n "${GITHUB_ACTIONS:-}" ]] && echo "::add-mask::$pass"
    security create-keychain -p "$pass" "$KC"
    security set-keychain-settings -lut 21600 "$KC" # no auto-lock during the build (6 h)
    security unlock-keychain -p "$pass" "$KC"
    work="$(mktemp -d)"; chmod 700 "$work"
    (umask 077 && printf '%s' "$APPLE_CERTIFICATE_P12_BASE64" | base64 --decode > "$work/cert.p12")
    # -T: codesign and security may use the key without a prompt; the partition list below is
    # what actually lets codesign use it unattended on current macOS.
    security import "$work/cert.p12" -k "$KC" -f pkcs12 -P "$APPLE_CERTIFICATE_PASSWORD" \
      -T /usr/bin/codesign -T /usr/bin/security >/dev/null
    rm -rf "$work"
    # The intermediate, in case the export didn't include it (public; trust still ends at Apple's
    # root in the System keychain).
    if curl -fsSL -o "$KC.ca.cer" https://www.apple.com/certificateauthority/DeveloperIDG2CA.cer; then
      security import "$KC.ca.cer" -k "$KC" >/dev/null 2>&1 || true
    fi
    rm -f "$KC.ca.cer"
    security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "$pass" "$KC" >/dev/null
    unset pass
    security list-keychains -d user | xargs > "$LIST"
    # shellcheck disable=SC2046
    security list-keychains -d user -s "$KC" $(cat "$LIST")
    ids="$(security find-identity -v -p codesigning "$KC" | sed -n 's/^ *[0-9]*) [0-9A-F]* "\(Developer ID Application: .*\)"$/\1/p')"
    [[ "$(grep -c . <<<"$ids")" == 1 ]] \
      || { echo "expected one Developer ID Application identity in the .p12, found: ${ids:-none}" >&2; exit 1; }
    echo "$ids"
    ;;
  cleanup)
    if [[ -f "$LIST" ]]; then
      # shellcheck disable=SC2046
      security list-keychains -d user -s $(cat "$LIST") || true
      rm -f "$LIST"
    fi
    [[ -e "$KC" ]] && security delete-keychain "$KC" || true
    ;;
  *) echo "usage: ci-keychain.sh setup|cleanup" >&2; exit 2 ;;
esac
