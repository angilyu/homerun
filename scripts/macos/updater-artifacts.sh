#!/usr/bin/env bash
# The signed updater payload for a signed (and, for a release, notarized) Homerun.app (§11).
#
#   UPDATER_KEY=~/.homerun-release/updater.key \
#     scripts/macos/updater-artifacts.sh path/to/Homerun.app VERSION PAYLOAD_URL
#
# Writes next to the app: Homerun.app.tar.gz, Homerun.app.tar.gz.sig and latest.json. Upload all
# three to the GitHub release v$VERSION; the app reads
# https://github.com/angilyu/homerun/releases/latest/download/latest.json.
#
# Env:
#   UPDATER_KEY                    the minisign secret key from `tauri signer generate`. It must live
#                                  outside the repository; this script refuses a path inside it.
#   UPDATER_KEY_PASSWORD_SERVICE   login-keychain item holding its passphrase (default
#                                  homerun-updater-key, account "passphrase"). Read into the signer's
#                                  environment only, never printed.
#   UPDATER_KEY_NO_PASSWORD=1      an ephemeral test key without a passphrase (update-test.sh)
#   MIN_UPDATE_FROM, PROTOCOL_MIN  optional "homerun" extension of latest.json (§11 version gate)
#   NOTES                          optional release notes
#
# The payload is made here, from the signed app, not by Tauri's createUpdaterArtifacts: the
# bundler would archive the app before sign.sh and notarization.
set -euo pipefail
set +x
APP="${1:?usage: updater-artifacts.sh Homerun.app VERSION PAYLOAD_URL}"
VERSION="${2:?version}"
URL="${3:?payload url}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
BUN="$ROOT/node_modules/.bin/bun"
KEY="${UPDATER_KEY:?set UPDATER_KEY to the minisign secret key (outside the repo)}"
[[ -f "$KEY" ]] || { echo "no key at $KEY" >&2; exit 1; }
case "$(cd "$(dirname "$KEY")" && pwd -P)/" in
  "$(cd "$ROOT" && pwd -P)"/*) echo "refusing: the updater key must not live inside the repository" >&2; exit 1 ;;
esac

DIR="$(cd "$(dirname "$APP")" && pwd)"
TAR="$DIR/Homerun.app.tar.gz"
rm -f "$TAR" "$TAR.sig" "$DIR/latest.json"
# The plugin drops the first path component when it unpacks, so the archive holds Homerun.app/….
COPYFILE_DISABLE=1 tar --no-mac-metadata -czf "$TAR" -C "$DIR" "$(basename "$APP")"

if [[ "${UPDATER_KEY_NO_PASSWORD:-0}" == 1 ]]; then
  pass=""
else
  pass="$(security find-generic-password -s "${UPDATER_KEY_PASSWORD_SERVICE:-homerun-updater-key}" -a passphrase -w)" \
    || { echo "no passphrase in the login keychain (see apps/desktop/README.md, Releases)" >&2; exit 1; }
fi
# --app-version binds the version into the signature's trusted comment (requireSignedVersion).
TAURI_SIGNING_PRIVATE_KEY_PASSWORD="$pass" pnpm --dir "$ROOT/apps/desktop" exec tauri signer sign \
  -f "$KEY" --app-version "$VERSION" "$TAR" >/dev/null
unset pass
[[ -s "$TAR.sig" ]] || { echo "signing failed" >&2; exit 1; }

VERSION="$VERSION" URL="$URL" SIG="$(cat "$TAR.sig")" OUT="$DIR/latest.json" "$BUN" -e '
const e = process.env;
const ext = {};
if (e.MIN_UPDATE_FROM) ext.min_update_from = e.MIN_UPDATE_FROM;
if (e.PROTOCOL_MIN) ext.protocol = { min: Number(e.PROTOCOL_MIN) };
const m = {
  version: e.VERSION,
  notes: e.NOTES ?? "",
  pub_date: new Date().toISOString().replace(/\.\d+Z$/, "Z"),
  platforms: { "darwin-aarch64": { signature: e.SIG, url: e.URL } },
  ...(Object.keys(ext).length ? { homerun: ext } : {}),
};
await Bun.write(e.OUT, JSON.stringify(m, null, 2) + "\n");
'
ls -la "$TAR" "$TAR.sig" "$DIR/latest.json"
