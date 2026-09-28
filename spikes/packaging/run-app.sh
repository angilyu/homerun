#!/usr/bin/env bash
# Launch a built Homerun.app's shell binary with a scrubbed environment and an
# --autotest driver; wait up to $TIMEOUT s; print shell + runtime logs.
#   spikes/packaging/run-app.sh <Homerun.app> <data-dir> <autotest> [timeout]
set -uo pipefail
APP="$1"; D="$2"; WHAT="$3"; TIMEOUT="${4:-120}"
ENVV=(HOME="$HOME" USER="$USER" TMPDIR="$TMPDIR" PATH=/usr/bin:/bin:/usr/sbin:/sbin HOMERUN_DATA_DIR="$D")
for v in HOMERUN_NPM_REGISTRY HOMERUN_UV_INDEX_URL HOMERUN_SELFTEST_NPX_PKG ANTHROPIC_API_KEY HOMERUN_ANTHROPIC_BASE_URL HOMERUN_UPDATE_CWD HOMERUN_UPDATE_PROMPT HOMERUN_MODEL HOMERUN_KEYCHAIN_GROUP; do
  val="$(printenv "$v" || true)"
  [[ -n "$val" ]] && ENVV+=("$v=$val")
done
# A crashed earlier launch leaves AppKit crash-restore state that shows a blocking modal alert.
rm -rf "$HOME/Library/Saved Application State/com.angilyu.homerun.savedState"
env -i "${ENVV[@]}" "$APP/Contents/MacOS/homerun" --autotest "$WHAT" > "$D.stdout" 2>&1 &
PID=$!
for ((i = 0; i < TIMEOUT; i++)); do kill -0 "$PID" 2>/dev/null || break; sleep 1; done
if kill -0 "$PID" 2>/dev/null; then kill "$PID"; echo "(timeout after ${TIMEOUT}s, killed $PID)"; fi
echo "== shell.log"; cut -c1-4000 "$D/logs/shell.log" 2>/dev/null
echo "== homerund.log"; cut -c1-1500 "$D/logs/homerund.log" 2>/dev/null
