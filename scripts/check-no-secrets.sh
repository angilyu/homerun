#!/usr/bin/env bash
# Fails if the repository holds anything shaped like an Anthropic API key other than the known
# dummy keys, or if a replay cassette holds credential headers or machine-specific paths.
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

for f in "${files[@]}"; do
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
