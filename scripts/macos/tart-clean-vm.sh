#!/usr/bin/env bash
# §16.1 items 6 + 10 on a clean machine: a fresh macOS VM with no Node, Python, Homebrew or
# ~/.claude, a *downloaded* (quarantined) DMG, and a normal Finder-style launch.
#
#   scripts/macos/tart-clean-vm.sh path/to/Homerun.dmg
#
# Requirements (host): Apple silicon, `brew install cirruslabs/cli/tart hudochenkov/sshpass/sshpass`,
# ~60 GB free disk. The vanilla image has user admin/admin and SSH enabled.
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
set -euo pipefail
DMG="$(cd "$(dirname "${1:?usage: tart-clean-vm.sh Homerun.dmg}")" && pwd)/$(basename "$1")"
IMAGE="${TART_IMAGE:-ghcr.io/cirruslabs/macos-tahoe-vanilla:latest}"
VM="homerun-clean-$$"
OUT="$(cd "$(dirname "$0")/../.." && pwd)/.spike/results/tart-clean-vm"
mkdir -p "$OUT"
command -v tart >/dev/null || { echo "tart not installed (brew install cirruslabs/cli/tart)"; exit 2; }
command -v sshpass >/dev/null || { echo "sshpass not installed"; exit 2; }

tart clone "$IMAGE" "$VM"
trap 'tart stop "$VM" >/dev/null 2>&1 || true; tart delete "$VM" >/dev/null 2>&1 || true' EXIT
SHARE="$(mktemp -d)"; cp "$DMG" "$SHARE/Homerun.dmg"
# The npx fixture: a local MCP server with a native addon (better-sqlite3), packed to a tarball.
( cd "$(dirname "$0")/../../spikes/mcp-native" && npm pack --silent --pack-destination "$SHARE" >/dev/null && mv "$SHARE"/homerun-spike-mcp-native-*.tgz "$SHARE/mcp-native.tgz" )
tart run --no-graphics --dir="share:$SHARE:ro" "$VM" &
for _ in $(seq 60); do IP="$(tart ip "$VM" 2>/dev/null || true)"; [[ -n "$IP" ]] && break; sleep 2; done
SSH=(sshpass -p admin ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null "admin@$IP")
for _ in $(seq 60); do "${SSH[@]}" true 2>/dev/null && break; sleep 2; done

"${SSH[@]}" bash -s <<'VMEOF' | tee "$OUT/report.txt"
set -uo pipefail
SRC="/Volumes/My Shared Files/share/Homerun.dmg"
cp "$SRC" ~/Downloads/Homerun.dmg
# What a browser download gets: the quarantine flag, which triggers Gatekeeper on first launch.
xattr -w com.apple.quarantine "0083;$(printf %x "$(date +%s)");Safari;$(uuidgen)" ~/Downloads/Homerun.dmg
hdiutil attach -nobrowse -quiet ~/Downloads/Homerun.dmg -mountpoint /tmp/hrdmg
ditto /tmp/hrdmg/Homerun.app /Applications/Homerun.app   # ditto keeps quarantine, like a Finder drag
hdiutil detach -quiet /tmp/hrdmg
echo "## quarantine: $(xattr -p com.apple.quarantine /Applications/Homerun.app 2>&1)"
echo "## no-toolchain:"; for t in node npx python3 uv uvx claude; do printf '  %s -> %s\n' "$t" "$(command -v "$t" || echo none)"; done
echo "## gatekeeper:"; spctl --assess --type execute -vvv /Applications/Homerun.app 2>&1 | sed 's/^/  /'
syspolicy_check distribution /Applications/Homerun.app 2>&1 | sed 's/^/  /' || true
echo "## launch (open, as Finder would), autotest selftest"
cp "/Volumes/My Shared Files/share/mcp-native.tgz" /tmp/mcp-native.tgz
open -a /Applications/Homerun.app --env HOMERUN_SELFTEST_NPX_PKG="/tmp/mcp-native.tgz#homerun-spike-mcp-native" --args --autotest selftest
# The selftest driver exits the app when done; wait for that (or 180 s).
sleep 5
for _ in $(seq 180); do pgrep -f /Applications/Homerun.app/Contents/MacOS/homerun >/dev/null || break; sleep 1; done
echo "## shell.log"; cut -c1-3000 ~/Library/Application\ Support/Homerun/logs/shell.log 2>/dev/null || echo "  (no shell.log: app did not start; see Gatekeeper result above)"
echo "## syspolicyd (last 2 min)"; log show --last 2m --predicate 'process == "syspolicyd"' --style compact 2>/dev/null | grep -i homerun | tail -20
VMEOF
echo "report: $OUT/report.txt"
