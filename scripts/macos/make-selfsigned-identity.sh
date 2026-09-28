#!/usr/bin/env bash
# Create a *self-signed* code-signing identity in a private, throwaway keychain.
# This is NOT a Developer ID: Gatekeeper and notarization reject it. It exists so the
# spike can test behaviour that depends on a *stable, non-ad-hoc designated requirement*
# (keychain ACLs across an update, §16.1 item 8) without the user's Apple account.
# Nothing is added to the login keychain or the user's trust settings.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
DIR="$ROOT/.spike/signing"
KC="$DIR/homerun-spike.keychain-db"
NAME="${1:-Homerun Spike Self-Signed}"
mkdir -p "$DIR" && chmod 700 "$DIR"
if [[ -f "$KC" ]]; then echo "exists: $KC"; exit 0; fi
PW="$(openssl rand -hex 16)"; echo "$PW" > "$DIR/keychain-password"; chmod 600 "$DIR/keychain-password"
cat > "$DIR/cert.cnf" <<CNF
[req]
distinguished_name = dn
x509_extensions = ext
prompt = no
[dn]
CN = $NAME
OU = HOMERUNSPK
[ext]
basicConstraints = critical,CA:false
keyUsage = critical,digitalSignature
extendedKeyUsage = critical,codeSigning
CNF
openssl req -x509 -newkey rsa:2048 -nodes -days 30 -keyout "$DIR/key.pem" -out "$DIR/cert.pem" -config "$DIR/cert.cnf" 2>/dev/null
P12PW="$(openssl rand -hex 8)"
openssl pkcs12 -export -legacy -inkey "$DIR/key.pem" -in "$DIR/cert.pem" -out "$DIR/id.p12" -passout "pass:$P12PW" 2>/dev/null \
  || openssl pkcs12 -export -inkey "$DIR/key.pem" -in "$DIR/cert.pem" -out "$DIR/id.p12" -passout "pass:$P12PW"
security create-keychain -p "$PW" "$KC"
security set-keychain-settings "$KC"            # no auto-lock timeout
security unlock-keychain -p "$PW" "$KC"
security import "$DIR/id.p12" -k "$KC" -P "$P12PW" -T /usr/bin/codesign >/dev/null
security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "$PW" "$KC" >/dev/null
rm -f "$DIR/key.pem" "$DIR/id.p12"
echo "created $KC with identity '$NAME'"
security find-identity -p codesigning "$KC"
