#!/usr/bin/env bash
# §16.1 item 6 / §11: which hardened-runtime entitlements does each helper actually need?
# Signs a *copy* of each staged helper ad-hoc with --options runtime and every candidate
# entitlement set, then runs a smoke test that exercises JIT / FFI / native add-ons.
# Output: .spike/results/entitlement-matrix.tsv
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
BIN="$ROOT/apps/desktop/src-tauri/binaries"
CAND="$ROOT/scripts/macos/entitlements/candidates"
W="$ROOT/.spike/entmatrix"; OUT="$ROOT/.spike/results/entitlement-matrix.tsv"
rm -rf "$W"; mkdir -p "$W" "$(dirname "$OUT")"
NATIVE="$(ls -d "${NATIVE_MODULES:-/tmp/hr-mcp/toolchains/npm-cache/_npx}"/*/node_modules 2>/dev/null | head -1)"

smoke() { # name exe
  case $1 in
    homerund) HOMERUN_DATA_DIR="$W/data" "$2" keychain-selftest --data-protection --account entmatrix >/dev/null 2>&1 \
                && "$2" version >/dev/null 2>&1 ;;
    claude)   env -i HOME="$W/h" PATH=/usr/bin:/bin CLAUDE_CONFIG_DIR="$W/c" "$2" mcp list >/dev/null 2>&1 ;;
    uv)       "$2" --version >/dev/null 2>&1 ;;
    node)     "$2" -e 'let s=0;for(let i=0;i<5e7;i++)s+=i;new WebAssembly.Module(new Uint8Array([0,97,115,109,1,0,0,0]))' >/dev/null 2>&1 \
                && ( [[ -z "$NATIVE" ]] || NODE_PATH="$NATIVE" "$2" -e 'const D=require("better-sqlite3");new D(":memory:").prepare("select 1").get()' >/dev/null 2>&1 ) ;;
  esac
}

printf "binary\tentitlements\tresult\texit\n" > "$OUT"
for name in homerund claude node uv; do
  for ent in none jit uem jit-uem dlv jit-dlv jit-uem-dlv; do
    exe="$W/$name-$ent/$name"; mkdir -p "$(dirname "$exe")"; cp "$BIN/$name-aarch64-apple-darwin" "$exe"
    codesign --force -s - --options runtime --timestamp=none --identifier "dev.homerun.$name" \
      --entitlements "$CAND/$ent.plist" "$exe" 2>/dev/null
    smoke $name "$exe"; rc=$?
    [[ $rc -eq 0 ]] && r=ok || r=FAIL
    printf "%s\t%s\t%s\t%s\n" $name $ent $r $rc | tee -a "$OUT"
  done
  # Baseline: the vendor's own signature, untouched.
  cp "$BIN/$name-aarch64-apple-darwin" "$W/$name-vendor"; smoke $name "$W/$name-vendor"; rc=$?
  printf "%s\t%s\t%s\t%s\n" $name vendor-signature $([[ $rc -eq 0 ]] && echo ok || echo FAIL) $rc | tee -a "$OUT"
done
echo "native add-on dir: ${NATIVE:-none}" >> "$OUT"
