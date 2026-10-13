#!/usr/bin/env bash
# Publishes the GitHub release from the release workflow's assets (design §11, §18 rows 132, 134).
#
#   scripts/release/publish.sh path/to/assets
#
# The assets directory holds the installers, any updater payloads with their .sig files, and the
# latest.json that latest-json.ts merged, if there is one. This script adds SHA256SUMS, writes the
# notes and creates the release.
#
# Env:
#   VERSION                  the release's version, X.Y.Z (the tag is vX.Y.Z)
#   DRAFT                    true: a draft (workflow_dispatch) | false: published (a pushed tag)
#   MAC_SIGNED, WIN_SIGNED   true | false: each platform's code signing, from signing-status.sh
#   GITHUB_SHA, GH_TOKEN, GH_REPO   as in a workflow (gh's own variables)
#   DRY_RUN=1                print the title, flags and notes instead of creating the release
#
# A release is a full release only when its latest.json offers at least one platform. Otherwise
# it is a pre-release, which GitHub never serves as releases/latest, so an installed app is never
# offered it: "vX.Y.Z (unsigned preview)" when nothing is code-signed, "vX.Y.Z (preview, no
# updates)" when something is. A version with a pre-release suffix (1.0.0-rc.1) is always a
# pre-release.
set -euo pipefail
DIR="$(cd "${1:?usage: publish.sh path/to/assets}" && pwd)"
: "${VERSION:?}" "${DRAFT:?}" "${MAC_SIGNED:?}" "${WIN_SIGNED:?}"
TAG="v$VERSION"
REPO_URL="https://github.com/${GH_REPO:-angilyu/homerun}"

offered=""
if [[ -f "$DIR/latest.json" ]]; then
  offered="$(jq -r '.platforms | keys | join(" ")' "$DIR/latest.json")"
fi
if [[ -n "$offered" ]]; then
  title="$TAG"; prerelease=false
elif [[ "$MAC_SIGNED" != true && "$WIN_SIGNED" != true ]]; then
  title="$TAG (unsigned preview)"; prerelease=true
else
  title="$TAG (preview, no updates)"; prerelease=true
fi
if [[ "$VERSION" == *-* ]]; then prerelease=true; fi

rm -f "$DIR/SHA256SUMS"
sums="$(cd "$DIR" && shasum -a 256 -- *)"
printf '%s\n' "$sums" > "$DIR/SHA256SUMS"

shopt -s nullglob
mac=("$DIR/Homerun_${VERSION}_aarch64"*.dmg)
win=("$DIR/Homerun_${VERSION}_x64"*-setup.exe)
mac_file=""; win_file=""
if (( ${#mac[@]} )); then mac_file="$(basename "${mac[0]}")"; fi
if (( ${#win[@]} )); then win_file="$(basename "${win[0]}")"; fi
signing() { [[ "$1" == true ]] && echo "$2" || echo "**unsigned**"; }
updates() { [[ " $offered " == *" $1 "* ]] && echo yes || echo no; }

notes="$(mktemp)"
{
  echo "## Downloads"
  echo
  echo "| Platform | File | Signing | Offered as an update |"
  echo "| --- | --- | --- | --- |"
  if [[ -n "$mac_file" ]]; then echo "| macOS 13+ (Apple silicon) | \`$mac_file\` | $(signing "$MAC_SIGNED" "Developer ID, notarized") | $(updates darwin-aarch64) |"; fi
  if [[ -n "$win_file" ]]; then echo "| Windows 10/11 (x64) | \`$win_file\` | $(signing "$WIN_SIGNED" "Authenticode") | $(updates windows-x86_64) |"; fi
  echo
  echo "Check a download against \`SHA256SUMS\`: \`shasum -a 256 -c SHA256SUMS --ignore-missing\` (macOS) or \`Get-FileHash\` (Windows)."
  if [[ "$MAC_SIGNED" != true || "$WIN_SIGNED" != true ]]; then
    echo
    echo "### Opening an unsigned build"
    echo
    echo "An unsigned build is a preview. It never updates itself: install the next release by hand."
    if [[ -n "$mac_file" && "$MAC_SIGNED" != true ]]; then
      echo
      echo "**macOS.** The app is signed ad hoc and not notarized, so Gatekeeper blocks it. Drag Homerun to Applications and try to open it once. Then open System Settings → Privacy & Security and choose **Open Anyway** (on macOS 13 and 14 you can instead Control-click the app and choose **Open**). Or, in Terminal: \`xattr -dr com.apple.quarantine /Applications/Homerun.app\`."
    fi
    if [[ -n "$win_file" && "$WIN_SIGNED" != true ]]; then
      echo
      echo "**Windows.** SmartScreen says \"Windows protected your PC\". Choose **More info**, then **Run anyway**. The installer installs for you alone and doesn't ask for administrator rights."
    fi
  fi
  if [[ -z "$offered" && ( "$MAC_SIGNED" == true || "$WIN_SIGNED" == true ) ]]; then
    echo
    echo "This release has no \`latest.json\`, so installed copies aren't offered it. It needs the updater key (apps/desktop/README.md, Releasing)."
  fi
  echo
  echo "Changes: $REPO_URL/commits/$TAG"
} > "$notes"

flags=(--title "$title" --notes-file "$notes")
if [[ "$prerelease" == true ]]; then flags+=(--prerelease); fi
if [[ "$DRAFT" == true ]]; then
  flags+=(--draft --target "${GITHUB_SHA:?}")
else
  flags+=(--verify-tag)
fi

if [[ "${DRY_RUN:-0}" == 1 ]]; then
  echo "gh release create $TAG ${flags[*]}"
  ls -1 "$DIR"
  cat "$notes"
else
  gh release create "$TAG" "${flags[@]}" "$DIR"/*
fi
rm -f "$notes"
