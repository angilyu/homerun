#!/usr/bin/env bash
# Evidence for §16.1 item 6: per-binary signature + entitlements, strict deep verify,
# Gatekeeper assessment, stapled ticket. Prints a report; exit code = strict-verify result.
set -uo pipefail
APP="${1:?usage: verify.sh path/to/Homerun.app}"
echo "## codesign --verify --deep --strict"
codesign --verify --deep --strict --verbose=2 "$APP" 2>&1; VRC=$?
echo "rc=$VRC"
for f in "$APP"/Contents/MacOS/*; do
  echo "## $(basename "$f")"
  codesign -dvv "$f" 2>&1 | grep -E '^(Identifier|Authority|TeamIdentifier|Signature|Timestamp)=|flags=' | sed 's/^/  /'
  echo "  entitlements: $(codesign -d --entitlements - --xml "$f" 2>/dev/null | plutil -convert json -o - - 2>/dev/null || echo '{}')"
done
echo "## spctl (Gatekeeper, execute)"
spctl --assess --type execute -vvv "$APP" 2>&1; echo "rc=$?"
echo "## stapler"
xcrun stapler validate "$APP" 2>&1 | tail -1
exit $VRC
