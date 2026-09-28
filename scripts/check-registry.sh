#!/usr/bin/env bash
# Fails unless packages resolve from the public npm registry: the repo-root .npmrc must set
# registry=https://registry.npmjs.org/ (overriding any user-level registry, e.g. a work feed),
# and pnpm-lock.yaml must not name any other registry host, such as a pkgs.visualstudio.com or
# pkgs.dev.azure.com feed. With the default registry pnpm omits tarball URLs, so any URL in
# the lockfile must be on registry.npmjs.org.
# Usage: check-registry.sh [lockfile [npmrc]]  (defaults: the repo's pnpm-lock.yaml and .npmrc)
set -uo pipefail
cd "$(git rev-parse --show-toplevel)"

LOCK=${1:-pnpm-lock.yaml}
NPMRC=${2:-.npmrc}
NPMJS='registry.npmjs.org'
status=0

if [ ! -f "$NPMRC" ]; then
  echo "error: $NPMRC is missing; it must set registry=https://$NPMJS/" >&2
  status=1
else
  if ! grep -q -x -E "registry[[:space:]]*=[[:space:]]*https://$NPMJS/?" -- "$NPMRC"; then
    echo "error: $NPMRC must set registry=https://$NPMJS/" >&2
    status=1
  fi
  while IFS= read -r hit; do
    [ -z "$hit" ] && continue
    echo "error: $NPMRC:${hit%%:*} points a registry somewhere other than $NPMJS" >&2
    status=1
  done < <(grep -n -E '^[^#;]*registry[[:space:]]*=' -- "$NPMRC" | grep -v -E "=[[:space:]]*https://$NPMJS/?$")
fi

if [ ! -f "$LOCK" ]; then
  echo "error: $LOCK is missing" >&2
  status=1
else
  while IFS= read -r hit; do
    [ -z "$hit" ] && continue
    echo "error: $LOCK:${hit%%:*} names a private package feed (${hit#*:})" >&2
    status=1
  done < <(grep -n -o -i -E '[a-z0-9.-]*(pkgs\.visualstudio\.com|pkgs\.dev\.azure\.com|packagefeedproxy[a-z0-9.-]*)' -- "$LOCK")
  while IFS= read -r hit; do
    [ -z "$hit" ] && continue
    host=${hit#*://}
    [ "$host" = "$NPMJS" ] && continue
    echo "error: $LOCK:${hit%%:*} resolves from $host, not $NPMJS" >&2
    status=1
  done < <(grep -n -o -E 'https?://[^/[:space:],}]+' -- "$LOCK")
fi

[ $status -eq 0 ] && echo "packages resolve from $NPMJS only"
exit $status
