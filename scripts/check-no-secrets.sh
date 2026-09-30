#!/usr/bin/env bash
# Fails if the repository holds anything shaped like an Anthropic API key other than the known
# dummy keys, a minisign/Tauri updater secret key (§11: it lives outside the repo), a PEM private
# key or key file (the relay's APNs .p8, §9.7), wrangler's local secrets (.dev.vars), or if a
# replay cassette holds credential headers or machine-specific paths.
# Scans every tracked or committable file, or the files given as arguments.
# Never prints a matched value: only file and line.
set -uo pipefail
cd "$(git rev-parse --show-toplevel)"

ALLOWED='^sk-ant-(mock-not-a-real-key|mock-not-a-key|replay-not-a-key|TEST-not-a-real-key)$'
if [ "$#" -gt 0 ]; then
  files=("$@")
else
  files=()
  while IFS= read -r -d '' f; do [ -f "$f" ] && files+=("$f"); done < <(git ls-files -z --cached --others --exclude-standard)
fi

status=0
while IFS= read -r hit; do
  [ -z "$hit" ] && continue
  loc=${hit%:*}
  value=${hit##*:}
  if ! [[ $value =~ $ALLOWED ]]; then
    echo "error: something shaped like an API key at $loc" >&2
    status=1
  fi
done < <(grep -I -o -n -H -E 'sk-ant-[A-Za-z0-9_-]{8,}' -- "${files[@]}" 2>/dev/null)

# The updater's secret key, as written by `tauri signer generate` (base64) or minisign (plain).
# Built at run time so this script doesn't match itself.
kinds='(rsign|minisign)'
plain="untrusted comment: $kinds encrypted secret key"
b64="$(printf 'untrusted comment: %s encrypted secret key' rsign | base64)|$(printf 'untrusted comment: %s encrypted secret key' minisign | base64 | cut -c1-52)"
while IFS= read -r loc; do
  [ -z "$loc" ] && continue
  echo "error: an updater signing key at $loc" >&2
  status=1
done < <(grep -I -o -n -H -E "$plain|$b64" -- "${files[@]}" 2>/dev/null | cut -d: -f1,2)

# A PEM private key of any kind (the APNs .p8 is a PKCS #8 "PRIVATE KEY"). Tests generate
# theirs at run time. Built at run time so this script doesn't match itself.
pem="-----BEGIN ([A-Z]+ )?$(printf 'PRIVATE %s' KEY)-----"
while IFS= read -r loc; do
  [ -z "$loc" ] && continue
  echo "error: a PEM private key at $loc" >&2
  status=1
done < <(grep -I -o -n -H -E -e "$pem" -- "${files[@]}" 2>/dev/null | cut -d: -f1,2)

for f in "${files[@]}"; do
  case "$f" in
    *.key | *.p8 | *.pem | *.p12)
      echo "error: $f looks like a key file" >&2
      status=1
      ;;
    .dev.vars* | */.dev.vars*)
      echo "error: $f holds wrangler's local secrets" >&2
      status=1
      ;;
  esac
  case "$f" in
    */test/replay/cassettes/*.json | */cassettes/*.json)
      if grep -q -i -E '"(x-api-key|authorization)"[[:space:]]*:' -- "$f"; then
        echo "error: $f holds a credential header" >&2
        status=1
      fi
      lines=$(grep -n -E '/Users/|/home/|/var/folders/|/private/var/|/tmp/' -- "$f" | cut -d: -f1 | tr '\n' ' ')
      if [ -n "$lines" ]; then
        echo "error: $f holds a machine-specific path (lines $lines)" >&2
        status=1
      fi
      ;;
  esac
done

[ $status -eq 0 ] && echo "no secrets found (${#files[@]} files)"
exit $status
