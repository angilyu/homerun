#!/usr/bin/env bash
# §16.1 measurement: idle memory of the whole desktop app (Tauri shell + WebKit helper
# processes + homerund) with no runs, 20 s after launch.
#   spikes/packaging/shell-idle.sh [Homerun.app]
# WebKit's WebContent/Networking/GPU processes are XPC services parented by launchd, so
# they are attributed as "WebKit processes that appeared after launch". Prints JSON.
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SRC="${1:-$ROOT/dist/macos/0.0.2/Homerun.app}"
W=/private/tmp/hridle
rm -rf "$W" && mkdir -p "$W/d"
ditto "$SRC" "$W/Homerun.app"
wk() { ps -axo pid=,comm= | awk '/com\.apple\.WebKit\./{print $1}' | sort -n; }
wk > "$W/wk.before"
rm -rf "$HOME/Library/Saved Application State/com.angilyu.homerun.savedState"
env -i HOME="$HOME" USER="$USER" TMPDIR="$TMPDIR" PATH=/usr/bin:/bin HOMERUN_DATA_DIR="$W/d" "$W/Homerun.app/Contents/MacOS/homerun" > "$W/stdout" 2>&1 &
PID=$!
sleep 20
wk > "$W/wk.after"
NEW="$(comm -13 "$W/wk.before" "$W/wk.after" | tr '\n' ' ')"
RTD="$(ps -axo pid=,ppid=,comm= | awk -v p="$PID" '$2==p && /homerund/{print $1}')"
fp() { footprint "$@" 2>/dev/null | awk '/Footprint:/ {for(i=1;i<=NF;i++) if($i ~ /^(KB|MB|GB)$/){v=$(i-1); u=$i; break}; mb=(u=="KB")?v/1024:(u=="GB")?v*1024:v; last=mb} /^Summary Footprint:/ {sum=mb} END{printf "%d", (sum!="")?sum:last}'; }
rss() { local s=0; for p in "$@"; do r="$(ps -o rss= -p "$p" | tr -d ' ')"; s=$((s + ${r:-0})); done; echo $((s / 1024)); }
row() { local name="$1"; shift; [[ $# -eq 0 ]] && { printf '"%s":null' "$name"; return; }
  local args=(); for p in "$@"; do args+=(-p "$p"); done
  printf '"%s":{"pids":"%s","rssMiB":%s,"footprintMB":%s}' "$name" "$*" "$(rss "$@")" "$(fp "${args[@]}")"; }
printf '{%s,%s,%s,' "$(row shell "$PID")" "$(row homerund $RTD)" "$(row webkit $NEW)"
printf '%s,"webkitProcs":"%s"}\n' "$(row total "$PID" $RTD $NEW)" "$(for p in $NEW; do ps -o comm= -p "$p" | sed 's/.*\///'; done | sort | uniq -c | tr -s ' ' | tr '\n' ';')"
kill "$PID"
sleep 2
rm -rf "$W"
