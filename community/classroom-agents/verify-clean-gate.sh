#!/usr/bin/env bash
# verify-clean gate for classroom downloadable agent bundles.
# Usage: verify_clean_gate.sh <bundle_dir>
# Exit 0 = CLEAN (publishable). Exit 1 = DIRTY (blocked).
# Checks: (A) no bundled connector skills, (B) no our-specific data/names/paths.
set -uo pipefail
BUNDLE="${1:?usage: verify_clean_gate.sh <bundle_dir>}"
FAIL=0

echo "=== verify-clean gate: $BUNDLE ==="

# (A) Connector skills must NOT be bundled (they arrive via the community MCP).
echo "--- (A) connector-skill check ---"
for c in propertymeld agent-browser opencli; do
  if find "$BUNDLE" -type d -name "$c" | grep -q .; then
    echo "FAIL: connector skill dir present: $c"
    find "$BUNDLE" -type d -name "$c"
    FAIL=1
  fi
done
[ "$FAIL" -eq 0 ] && echo "ok: no connector skill dirs"

# (B) Our-specific data: org names, internal paths, real emails, real agent/person names.
# NOTE: generic PM-software names (AppFolio, Property Meld as an example system) are allowed
# in prose; this list targets OUR identifiers only.
echo "--- (B) our-data check ---"
PATTERNS=(
  'noogalabs' 'ascendops' 'AscendOps' 'dbhconstruction' 'dbh construction'
  '/Users/davidhunter' 'david@' '@noogalabs' 'cortextos/orgs' 'Pase0Pr0p' 'paseo' 'Paseo'
  'chattanooga' 'Chattanooga' 'mhunnicutt'
  # real fleet agent names (standalone identity leaks)
  '\bcollie\b' '\bcodie\b' '\baussie\b'
  # real people from our ops
  'Brittany Hunter' 'dbhconstructionllc'
)
for p in "${PATTERNS[@]}"; do
  HITS=$(grep -rIinE "$p" "$BUNDLE" 2>/dev/null | grep -vE '\.zip:')
  if [ -n "$HITS" ]; then
    echo "FAIL: our-data pattern '$p':"
    echo "$HITS" | head -5
    FAIL=1
  fi
done
[ "$FAIL" -eq 0 ] && echo "ok: no our-specific data found"

echo "--- placeholder convention spot-check (informational) ---"
grep -rIl "{{agent_name}}" "$BUNDLE" >/dev/null 2>&1 && echo "ok: {{placeholders}} present (generic by templating)" || echo "WARN: no {{agent_name}} placeholders found - confirm bundle is genericized"

echo "==============================================="
if [ "$FAIL" -eq 0 ]; then
  echo "RESULT: CLEAN ✅  ($BUNDLE)"
  exit 0
else
  echo "RESULT: DIRTY ❌  ($BUNDLE) - DO NOT PUBLISH"
  exit 1
fi
