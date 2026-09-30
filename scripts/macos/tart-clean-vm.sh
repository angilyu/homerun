#!/usr/bin/env bash
# The packaged app on a clean Mac (§11, §16 row 8; §16.1 items 6 and 10): a fresh macOS VM with no
# Node, Python, Homebrew, Command Line Tools or ~/.claude, a *downloaded* (quarantined) DMG, and a
# Finder-style launch. The milestone 0 version (spike --autotest hooks, bundled node and uv) is at
# commit 44376c8.
#
#   scripts/macos/tart-clean-vm.sh path/to/Homerun.dmg
#
# Host: Apple silicon and tart (`brew install cirruslabs/cli/tart`). The image is ~27 GB once, and
# each run is an APFS clone of it. sshpass is optional (OpenSSH SSH_ASKPASS is the fallback). The
# vanilla image has user admin/admin and SSH on. KEEP_VM=1 leaves the VM running; TART_IMAGE
# overrides the image.
#
# Report (.spike/results/tart-clean-vm/report-m8.txt):
#   gatekeeper   spctl --assess. A notarized Developer ID build reads "accepted, source=Notarized
#                Developer ID" on a normal Mac. The vanilla image has the Developer ID rules
#                disabled ("rules" below), so it is rejected there with "lack of matching active
#                rule" until someone picks "App Store & Known Developers" in the VM's UI: that
#                click-through is the manual part of item 6 (apps/desktop/README.md, Manual checks).
#   launch       open(1) with the quarantine flag kept; the shell starts homerund, which logs ready.
#                If Gatekeeper holds the launch (phase 1), phase 2 removes the flag and relaunches.
#   awake        idle: no PreventUserIdleSystemSleep from Homerun (§8.1; a busy run's assertion is
#                checked by update-test.sh case 3).
#   no-toolchain nothing but /usr/bin stubs for node, python3 and friends, and no "Install Command
#                Line Developer Tools" dialog during the run (spike entry 27).
set -euo pipefail
DMG="$(cd "$(dirname "${1:?usage: tart-clean-vm.sh Homerun.dmg}")" && pwd)/$(basename "$1")"
IMAGE="${TART_IMAGE:-ghcr.io/cirruslabs/macos-tahoe-vanilla:latest}"
VM="homerun-clean-$$"
OUT="$(cd "$(dirname "$0")/../.." && pwd)/.spike/results/tart-clean-vm"
mkdir -p "$OUT"
command -v tart >/dev/null || { echo "tart not installed (brew install cirruslabs/cli/tart)"; exit 2; }
if command -v sshpass >/dev/null; then SSHPW=(sshpass -p admin); else
  ASKPASS="$(mktemp -t hr-askpass)"; printf '#!/bin/sh\necho admin\n' >"$ASKPASS"; chmod 700 "$ASKPASS"
  export SSH_ASKPASS="$ASKPASS" SSH_ASKPASS_REQUIRE=force; SSHPW=()
fi

tart clone "$IMAGE" "$VM"
SHARE="$(mktemp -d)"; cp "$DMG" "$SHARE/Homerun.dmg"
if [[ "${KEEP_VM:-}" == 1 ]]; then trap 'echo "VM kept: $VM ($(tart ip "$VM" 2>/dev/null))"; rm -rf "$SHARE"' EXIT
else trap 'tart stop "$VM" >/dev/null 2>&1 || true; tart delete "$VM" >/dev/null 2>&1 || true; rm -rf "$SHARE"' EXIT; fi
tart run --no-graphics --dir="share:$SHARE:ro" "$VM" &
for _ in $(seq 60); do IP="$(tart ip "$VM" 2>/dev/null || true)"; [[ -n "$IP" ]] && break; sleep 2; done
SSH=(${SSHPW[@]+"${SSHPW[@]}"} ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR "admin@$IP")
for _ in $(seq 60); do "${SSH[@]}" true 2>/dev/null && break; sleep 2; done

"${SSH[@]}" bash -s <<'VMEOF' | tee "$OUT/report-m8.txt"
set -uo pipefail
echo "## macOS $(sw_vers -productVersion)"
# The vanilla image ships with Gatekeeper assessments disabled; a user's Mac has them on.
echo admin | sudo -S spctl --global-enable 2>/dev/null
echo "## gatekeeper status: $(spctl --status 2>&1)"
cp "/Volumes/My Shared Files/share/Homerun.dmg" ~/Downloads/Homerun.dmg
# What a browser download gets: the quarantine flag, which triggers Gatekeeper on first launch.
xattr -w com.apple.quarantine "0083;$(printf %x "$(date +%s)");Safari;$(uuidgen)" ~/Downloads/Homerun.dmg
hdiutil attach -nobrowse -quiet ~/Downloads/Homerun.dmg -mountpoint /tmp/hrdmg
ditto /tmp/hrdmg/Homerun.app /Applications/Homerun.app   # ditto keeps quarantine, like a Finder drag
hdiutil detach -quiet /tmp/hrdmg
echo "## version: $(/usr/libexec/PlistBuddy -c 'Print CFBundleShortVersionString' /Applications/Homerun.app/Contents/Info.plist)"
echo "## quarantine: $(xattr -p com.apple.quarantine /Applications/Homerun.app 2>&1)"
echo "## no-toolchain: xcode-select -p: $(xcode-select -p 2>&1)"
for t in node npx python3 uv uvx claude bun; do printf '  %s -> %s\n' "$t" "$(command -v "$t" || echo none)"; done
echo "## gatekeeper:"; spctl --assess --type execute -vvv /Applications/Homerun.app 2>&1 | sed 's/^/  /'
echo "## gatekeeper rules (label|disabled; a normal Mac has the Developer ID rules at 0):"
echo admin | sudo -S sqlite3 /var/db/SystemPolicyConfiguration/SystemPolicy \
  "select distinct label, disabled from authority where label like '%Developer ID%';" 2>/dev/null | sed 's/^/  /'

D=~/Library/Application\ Support/Homerun; LOG="$D/logs/homerund.log"
ready() { grep -q '"msg":"ready"' "$LOG" 2>/dev/null; }
wait_ready() { for _ in $(seq "$1"); do ready && return 0; sleep 1; done; return 1; }
report_launch() {
  echo "## launch log:"; grep -E '"msg":"(launch|ready)"' "$LOG" | cut -c1-400 | sed 's/^/  /'
  local shell_pid rt
  shell_pid="$(pgrep -f 'Contents/MacOS/homerun( |$)' | head -1)"
  rt="$(pgrep -P "${shell_pid:-0}" -f 'Contents/MacOS/homerund' | head -1)"
  echo "## processes: shell ${shell_pid:-none}, homerund ${rt:-none} (a child of the shell)"
  echo "## awake while idle: $(pmset -g assertions | grep -c 'caffeinate' || true) caffeinate assertions (expect 0)"
}

echo "## PHASE 1: open with quarantine kept"
open -a /Applications/Homerun.app
if wait_ready 60; then echo "## phase 1: runtime ready"; report_launch
else
  echo "## phase 1: no runtime after 60 s (Gatekeeper holds a quarantined launch it can't approve)"
  echo "## syspolicyd:"; log show --last 2m --predicate 'process == "syspolicyd"' --style compact 2>/dev/null | grep -i homerun | tail -8 | cut -c1-300
  for p in $(pgrep -f 'Homerun.app/Contents/MacOS/'); do kill "$p" 2>/dev/null; done
  for p in $(pgrep -x CoreServicesUIAgent); do kill "$p" 2>/dev/null; done; sleep 3
  # syspolicyd keeps the held evaluation pending and every later launch joins it (spike entry 26).
  for p in $(pgrep -x syspolicyd); do echo admin | sudo -S kill "$p" 2>/dev/null; done; sleep 5
  xattr -dr com.apple.quarantine /Applications/Homerun.app; rm -rf "$D"
  echo "## PHASE 2: quarantine removed, fresh data dir"
  open -n -a /Applications/Homerun.app
  if wait_ready 90; then echo "## phase 2: runtime ready"; report_launch; else echo "## phase 2: FAIL no runtime"; tail -20 "$LOG" 2>/dev/null; fi
fi
sleep 5
echo "## clt-prompt after run: $(pgrep -fl 'Install Command Line Developer Tools' || echo none)"
osascript -e 'tell application "Homerun" to quit' >/dev/null 2>&1 || true
sleep 3
echo "## quit log: $(grep '"msg":"quit"' "$LOG" | tail -1 | cut -c1-300)"
VMEOF
echo "report: $OUT/report-m8.txt"
