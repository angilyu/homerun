#!/usr/bin/env bash
# The signed updater end to end, with the real shell and runtime (§11, §16 row 8; spike entry 8).
#
#   scripts/macos/update-test.sh [adhoc|devid]      (default adhoc)
#
# Builds A (FROM, default 0.90.0) and B (TO, 0.90.1) with package.sh as update-test builds: an
# ephemeral minisign key that is deleted on exit, a latest.json served on 127.0.0.1, and a
# development-channel homerund, so the scripted mock API (spikes/sdk/src/mock-api.ts) stands in
# for the model. No API key or network is used.
#
# 1. Restart now, mid-run: A starts a run that waits on a question, finds B at its first check
#    (60 s after launch), downloads and verifies it, and takes the Restart now path
#    (HOMERUN_TEST_RESTART_WHEN_READY) through the quit confirmation (auto-accepted by
#    HOMERUN_TEST_CONFIRM_QUIT). Asserts: B is installed and running; its homerund is B's;
#    codesign --verify passes; the run was recovered, still waits, and completes once answered;
#    the API key written by A is read by B; no keychain prompt (devid).
# 2. Install on quit: a fresh A checks at once (HOMERUN_UPDATE_CHECK_NOW), is quit with
#    AppleScript while idle, and is B when opened again.
# 3. Keeping awake (§8.1), on B: a busy run holds PreventUserIdleSystemSleep through a caffeinate
#    child of homerund (pmset -g assertions); it goes when the run ends, and when homerund is killed.
#    (A run waiting for an answer holds none, so case 1 can't show it.)
#
# devid signs with Developer ID and the provisioning profile (sign.sh), so the key sits in the
# data-protection keychain under a test service (com.angilyu.homerun.update-test), never the
# user's real item. adhoc keeps the key in memory: an ad-hoc build is a new code identity each
# time, and the legacy keychain would prompt (spike entry 8).
# Evidence: dist/update-test/<variant>/summary.txt
set -euo pipefail
VARIANT="${1:-adhoc}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
BUN="$ROOT/node_modules/.bin/bun"
FROM="${FROM:-0.90.0}"; TO="${TO:-0.90.1}"
PORT=8799; MOCK_PORT=8771
W="$(mktemp -d /private/tmp/hr-update.XXXXXX)"
EVID="$ROOT/dist/update-test/$VARIANT"; rm -rf "$EVID"; mkdir -p "$EVID"
case "$VARIANT" in
  adhoc) SIGN=(IDENTITY=-) ;;
  devid)
    SIGN=(IDENTITY="Developer ID Application: Wenjing Yu (NMJBY8WL8T)" TEAM_ID=NMJBY8WL8T THIRD_PARTY=hybrid
      PROVISIONING_PROFILE="${PROVISIONING_PROFILE:-$HOME/Documents/Important/Homerun.provisionprofile}") ;;
  *) echo "usage: update-test.sh [adhoc|devid]" >&2; exit 64 ;;
esac

for p in "$PORT" "$MOCK_PORT"; do
  # A stale listener would answer in place of this run's server or mock.
  if lsof -nP -iTCP:"$p" -sTCP:LISTEN >/dev/null 2>&1; then echo "port $p is in use" >&2; exit 1; fi
done
pids=()
app_pids() { ps -axo pid=,command= | awk -v p="$W/" 'index($0, p) && /Contents\/MacOS\/homerun( |$)/ { print $1 }'; }
cleanup() {
  for p in $(app_pids); do kill "$p" 2>/dev/null || true; done
  for p in "${pids[@]}"; do kill "$p" 2>/dev/null || true; done
  rm -f "$W/key/updater.key"
}
trap cleanup EXIT
fail() { echo "FAIL: $*" | tee -a "$EVID/summary.txt" >&2; exit 1; }
say() { echo "$*" | tee -a "$EVID/summary.txt"; }

# Ephemeral key, outside the repo; its secret half is removed on exit.
mkdir -p "$W/key" "$W/serve"
pnpm --dir "$ROOT/apps/desktop" exec tauri signer generate --ci -p "" -w "$W/key/updater.key" -f >/dev/null 2>&1

build() { # version out
  env "${SIGN[@]}" VERSION="$1" OUT="$2" NO_DMG=1 RUNTIME_CHANNEL=development \
    UPDATER_KEY="$W/key/updater.key" UPDATER_KEY_NO_PASSWORD=1 \
    UPDATER_ENDPOINT="http://127.0.0.1:$PORT/latest.json" UPDATE_URL="http://127.0.0.1:$PORT/Homerun.app.tar.gz" \
    "$ROOT/scripts/macos/package.sh" >"$W/build-$1.log" 2>&1 || { tail -20 "$W/build-$1.log" >&2; fail "building $1 ($W/build-$1.log)"; }
}
echo "building A=$FROM and B=$TO ($VARIANT)…"
build "$FROM" "$W/a"; build "$TO" "$W/b"
cp "$W/b/Homerun.app.tar.gz" "$W/b/latest.json" "$W/serve/"
rm -f "$W/key/updater.key"

python3 -m http.server "$PORT" --bind 127.0.0.1 --directory "$W/serve" >"$W/http.log" 2>&1 & pids+=($!); disown
"$BUN" run "$ROOT/spikes/sdk/src/mock-api.ts" "$MOCK_PORT" "$W/mock" >"$W/mock.log" 2>&1 & pids+=($!); disown
sleep 1

cli() { HOMERUN_DATA_DIR="$D" "$BUN" "$ROOT/apps/cli/src/main.ts" "$@"; }
launches() { grep -c '"msg":"launch"' "$D/logs/homerund.log" 2>/dev/null || true; }
wait_for() { # seconds description command…
  local n="$1" what="$2"; shift 2
  for ((i = 0; i < n; i++)); do "$@" >/dev/null 2>&1 && return 0; sleep 1; done
  fail "timed out waiting for $what"
}
start_app() { # app-dir extra-env…
  local app="$1"; shift
  rm -rf "$HOME/Library/Saved Application State/com.angilyu.homerun.savedState"
  env -i HOME="$HOME" USER="$USER" TMPDIR="$TMPDIR" PATH=/usr/bin:/bin:/usr/sbin:/sbin HOMERUN_DATA_DIR="$D" \
    ANTHROPIC_API_KEY=sk-ant-mock-not-a-real-key HOMERUN_ANTHROPIC_BASE_URL="http://127.0.0.1:$MOCK_PORT/update" \
    HOMERUN_TEST_CONFIRM_QUIT=1 "${KEYSTORE[@]}" "$@" \
    "$app/Contents/MacOS/homerun" >>"$W/app.stdout" 2>&1 &
}
version_of() { /usr/libexec/PlistBuddy -c 'Print CFBundleShortVersionString' "$1/Contents/Info.plist"; }
if [[ "$VARIANT" == devid ]]; then KEYSTORE=(HOMERUN_TEST_KEYCHAIN_SERVICE=com.angilyu.homerun.update-test); else KEYSTORE=(HOMERUN_KEYSTORE=memory); fi
ready() { cli status 2>/dev/null | grep -q "protocol"; }

say "variant=$VARIANT from=$FROM to=$TO"

# ---- 1. Restart now, mid-run ------------------------------------------------------------------
D="$W/data1"; mkdir -p "$W/inst1"; ditto "$W/a/Homerun.app" "$W/inst1/Homerun.app"
T0=$(date +%s)
start_app "$W/inst1/Homerun.app" HOMERUN_TEST_RESTART_WHEN_READY=1
wait_for 60 "A's runtime" ready
# The data-protection keychain refuses every read while the Mac is locked (errSecInteractionNotAllowed).
grep '"msg":"launch"' "$D/logs/homerund.log" | tail -1 | grep -q '"onboarded":true' ||
  fail "A has no API key: the keychain refused it (is the Mac locked? devid needs an unlocked session)"
cli send --new --detach 'Use AskUserQuestion to ask which colour I prefer. Then reply with the colour I chose.' >"$W/send.txt" 2>&1
wait_for 30 "the question" sh -c "HOMERUN_DATA_DIR='$D' '$BUN' '$ROOT/apps/cli/src/main.ts' status | grep -q 'waiting for input'"
say "1. run waiting on a question under A; waiting for A's first update check"
wait_for 240 "B to be running" sh -c "[ \$(grep -c '\"msg\":\"launch\"' '$D/logs/homerund.log') -ge 2 ]"
wait_for 60 "B's runtime" ready
T1=$(date +%s)
INST="$W/inst1/Homerun.app"
[[ "$(version_of "$INST")" == "$TO" ]] || fail "installed version is $(version_of "$INST")"
cmp -s "$INST/Contents/MacOS/homerund" "$W/b/Homerun.app/Contents/MacOS/homerund" || fail "homerund is not B's"
codesign --verify --deep --strict "$INST" 2>>"$EVID/summary.txt" || fail "codesign --verify"
grep '"msg":"launch"' "$D/logs/homerund.log" | tail -1 | grep -q "\"version\":\"$TO\"" || fail "the running shell is not $TO"
# Log keys are sorted, so each field is matched on its own.
quit_line() { grep '"msg":"quit"' "$D/logs/homerund.log" | tail -1; }
quit_line | grep '"why":"update"' | grep -q '"asked":true' || fail "Restart now didn't confirm with a run active"
# A run still in its short wait is recovered by B's runtime; one already parked for input holds
# no process and simply waits in SQLite (§5.4, §5.6). Either way the question must survive.
if grep '"msg":"ready"' "$D/logs/homerund.log" | tail -1 | grep -q '"recovered":1'; then HOW="recovered by B"
elif grep -q '"msg":"run deferred for input"' "$D/logs/homerund.log"; then HOW="parked for input under A"
else fail "B's runtime didn't recover the run"; fi
grep '"secrets handed over"' "$D/logs/homerund.log" | tail -1 | grep -q anthropic_api_key || fail "B didn't read the API key"
say "1. installed $TO in $((T1 - T0)) s; homerund is B's; codesign OK; run $HOW; key read by B"
REQ="$(cli input list 2>/dev/null | awk 'NR == 2 { print $1 }')"
[[ -n "$REQ" ]] || fail "the question didn't survive the update"
cli answer "$REQ" --choice Blue >/dev/null 2>&1
wait_for 60 "the run to finish" sh -c "HOMERUN_DATA_DIR='$D' '$BUN' '$ROOT/apps/cli/src/main.ts' runs list -n 1 | grep -q succeeded"
THREAD="$(awk '/new thread/ { print $3 }' "$W/send.txt")"
cli threads show "$THREAD" -n 3 2>/dev/null | grep -q "BLUE" || fail "the answer didn't reach the model"
say "1. answered after the update; the run succeeded"
PROMPTS="$(log show --start "@$T0" --style compact --predicate 'process == "securityd" AND eventMessage CONTAINS "displaying keychain prompt"' 2>/dev/null | grep -c 'displaying keychain prompt' || true)"
say "1. keychain prompts during the test: $PROMPTS"
[[ "$VARIANT" != devid || "$PROMPTS" == 0 ]] || fail "keychain prompt after the update"
cp "$D/logs/homerund.log" "$EVID/case1-homerund.log"
osascript -e "tell application \"$INST\" to quit" >/dev/null 2>&1 || true
wait_for 30 "B to quit" sh -c "[ -z \"\$(ps -axo command= | grep -F '$W/inst1/' | grep -v grep)\" ]"

# ---- 2. Install on quit, idle -----------------------------------------------------------------
D="$W/data2"; mkdir -p "$W/inst2"; ditto "$W/a/Homerun.app" "$W/inst2/Homerun.app"
start_app "$W/inst2/Homerun.app" HOMERUN_UPDATE_CHECK_NOW=1
wait_for 60 "A's runtime" ready
wait_for 120 "the download" sh -c "ls '$D/updates/'*.tar.gz >/dev/null 2>&1"
sleep 2
osascript -e "tell application \"$W/inst2/Homerun.app\" to quit" >/dev/null 2>&1 || true
wait_for 60 "A to quit" sh -c "[ -z \"\$(ps -axo command= | grep -F '$W/inst2/' | grep -v grep)\" ]"
[[ "$(version_of "$W/inst2/Homerun.app")" == "$TO" ]] || fail "install on quit: still $(version_of "$W/inst2/Homerun.app")"
quit_line | grep '"why":"user"' | grep -q '"asked":false' || fail "an idle quit asked for confirmation"
start_app "$W/inst2/Homerun.app"
wait_for 60 "B's runtime" ready
grep '"msg":"launch"' "$D/logs/homerund.log" | tail -1 | grep -q "\"version\":\"$TO\"" || fail "the relaunched shell is not $TO"
codesign --verify --deep --strict "$W/inst2/Homerun.app" 2>>"$EVID/summary.txt" || fail "codesign --verify (2)"
say "2. idle quit installed $TO; it opens as $TO"

# ---- 3. Keeping awake from the packaged app (§8.1, spike-results "Still open") ------------------
hd_pid() { pgrep -f "$W/inst2/Homerun.app/Contents/MacOS/homerund" | head -1; }
awake_pid() { local h; h="$(hd_pid)"; [[ -n "$h" ]] && pgrep -P "$h" -x caffeinate; }
# Captured first: grep -q closing the pipe early would fail pmset under pipefail.
asserted() { local c a; c="$(awake_pid)" && a="$(pmset -g assertions)" && grep -qE "pid $c\(caffeinate\).*PreventUserIdleSystemSleep" <<<"$a"; }
cli send --new --detach 'Take 15 seconds. Then reply with the single word AWAKE.' >/dev/null 2>&1
wait_for 15 "the power assertion" asserted
wait_for 60 "the busy run to finish" sh -c "HOMERUN_DATA_DIR='$D' '$BUN' '$ROOT/apps/cli/src/main.ts' runs list -n 1 | grep -q succeeded"
sleep 1; [[ -z "$(awake_pid)" ]] || fail "the power assertion outlived the run"
say "3. a busy run holds PreventUserIdleSystemSleep (caffeinate, a child of homerund); released when it ends"
cli send --new --detach 'Take 30 seconds. Then reply with the single word AGAIN.' >/dev/null 2>&1
wait_for 15 "the power assertion (2)" asserted
C="$(awake_pid)"; kill -9 "$(hd_pid)"
wait_for 5 "caffeinate to exit with homerund" sh -c "! kill -0 $C 2>/dev/null"
say "3. caffeinate exits when homerund is killed"
cp "$D/logs/homerund.log" "$EVID/case2-homerund.log"
osascript -e "tell application \"$W/inst2/Homerun.app\" to quit" >/dev/null 2>&1 || true
sleep 3
say "PASS"
rm -rf "$W"
