#!/usr/bin/env bash
# What a release build may do with the secrets it has (design §11, §18 row 134). Prints no values.
#
#   scripts/release/signing-status.sh macos|windows
#
# Writes two outputs, to $GITHUB_OUTPUT when it is set and to stdout otherwise:
#   signed=true|false   every code-signing secret for the platform is set. If none are set, the
#                       build is unsigned (ad hoc on macOS). Some but not all is an error, so a
#                       half-configured release fails instead of quietly shipping unsigned.
#   updates=true|false  signed, TAURI_SIGNING_PRIVATE_KEY set, and tauri.conf.json's updater
#                       pubkey no longer the placeholder. Only then does the platform get a
#                       latest.json entry, so the updater never offers an unsigned build.
# Secrets come from the environment. TAURI_SIGNING_PRIVATE_KEY_PASSWORD may be empty (a key without
# a passphrase); it isn't checked here.
set -euo pipefail
set +x
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PLATFORM="${1:?usage: signing-status.sh macos|windows}"
case "$PLATFORM" in
  macos)
    what="Developer ID signing and notarization"
    names=(APPLE_CERTIFICATE_P12_BASE64 APPLE_CERTIFICATE_PASSWORD APPLE_TEAM_ID APPLE_PROVISIONING_PROFILE_BASE64
      APP_STORE_CONNECT_API_KEY_P8_BASE64 APP_STORE_CONNECT_KEY_ID APP_STORE_CONNECT_ISSUER_ID) ;;
  windows)
    what="Authenticode signing (Azure Artifact Signing)"
    names=(AZURE_TENANT_ID AZURE_CLIENT_ID AZURE_CLIENT_SECRET
      AZURE_TRUSTED_SIGNING_ENDPOINT AZURE_TRUSTED_SIGNING_ACCOUNT AZURE_TRUSTED_SIGNING_PROFILE) ;;
  *) echo "usage: signing-status.sh macos|windows" >&2; exit 2 ;;
esac

set_names=(); missing=()
for n in "${names[@]}"; do
  if [[ -n "${!n:-}" ]]; then set_names+=("$n"); else missing+=("$n"); fi
done
if (( ${#set_names[@]} == ${#names[@]} )); then
  signed=true
elif (( ${#set_names[@]} == 0 )); then
  signed=false
  echo "::warning::$PLATFORM: no secrets for $what; building an unsigned preview"
else
  echo "::error::$PLATFORM: $what is half configured. Set: ${set_names[*]}. Missing: ${missing[*]}."
  exit 1
fi

# Relative to ROOT: on Windows, node can't read Git Bash's /d/a/… paths.
pubkey="$(cd "$ROOT" && node -e '
const c = JSON.parse(require("fs").readFileSync("apps/desktop/src-tauri/tauri.conf.json", "utf8"));
process.stdout.write(String(c.plugins?.updater?.pubkey ?? ""));')"
updates=false
if [[ "$signed" != true ]]; then
  :
elif [[ -z "${TAURI_SIGNING_PRIVATE_KEY:-}" ]]; then
  echo "::warning::$PLATFORM: no TAURI_SIGNING_PRIVATE_KEY; this build won't be offered as an update"
elif [[ -z "$pubkey" || "$pubkey" == HOMERUN_UPDATER_PUBKEY_NOT_SET ]]; then
  echo "::warning::$PLATFORM: tauri.conf.json still has the placeholder updater pubkey; this build won't be offered as an update (apps/desktop/README.md, Releasing)"
else
  updates=true
fi

out="${GITHUB_OUTPUT:-/dev/stdout}"
printf 'signed=%s\nupdates=%s\n' "$signed" "$updates" >> "$out"
echo "$PLATFORM: signed=$signed updates=$updates" >&2
