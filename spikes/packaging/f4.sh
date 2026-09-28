#!/usr/bin/env bash
# F4: how to ship the third-party pre-signed helpers (claude, node, uv).
#   A = keep the vendor's Developer ID signature (nested code under other Team IDs)
#   B = re-sign with our identity and our minimal entitlements
# For each: strict deep verify, Gatekeeper assessment, Apple's pre-notarization check
# (syspolicy_check notary-submission), and launch of every helper as a child of the
# hardened-runtime homerund inside the bundle (helpers.check via the shell autotest).
#   spikes/packaging/f4.sh            (uses the last unsigned Tauri build)
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SRC="$ROOT/apps/desktop/src-tauri/target/release/bundle/macos/Homerun.app"
RES="$ROOT/.spike/results/f4"; mkdir -p "$RES"
for v in A B; do
  W="$ROOT/.spike/f4/$v"; rm -rf "$W"; mkdir -p "$W"
  ditto "$SRC" "$W/Homerun.app"
  tp=$([[ $v == A ]] && echo keep || echo resign)
  THIRD_PARTY=$tp IDENTITY="${IDENTITY:--}" "$ROOT/scripts/macos/sign.sh" "$W/Homerun.app" > "$RES/$v-sign.txt" 2>&1
  "$ROOT/scripts/macos/verify.sh" "$W/Homerun.app" > "$RES/$v-verify.txt" 2>&1; vrc=$?
  syspolicy_check notary-submission "$W/Homerun.app" > "$RES/$v-notary-precheck.txt" 2>&1; nrc=$?
  D="/tmp/hrf4$v"; rm -rf "$D"; mkdir -p "$D"   # short: sun_path is 104 bytes
  "$ROOT/spikes/packaging/run-app.sh" "$W/Homerun.app" "$D" selftest 150 > "$RES/$v-selftest.txt" 2>&1
  checks=$(grep -o 'helpers.check -> .*' "$RES/$v-selftest.txt" | head -1)
  echo "variant $v ($tp): strict-verify rc=$vrc; notary-precheck rc=$nrc; spctl: $(grep -A1 '^## spctl' "$RES/$v-verify.txt" | tail -1)"
  echo "  $checks" | cut -c1-900
done
