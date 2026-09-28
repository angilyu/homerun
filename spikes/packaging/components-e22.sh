#!/usr/bin/env bash
# Design impact entry 22: Node + uv as on-demand components in Application Support.
# Installs the signed node/uv (+ npm) from a built bundle into
#   ~/Library/Application Support/com.angilyu.homerun.spike-e22/components/<name>/<version>/
# the way a first-run download would, verifies each against a pinned manifest
# (sha256 + codesign designated requirement), then launches them as children of the
# hardened-runtime homerund via `homerund mcp-selftest` in three quarantine states:
#   plain       downloaded by the app itself (no com.apple.quarantine xattr)
#   quarantined xattr set as a browser would set it
#   tampered    one byte changed after install (the verifier must refuse it)
#   spikes/packaging/components-e22.sh [Homerun.app]   (default: .spike/f4/H)
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
APP="${1:-$ROOT/.spike/f4/H/Homerun.app}"
M="$APP/Contents/MacOS"
BASE="$HOME/Library/Application Support/com.angilyu.homerun.spike-e22"
OUT="$ROOT/.spike/results/e22"; rm -rf "$OUT" "$BASE"; mkdir -p "$OUT"
NODE_V=$("$M/node" --version | tr -d v); UV_V=$("$M/uv" --version | awk '{print $2}')
run() { perl -e 'alarm shift; exec @ARGV' "$@"; }

install_component() { # state
  local s="$1" C="$BASE/$1/components"
  mkdir -p "$C/node/$NODE_V/bin" "$C/node/$NODE_V/lib" "$C/uv/$UV_V"
  ditto "$M/node" "$C/node/$NODE_V/bin/node"
  ditto "$APP/Contents/Resources/npm" "$C/node/$NODE_V/lib/npm"
  ditto "$M/uv" "$C/uv/$UV_V/uv"
  case $s in
    quarantined) for f in "$C/node/$NODE_V/bin/node" "$C/uv/$UV_V/uv"; do
        xattr -w com.apple.quarantine "0081;$(printf %x "$(date +%s)");Safari;$(uuidgen)" "$f"; done ;;
    # tampered: node gets a byte flipped inside __TEXT (hashed code page); uv in the unhashed tail padding.
    tampered) printf '\xcc' | dd of="$C/node/$NODE_V/bin/node" bs=1 seek=40000 conv=notrunc 2>/dev/null
      printf '\x00' | dd of="$C/uv/$UV_V/uv" bs=1 seek=$(( $(stat -f %z "$C/uv/$UV_V/uv") - 16 )) conv=notrunc 2>/dev/null ;;
  esac
}

# Manifest the app would ship (signed with the updater's ed25519 key; see spike-results entry 22).
manifest() {
  for f in "$M/node" "$M/uv"; do
    printf '%s %s %s\n' "$(basename "$f")" "$(shasum -a 256 "$f" | cut -d' ' -f1)" \
      "$(codesign -dvvv "$f" 2>&1 | sed -n 's/^CDHash=//p')"
  done
}
manifest > "$OUT/manifest.txt"

verify() { # file name → prints ok/FAIL reasons
  local f="$1" n="$2" want_sha want_cd
  read -r _ want_sha want_cd < <(grep "^$n " "$OUT/manifest.txt")
  local sha; sha=$(shasum -a 256 "$f" | cut -d' ' -f1)
  local r=""
  [[ "$sha" == "$want_sha" ]] && r="sha256 ok" || r="sha256 FAIL"
  # With a Developer ID the requirement is: anchor apple generic and certificate leaf[subject.OU] = "<TEAMID>"
  if codesign --verify --strict -R "=cdhash H\"$want_cd\"" "$f" 2>/dev/null; then r="$r; codesign ok"; else r="$r; codesign FAIL ($(codesign --verify --strict "$f" 2>&1 | tail -1))"; fi
  echo "$r"
}

for s in plain quarantined tampered; do
  install_component "$s"
  C="$BASE/$s/components"
  {
    echo "## $s"
    for pair in "node:$C/node/$NODE_V/bin/node" "uv:$C/uv/$UV_V/uv"; do
      n=${pair%%:*}; f=${pair#*:}
      echo "$n xattr: $(xattr -p com.apple.quarantine "$f" 2>/dev/null || echo none)"
      echo "$n verify: $(verify "$f" "$n")"
      echo "$n spctl: $(spctl --assess --type execute -vv "$f" 2>&1 | tr '\n' ' ')"
    done
    D="/private/tmp/hre22$s"; rm -rf "$D"; mkdir -p "$D"
    for r in npx uvx; do
      if [[ $r == npx ]]; then pkg="${HOMERUN_SELFTEST_NPX_PKG:-}"; [[ -z "$pkg" ]] && continue; else pkg="mcp-server-time==2026.8.18"; fi
      tool=$([[ $r == npx ]] && echo sqlite_version || echo get_current_time)
      args=$([[ $r == npx ]] && echo '{}' || echo '{"timezone":"UTC"}')
      res=$(run 120 env -i HOME="$HOME" TMPDIR="$TMPDIR" PATH=/usr/bin:/bin HOMERUN_DATA_DIR="$D" \
        HOMERUN_NODE_PATH="$C/node/$NODE_V/bin/node" HOMERUN_NPM_DIR="$C/node/$NODE_V/lib/npm" HOMERUN_UV_PATH="$C/uv/$UV_V/uv" \
        HOMERUN_NPM_REGISTRY="${HOMERUN_NPM_REGISTRY:-}" HOMERUN_UV_INDEX_URL="${HOMERUN_UV_INDEX_URL:-}" \
        "$M/homerund" mcp-selftest "$r" "$pkg" "$tool" "$args" 2>&1 | tail -1)
      echo "$r via hardened homerund: $(echo "$res" | cut -c1-400)"
    done
    echo "xattr after launch (node): $(xattr -p com.apple.quarantine "$C/node/$NODE_V/bin/node" 2>/dev/null || echo none)"
  } | tee "$OUT/$s.txt"
done
log show --last 5m --style compact --predicate 'process == "syspolicyd" && eventMessage CONTAINS "e22"' 2>/dev/null | tail -20 > "$OUT/syspolicyd.txt"
rm -rf "$BASE" /private/tmp/hre22*
