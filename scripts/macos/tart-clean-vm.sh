#!/usr/bin/env bash
# §16.1 items 6 + 10 on a clean machine: a fresh macOS VM with no Node, Python, Homebrew or
# ~/.claude, a *downloaded* (quarantined) DMG, and a normal Finder-style launch.
#
#   scripts/macos/tart-clean-vm.sh path/to/Homerun.dmg
#
# Requirements (host): Apple silicon, tart (`brew install cirruslabs/cli/tart`, or the GitHub release),
# ~60 GB free disk. sshpass is optional (OpenSSH SSH_ASKPASS is the fallback). The vanilla image has
# user admin/admin, SSH enabled, and Gatekeeper disabled (the script enables it). KEEP_VM=1 leaves the
# VM running for debugging.
# Override the image with TART_IMAGE (default: the Tahoe vanilla image).
#
# Pass criteria (printed at the end):
#   gatekeeper   spctl --assess → "accepted, source=Notarized Developer ID" (requires the real
#                Developer ID + notarize.sh; ad-hoc/self-signed builds are expected to be rejected)
#   launch       the app starts via `open` with the quarantine flag set, homerund answers ping
#   helpers      claude, node, uv start as children of homerund (helpers.check)
#   keychain     keychain.set/get round trip from the bundle
#   mcp          npx (bundled node) and uvx (bundled uv) MCP servers answer a tool call
#   no-toolchain `which node python3 npx uvx` finds nothing on the VM's PATH beyond /usr/bin stubs
#   clt-prompt   no "Install Command Line Developer Tools" dialog appears during the run
#
# Phase 2 (only if the quarantined launch is blocked, as it is for non-notarized builds): cancel the
# Gatekeeper prompt, restart syspolicyd (it keeps the prompt's evaluation pending and holds every later
# launch of the same code), remove the quarantine flag and rerun the functional checks in a fresh
# data dir (the default, ~/Library/Application Support/Homerun; spike-results entry 26).
set -euo pipefail
DMG="$(cd "$(dirname "${1:?usage: tart-clean-vm.sh Homerun.dmg}")" && pwd)/$(basename "$1")"
IMAGE="${TART_IMAGE:-ghcr.io/cirruslabs/macos-tahoe-vanilla:latest}"
VM="homerun-clean-$$"
OUT="$(cd "$(dirname "$0")/../.." && pwd)/.spike/results/tart-clean-vm"
mkdir -p "$OUT"
command -v tart >/dev/null || { echo "tart not installed (brew install cirruslabs/cli/tart)"; exit 2; }
# sshpass if present; otherwise OpenSSH's own SSH_ASKPASS (8.4+), which needs no extra install.
if command -v sshpass >/dev/null; then SSHPW=(sshpass -p admin); else
  ASKPASS="$(mktemp -t hr-askpass)"; printf '#!/bin/sh\necho admin\n' >"$ASKPASS"; chmod 700 "$ASKPASS"
  export SSH_ASKPASS="$ASKPASS" SSH_ASKPASS_REQUIRE=force; SSHPW=()
fi

tart clone "$IMAGE" "$VM"
# KEEP_VM=1 leaves the VM running for debugging (delete it yourself: tart stop/delete "$VM").
if [[ "${KEEP_VM:-}" == 1 ]]; then trap 'echo "VM kept: $VM ($(tart ip "$VM" 2>/dev/null))"' EXIT
else trap 'tart stop "$VM" >/dev/null 2>&1 || true; tart delete "$VM" >/dev/null 2>&1 || true' EXIT; fi
SHARE="$(mktemp -d)"; cp "$DMG" "$SHARE/Homerun.dmg"
# The npx fixture: a local MCP server with a native addon (better-sqlite3), packed to a tarball.
( cd "$(dirname "$0")/../../spikes/mcp-native" && npm pack --silent --pack-destination "$SHARE" >/dev/null && mv "$SHARE"/homerun-spike-mcp-native-*.tgz "$SHARE/mcp-native.tgz" )
tart run --no-graphics --dir="share:$SHARE:ro" "$VM" &
for _ in $(seq 60); do IP="$(tart ip "$VM" 2>/dev/null || true)"; [[ -n "$IP" ]] && break; sleep 2; done
SSH=(${SSHPW[@]+"${SSHPW[@]}"} ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null "admin@$IP")
for _ in $(seq 60); do "${SSH[@]}" true 2>/dev/null && break; sleep 2; done

"${SSH[@]}" bash -s <<'VMEOF' | tee "$OUT/report.txt"
set -uo pipefail
# The vanilla image ships with Gatekeeper assessments disabled; a user's Mac has them on.
echo "## gatekeeper status (image default): $(spctl --status 2>&1)"
echo admin | sudo -S spctl --global-enable 2>/dev/null
echo "## gatekeeper status (after enable): $(spctl --status 2>&1)"
SRC="/Volumes/My Shared Files/share/Homerun.dmg"
cp "$SRC" ~/Downloads/Homerun.dmg
# What a browser download gets: the quarantine flag, which triggers Gatekeeper on first launch.
xattr -w com.apple.quarantine "0083;$(printf %x "$(date +%s)");Safari;$(uuidgen)" ~/Downloads/Homerun.dmg
hdiutil attach -nobrowse -quiet ~/Downloads/Homerun.dmg -mountpoint /tmp/hrdmg
ditto /tmp/hrdmg/Homerun.app /Applications/Homerun.app   # ditto keeps quarantine, like a Finder drag
hdiutil detach -quiet /tmp/hrdmg
echo "## quarantine: $(xattr -p com.apple.quarantine /Applications/Homerun.app 2>&1)"
echo "## no-toolchain: (xcode-select -p: $(xcode-select -p 2>&1); /usr/bin/python3 is only the CLT install stub without it)"; for t in node npx python3 uv uvx claude; do printf '  %s -> %s\n' "$t" "$(command -v "$t" || echo none)"; done
echo "## clt-prompt before launch: $(pgrep -fl 'Install Command Line Developer Tools' || echo none)"
echo "## gatekeeper:"; spctl --assess --type execute -vvv /Applications/Homerun.app 2>&1 | sed 's/^/  /'
syspolicy_check distribution /Applications/Homerun.app 2>&1 | sed 's/^/  /' || true
echo "## launch (open, as Finder would), autotest selftest"
cp "/Volumes/My Shared Files/share/mcp-native.tgz" /tmp/mcp-native.tgz
open -a /Applications/Homerun.app --env HOMERUN_SELFTEST_NPX_PKG="/tmp/mcp-native.tgz#homerun-spike-mcp-native" --args --autotest selftest
# The selftest driver exits the app when done; wait for that (or 180 s).
sleep 5
# A quarantined launch runs translocated, so match the bundle-relative path. A launch held at the
# Gatekeeper prompt never writes shell.log; stop waiting for it after 30 s.
for i in $(seq 180); do
  pgrep -f 'Homerun.app/Contents/MacOS/homerun' >/dev/null || break
  [ "$i" -gt 30 ] && [ ! -e ~/Library/Application\ Support/Homerun/logs/shell.log ] && break
  sleep 1
done
echo "## shell.log"; cut -c1-3000 ~/Library/Application\ Support/Homerun/logs/shell.log 2>/dev/null || echo "  (no shell.log: app did not start; see Gatekeeper result above)"
echo "## syspolicyd (last 2 min)"; log show --last 2m --predicate 'process == "syspolicyd"' --style compact 2>/dev/null | grep -i homerun | tail -20
# A self-signed or ad-hoc build is expected to be blocked while quarantined. Re-run the functional
# checks with the flag removed, so they are still tested; the Gatekeeper result above stands.
LOG=~/Library/Application\ Support/Homerun/logs/shell.log
if ! grep -q 'autotest rt ping' "$LOG" 2>/dev/null; then
  echo "## PHASE 2: quarantined launch did not reach the runtime; removing com.apple.quarantine and relaunching"
  # The held launch runs from an AppTranslocation path, so match on the bundle-relative path.
  for p in $(pgrep -f 'Homerun.app/Contents/MacOS/'); do kill "$p" 2>/dev/null; done
  # Cancel the pending "cannot be opened" Gatekeeper prompt.
  for p in $(pgrep -x CoreServicesUIAgent); do kill "$p" 2>/dev/null; done; sleep 3
  # syspolicyd keeps that prompt's evaluation pending even with its process and the prompt gone;
  # every later launch of the same code joins it ("waiting on another evaluation") and sits at
  # _dyld_start. Restarting syspolicyd (launchd respawns it) drops the pending evaluation.
  for p in $(pgrep -x syspolicyd); do echo admin | sudo -S kill "$p" 2>/dev/null; done; sleep 5
  echo "## syspolicyd restarted (launchd respawns it on demand)"
  xattr -dr com.apple.quarantine /Applications/Homerun.app
  echo "## quarantine after removal: $(xattr -p com.apple.quarantine /Applications/Homerun.app 2>&1)"
  D2=~/Library/Application\ Support/Homerun; LOG="$D2/logs/shell.log"; rm -rf "$D2"
  # -n: LaunchServices still holds the launch that is waiting at the Gatekeeper prompt.
  open -n -a /Applications/Homerun.app --env HOMERUN_SELFTEST_NPX_PKG="/tmp/mcp-native.tgz#homerun-spike-mcp-native" --args --autotest selftest
  sleep 5
  for _ in $(seq 240); do pgrep -f 'Homerun.app/Contents/MacOS/homerun' >/dev/null || break; sleep 1; done
  echo "## shell.log (phase 2, quarantine removed, fresh $D2)"; cut -c1-3000 "$LOG" 2>/dev/null || echo "  (no shell.log in phase 2 either)"
fi
sleep 3
echo "## clt-prompt after run: $(pgrep -fl 'Install Command Line Developer Tools' || echo none)"
VMEOF
echo "report: $OUT/report.txt"
