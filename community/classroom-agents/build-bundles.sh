#!/usr/bin/env bash
# build-bundles.sh, regenerate the classroom downloadable agent zips FROM SOURCE.
#
# Source of truth = the bundle dirs in this folder. The zips in dist/ are build
# artifacts (gitignored) and are always reproducible from source by this script.
#
# GATE-GATED: each bundle is run through verify-clean-gate.sh BEFORE it is zipped.
# A bundle that fails the gate (bundled connector skill, our-specific data) is
# BLOCKED and no zip is produced for it. This is the recurrence-preventer: a leak
# can never reach a published zip without first failing this gate.
#
# Usage: ./build-bundles.sh    (produces dist/<bundle>.zip for every clean bundle)
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GATE="$HERE/verify-clean-gate.sh"
DIST="$HERE/dist"
mkdir -p "$DIST"

BUNDLES=(
  accounting-agent-template
  leasing-coordinator-agent-template
  maintenance-coordinator-agent-template
)

fail=0
for b in "${BUNDLES[@]}"; do
  src="$HERE/$b"
  if [ ! -d "$src" ]; then
    echo "MISSING source dir: $b"
    fail=1
    continue
  fi
  if bash "$GATE" "$src" >"/tmp/gate_${b}.txt" 2>&1; then
    rm -f "$DIST/$b.zip"
    ( cd "$HERE" && zip -rq "$DIST/$b.zip" "$b" -x "*.DS_Store" )
    echo "OK       $b -> dist/$b.zip (verify-clean gate: CLEAN)"
  else
    echo "BLOCKED  $b: verify-clean gate FAILED (see /tmp/gate_${b}.txt) - NO zip produced"
    fail=1
  fi
done

if [ "$fail" -eq 0 ]; then
  echo "All bundles clean and zipped to dist/."
else
  echo "One or more bundles were blocked. Fix the source and re-run." >&2
fi
exit "$fail"
