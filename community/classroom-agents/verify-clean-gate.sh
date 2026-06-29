#!/usr/bin/env bash
# verify-clean gate for classroom downloadable agent bundles.
# Usage: verify-clean-gate.sh <bundle_dir>
# Exit 0 = CLEAN (publishable). Exit 1 = DIRTY (blocked).
# Checks: (A) no bundled connector skills, (B) no our-specific data,
#         (C) no secret-SHAPED values (tokens/keys/chat-ids).
set -uo pipefail
BUNDLE="${1:?usage: verify-clean-gate.sh <bundle_dir>}"
FAIL=0

echo "=== verify-clean gate: $BUNDLE ==="

# (A) Connector skills must NOT be bundled (they arrive via the community MCP).
# Explicit current connector names PLUS a pm-prefix heuristic: every
# property-management platform/portal connector skill in this fleet is named
# pm-* (pm-cli-harness, pm-propertymeld-platform, ...) and is our-specific, so a
# member bundle must never carry one. Fail-closed: any pm-/pm_ skill is blocked
# even if not on the explicit list, so the gate auto-covers future connectors
# without re-enumeration (the anti-staleness derivation). Matching is
# case-insensitive (-iname) and separator-robust (pm- and pm_) so casing/spacing
# variants cannot slip past. Searches the WHOLE bundle, not just .claude/skills,
# so a loose connector dir anywhere is caught. (officecli is a generic doc-gen
# tool, kept.)
echo "--- (A) connector-skill check ---"
EXPLICIT_CONNECTORS="propertymeld agent-browser opencli pm-cli-harness pm-propertymeld-platform"
for c in $EXPLICIT_CONNECTORS; do
  if find "$BUNDLE" -type d -iname "$c" | grep -q .; then
    echo "FAIL: connector skill dir present: $c"
    find "$BUNDLE" -type d -iname "$c"
    FAIL=1
  fi
done
# pm-prefix heuristic: any dir named pm-* or pm_* (case-insensitive)
PM_DIRS=$(find "$BUNDLE" -type d \( -iname "pm-*" -o -iname "pm_*" \) 2>/dev/null)
if [ -n "$PM_DIRS" ]; then
  echo "FAIL: pm- connector skill dir(s) present (PM-platform connectors are not bundled):"
  echo "$PM_DIRS"
  FAIL=1
fi
[ "$FAIL" -eq 0 ] && echo "ok: no connector skill dirs"

# (B) Our-specific data: org names, internal paths, real emails, real names.
# Generic PM-software names (AppFolio, Property Meld as an example) are allowed
# in prose; this list targets OUR identifiers only.
echo "--- (B) our-data check ---"
PATTERNS=(
  'noogalabs' 'ascendops' 'AscendOps' 'dbhconstruction' 'dbh construction'
  '/Users/davidhunter' 'david@' '@noogalabs' 'cortextos/orgs' 'Pase0Pr0p' 'paseo' 'Paseo'
  'chattanooga' 'Chattanooga' 'mhunnicutt'
  '\bcollie\b' '\bcodie\b' '\baussie\b'
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

# (C) Secret-SHAPED values: a real BOT_TOKEN / API key / numeric chat-id leaking
# into a PUBLIC download is the highest-severity leak class. Catch by SHAPE so a
# future bundle is caught automatically, not by manual review. Placeholders
# ({{...}}, <your...>, empty assignments) are allowed.
echo "--- (C) secret-shape check ---"
# Telegram bot token: <8-10 digits>:<35 token chars>
TG=$(grep -rIinE '[0-9]{8,10}:[A-Za-z0-9_-]{35}' "$BUNDLE" 2>/dev/null | grep -vE '\.zip:')
# OpenAI-style key (sk-...) and Google API key (AIza...)
OAI=$(grep -rIinE 'sk-[A-Za-z0-9_-]{20,}' "$BUNDLE" 2>/dev/null | grep -vE '\.zip:')
GK=$(grep -rIinE 'AIza[A-Za-z0-9_-]{35}' "$BUNDLE" 2>/dev/null | grep -vE '\.zip:')
# Numeric telegram chat id / allowed-user: a 6+ digit value (groups may be -prefixed).
# PLACEHOLDER_EXCLUDE deliberately avoids the bare word "example" - it would match
# the ".env.example" FILENAME in grep's path output and silently drop every real
# hit from that file (the file most likely to hold a secret). Exclude by VALUE
# marker only.
PLACEHOLDER_EXCLUDE='\{\{|<your|<YOUR|YOUR_|your-|placeholder|PLACEHOLDER|CHANGEME|changeme'
CHATID=$(grep -rIinE '(CHAT_ID|chat_id|ALLOWED_USER)[[:space:]]*[:=][[:space:]]*["'"'"']?-?[0-9]{6,}' "$BUNDLE" 2>/dev/null \
  | grep -vE '\.zip:' | grep -vE "$PLACEHOLDER_EXCLUDE")
# Non-empty, non-placeholder assignment to a secret-ish key (BOT_TOKEN/
# API_KEY/SECRET/PASSWORD = a real value of 6+ chars).
ASSIGN=$(grep -rIinE '(BOT_TOKEN|API_KEY|[A-Z_]*SECRET[A-Z_]*|[A-Z_]*PASSWORD[A-Z_]*)[[:space:]]*[:=][[:space:]]*["'"'"']?[A-Za-z0-9][A-Za-z0-9:_/-]{5,}' "$BUNDLE" 2>/dev/null \
  | grep -vE '\.zip:' | grep -vE "$PLACEHOLDER_EXCLUDE")
for label in "bot-token:$TG" "openai-key:$OAI" "google-key:$GK" "numeric-chat-id:$CHATID" "secret-assignment:$ASSIGN"; do
  name="${label%%:*}"; val="${label#*:}"
  if [ -n "$val" ]; then
    echo "FAIL: secret-shape ($name):"
    echo "$val" | head -3
    FAIL=1
  fi
done
[ "$FAIL" -eq 0 ] && echo "ok: no secret-shaped values found"

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
