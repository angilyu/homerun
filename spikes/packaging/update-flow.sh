#!/usr/bin/env bash
# §16.1 item 8: full auto-update cycle to a newly signed build while a run is in progress.
#
#   spikes/packaging/update-flow.sh <label> [from-dir] [to-dir]
#
#   from-dir/to-dir default to dist/macos/0.0.1 and dist/macos/0.0.2 (built by package.sh).
#   1. installs from-dir's Homerun.app into /tmp/hr8-<label>/inst
#   2. serves to-dir's updater payload + latest.json on 127.0.0.1:8799 (the built-in endpoint)
#   3. launches the app with `--autotest update-flow`: v_from stores the API key in the
#      keychain, starts a long Bash run, then updates mid-tool-call; the shell checkpoints
#      homerund, installs, restarts; v_to's homerund reads the keychain and resumes the run
#   4. waits for the run to complete and writes evidence to .spike/results/item8-<label>/
#
# Model: the scripted mock API (spikes/sdk/src/mock-api.ts) unless REAL_API=1 and
# ANTHROPIC_API_KEY is set. The key is never written to disk by this script.
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
LABEL="${1:?label}"
FROM="${2:-$ROOT/dist/macos/0.0.1}"
TO="${3:-$ROOT/dist/macos/0.0.2}"
# Not /tmp: Tauri refuses to start when current_exe() contains a symlink (/tmp → /private/tmp).
W="/private/tmp/hr8-$LABEL"
D="$W/d"
OUT="$ROOT/.spike/results/item8-$LABEL"
BUN="$ROOT/node_modules/.bin/bun"
rm -rf "$W" "$OUT" && mkdir -p "$W/inst" "$W/serve" "$W/cwd" "$D" "$OUT"

ditto "$FROM/Homerun.app" "$W/inst/Homerun.app"
cp "$TO/Homerun.app.tar.gz" "$W/serve/"
TOV="$(/usr/libexec/PlistBuddy -c 'Print CFBundleShortVersionString' "$TO/Homerun.app/Contents/Info.plist")"
FROMV="$(/usr/libexec/PlistBuddy -c 'Print CFBundleShortVersionString' "$FROM/Homerun.app/Contents/Info.plist")"
python3 - "$W/serve/latest.json" "$TOV" "$(cat "$TO/Homerun.app.tar.gz.sig")" <<'EOF'
import json, sys, datetime
path, version, sig = sys.argv[1:]
json.dump({"version": version, "notes": "spike", "pub_date": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
           "platforms": {"darwin-aarch64": {"signature": sig, "url": "http://127.0.0.1:8799/Homerun.app.tar.gz"}}}, open(path, "w"))
EOF
python3 -m http.server 8799 --bind 127.0.0.1 --directory "$W/serve" > "$W/http.log" 2>&1 &
HTTP=$!
MOCK=""
if [[ "${REAL_API:-0}" != 1 ]]; then
  "$BUN" run "$ROOT/spikes/sdk/src/mock-api.ts" 8771 "$W/mock" > "$W/mock.log" 2>&1 &
  MOCK=$!
  export ANTHROPIC_API_KEY="sk-ant-mock-not-a-real-key" HOMERUN_ANTHROPIC_BASE_URL="http://127.0.0.1:8771/item8"
fi
app_pids() { ps -axo pid=,command= | awk -v p="$W/inst/Homerun.app/Contents/MacOS/" 'index($0, p) { print $1 }'; }
cleanup() { kill "$HTTP" ${MOCK:+"$MOCK"} 2>/dev/null; for p in $(app_pids); do kill "$p" 2>/dev/null; done; }
trap cleanup EXIT
sleep 1

# Fresh keychain item: v_from creates it, so its ACL trusts v_from's designated requirement.
security delete-generic-password -s com.angilyu.homerun -a anthropic-api-key >/dev/null 2>&1

export HOMERUN_UPDATE_CWD="$W/cwd"
export HOMERUN_UPDATE_PROMPT='Run `sleep 25 && echo step1 >> progress.log` with Bash. When it finishes, run `echo step2 >> progress.log`. Then reply with the single word DONE.'
# A crashed earlier launch leaves AppKit crash-restore state that shows a blocking modal alert.
rm -rf "$HOME/Library/Saved Application State/com.angilyu.homerun.savedState"
T0=$(date +%s)
env -i HOME="$HOME" USER="$USER" TMPDIR="$TMPDIR" PATH=/usr/bin:/bin:/usr/sbin:/sbin HOMERUN_DATA_DIR="$D" \
  ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" ${HOMERUN_ANTHROPIC_BASE_URL:+HOMERUN_ANTHROPIC_BASE_URL="$HOMERUN_ANTHROPIC_BASE_URL"} \
  HOMERUN_UPDATE_CWD="$HOMERUN_UPDATE_CWD" HOMERUN_UPDATE_PROMPT="$HOMERUN_UPDATE_PROMPT" \
  "$W/inst/Homerun.app/Contents/MacOS/homerun" --autotest update-flow > "$W/app.stdout" 2>&1 &

q() { sqlite3 -readonly -json "$D/homerun.db" "$1" 2>/dev/null; }
STATUS=""
for ((i = 0; i < 240; i++)); do
  [[ -f "$D/homerun.db" ]] && STATUS="$(sqlite3 -readonly "$D/homerun.db" "SELECT status FROM runs LIMIT 1" 2>/dev/null)"
  [[ "$STATUS" == completed || "$STATUS" == failed ]] && break
  [[ -z "$(app_pids)" ]] && { echo "app exited (see $W/app.stdout)"; break; }
  sleep 1
done
T1=$(date +%s)
sleep 2

cp "$D/logs/shell.log" "$D/logs/homerund.log" "$OUT/" 2>/dev/null
q "SELECT run_id, status, session_id, runtime_version, resumes, result FROM runs" > "$OUT/runs.json"
q "SELECT seq, kind, run_id, payload FROM thread_events ORDER BY seq" > "$OUT/thread_events.json"
cp "$W/cwd/progress.log" "$OUT/progress.log" 2>/dev/null
INST="$W/inst/Homerun.app"
{
  echo "from=$FROMV to=$TOV seconds=$((T1 - T0)) final_status=$STATUS"
  echo "installed_version=$(/usr/libexec/PlistBuddy -c 'Print CFBundleShortVersionString' "$INST/Contents/Info.plist")"
  echo "homerund_version=$("$INST/Contents/MacOS/homerund" version)"
  codesign --verify --deep --strict "$INST" 2>&1 && echo "codesign_verify=ok"
  codesign -d -r- "$INST/Contents/MacOS/homerund" 2>&1 | grep designated
  echo "-- startup keychain reads (one per homerund start):"
  grep -h "startup keychain read" "$D/logs/homerund.log"
  echo "-- progress.log:"; cat "$W/cwd/progress.log" 2>/dev/null
} > "$OUT/summary.txt"
cat "$OUT/summary.txt"; cat "$OUT/runs.json"
