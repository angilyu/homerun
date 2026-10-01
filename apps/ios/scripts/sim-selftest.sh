#!/bin/bash
# The protocol vectors under Hermes on an iOS simulator (§16.2, .github/workflows/ios.yml ios-sim).
# Boots an iPhone simulator, installs the Release build, launches it with `-HomerunSelfTest 1`, and
# reads the result line the app writes to stdout and to Library/Caches/HomerunSelfTest.txt
# (HomerunModule.swift, selfTestReport). Every wait is bounded, and a failure prints what was seen.
#
#   sim-selftest.sh pick                  print the UDID of the newest available iPhone simulator
#   sim-selftest.sh [Homerun.app] [dir]   the self-test; SIM_UDID picks the simulator, and dir
#                                         keeps the app's stdout and stderr and, on failure, a
#                                         screenshot
set -uo pipefail
bundle=com.angilyu.homerun.ios
t0=$(date +%s)
say() { echo "[$(($(date +%s) - t0))s] $*"; }
# macOS has no timeout(1).
bounded() {
  local s=$1
  shift
  perl -e 'alarm shift; exec @ARGV' "$s" "$@"
}
pick() {
  xcrun simctl list devices available -j | python3 -c '
import json, sys
d = json.load(sys.stdin)["devices"]
print(next((x["udid"] for r, v in sorted(d.items(), reverse=True) if "iOS" in r for x in v if x["name"].startswith("iPhone")), ""))'
}

if [ "${1:-}" = pick ]; then
  pick
  exit
fi

app=${1:-build/Build/Products/Release-iphonesimulator/Homerun.app}
out=${2:-$(mktemp -d)}
mkdir -p "$out"
result=""
udid=${SIM_UDID:-$(pick)}

fail() {
  say "FAILED: $*"
  echo "--- the app's stdout"
  tail -n 40 "$out/stdout" 2>/dev/null || echo "(none)"
  echo "--- the app's stderr"
  tail -n 40 "$out/stderr" 2>/dev/null || echo "(none)"
  echo "--- the result file"
  { [ -n "$result" ] && cat "$result" 2>/dev/null; } || echo "(none)"
  if [ -n "$udid" ]; then
    echo "--- the simulator"
    xcrun simctl list devices | grep "$udid"
    bounded 10 xcrun simctl spawn "$udid" launchctl list 2>/dev/null | grep -i homerun || echo "(the app isn't running)"
    bounded 10 xcrun simctl io "$udid" screenshot "$out/screen.png" >/dev/null 2>&1 && echo "screenshot: $out/screen.png"
    echo "--- the app's unified log, last 3 minutes"
    bounded 30 xcrun simctl spawn "$udid" log show --last 3m --style compact --predicate 'process == "Homerun"' 2>/dev/null | tail -n 60
  fi
  exit 1
}

[ -n "$udid" ] || {
  xcrun simctl list devices available
  fail "no available iPhone simulator"
}
[ -d "$app" ] || fail "no app at $app"

say "booting $(xcrun simctl list devices | grep "$udid" | sed -E 's/^ +//')"
bounded 110 xcrun simctl bootstatus "$udid" -b >"$out/bootstatus" 2>&1 || fail "the simulator didn't finish booting within 110 s: $(tail -n 3 "$out/bootstatus")"
say "booted; installing"
bounded 45 xcrun simctl install "$udid" "$app" || fail "the app didn't install within 45 s"
say "installed; launching"
bounded 20 xcrun simctl launch --terminate-running-process --stdout="$out/stdout" --stderr="$out/stderr" "$udid" "$bundle" -HomerunSelfTest 1 ||
  fail "the app didn't launch within 20 s"
data=$(bounded 10 xcrun simctl get_app_container "$udid" "$bundle" data) || fail "the app has no data container"
result="$data/Library/Caches/HomerunSelfTest.txt"
say "launched; waiting for the result"
line=""
for _ in $(seq 1 45); do
  line=$(cat "$result" "$out/stdout" 2>/dev/null | grep -o 'HomerunSelfTest vectors:.*' | tail -n 1)
  [ -n "$line" ] && break
  sleep 1
done
[ -n "$line" ] || fail "no result line within 45 s"
say "${line#HomerunSelfTest }"
case "$line" in
*failed* | *crashed*) fail "the vectors didn't all pass" ;;
esac
