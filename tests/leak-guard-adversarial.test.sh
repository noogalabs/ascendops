#!/usr/bin/env bash
# Additional adversarial coverage for provider credentials and gate-file bypasses.
set -uo pipefail
cd "$(dirname "$0")/.."

GUARD="$PWD/.github/scripts/leak-guard.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
failures=0

expect_block() {
  local label="$1" marker="$2" file="$3" output
  if output="$(bash "$GUARD" "$file" 2>&1)"; then
    echo "FAIL: $label passed but must be blocked"
    failures=$((failures + 1))
    return
  fi
  if ! grep -q "$marker" <<<"$output"; then
    echo "FAIL: $label did not report $marker"
    failures=$((failures + 1))
    return
  fi
  echo "BLOCKED: $label -> $marker"
}

printf '%s%s%s\n' 'AWS_SECRET_ACCESS_' 'KEY=' 'wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLEKEY' > "$TMP/aws.txt"
expect_block "AWS secret access key" "AWS secret access key" "$TMP/aws.txt"

printf '%s%s%s%s\n' 'OPENAI_API_' 'KEY=' 'sk-proj-' 'aB3dE5fG7hJ9kL1mN3pQ5rS7tU9vW1xY3zA5bC7dE9fG' > "$TMP/openai.txt"
expect_block "OpenAI project key" "OpenAI or Anthropic API token" "$TMP/openai.txt"

printf '%s%s%s%s\n' 'ANTHROPIC_API_' 'KEY=' 'sk-ant-api03-' 'aB3dE5fG7hJ9kL1mN3pQ5rS7tU9vW1xY3zA5' > "$TMP/anthropic.txt"
expect_block "Anthropic API key" "OpenAI or Anthropic API token" "$TMP/anthropic.txt"

printf '%s%s%s%s\n' 'GEMINI_API_' 'KEY=' 'AIza' 'SyA1bC3dE5fG7hJ9kL1mN3pQ5rS7tU9vW1x' > "$TMP/gemini.txt"
expect_block "Gemini API key" "Google API key" "$TMP/gemini.txt"

printf '%s%s%s\n' 'SERVICE_ACCESS_' 'TOKEN=' 'aB3dE5fG7hJ9kL1mN3pQ5rS7' > "$TMP/env.txt"
expect_block "unquoted uppercase credential" "environment credential assignment" "$TMP/env.txt"

# Configured human-data patterns must remain fail-closed. Values are assembled
# so this regression file itself does not contain the planted PII contiguously.
printf 'email: %s@%s.%s\n' 'private.person' 'customer' 'invalid' > "$TMP/email.txt"
expect_block "email address" "email address" "$TMP/email.txt"

printf 'address: %s %s %s\n' '742' 'Private' 'Lane' > "$TMP/address.txt"
expect_block "street address" "street address" "$TMP/address.txt"

printf 'contact_name=%s %s\n' 'Private' 'Person' > "$TMP/contact-name.txt"
expect_block "person name in contact field" "person name in a contact field" "$TMP/contact-name.txt"

# NANP 555-0100 through 555-0199 is the only synthetic fixture range accepted.
printf 'phone: 212-555-%s\n' '0100' > "$TMP/phone-lower-bound.txt"
if ! bash "$GUARD" "$TMP/phone-lower-bound.txt" > /dev/null 2>&1; then
  echo "FAIL: reserved phone lower bound was blocked"
  failures=$((failures + 1))
fi
printf 'phone: 212-555-%s\n' '0199' > "$TMP/phone-upper-bound.txt"
if ! bash "$GUARD" "$TMP/phone-upper-bound.txt" > /dev/null 2>&1; then
  echo "FAIL: reserved phone upper bound was blocked"
  failures=$((failures + 1))
fi
printf 'phone: 212-555-%s\n' '0200' > "$TMP/phone-outside-range.txt"
expect_block "phone outside reserved fixture range" "US phone number outside reserved 555-01XX fixture range" "$TMP/phone-outside-range.txt"

agent_name='da''ne'
memory_path="$TMP/orgs/acme/agents/$agent_name/MEMORY.md"
mkdir -p "$(dirname "$memory_path")"
printf 'clean\n' > "$memory_path"
expect_block "tracked agent memory" "private runtime path is tracked" "$memory_path"

# Windowed roster/cadence detection uses split synthetic construction so the
# public regression never publishes a contiguous fleet identity.
roster_name='da''ne'

cat > "$TMP/window-near.md" <<EOF
| Agent | Role |
| $roster_name | orchestrator |
| Notes | primary |
| Cadence | morning-review(0 13 * * *) |
EOF
expect_block "roster and parenthesized cadence within 3 lines" "agent roster and cron schedule within 3 lines" "$TMP/window-near.md"

cat > "$TMP/window-far.md" <<EOF
| Agent | Role |
| $roster_name | orchestrator |
| Notes | one |
| Notes | two |
| Notes | three |
| Notes | four |
| Cadence | 0 13 * * 1 |
EOF
if ! bash "$GUARD" "$TMP/window-far.md" > /dev/null 2>&1; then
  echo "FAIL: roster and cadence more than 3 lines apart was blocked"
  failures=$((failures + 1))
fi

cat > "$TMP/window-prose.md" <<EOF
Authored: $roster_name
This section explains how morning-review works.
EOF
if ! bash "$GUARD" "$TMP/window-prose.md" > /dev/null 2>&1; then
  echo "FAIL: prose adjacency was blocked"
  failures=$((failures + 1))
fi

cat > "$TMP/window-bare.md" <<EOF
| Agent | Role |
|$roster_name|orchestrator|
| Cadence | 0 13 * * 1 |
EOF
expect_block "roster and bare cadence within 3 lines" "agent roster and cron schedule within 3 lines" "$TMP/window-bare.md"

cat > "$TMP/window-skill-only.md" <<EOF
| Agent | Role |
| $roster_name | orchestrator |
| Skill | morning-review |
EOF
if ! bash "$GUARD" "$TMP/window-skill-only.md" > /dev/null 2>&1; then
  echo "FAIL: skill-name-only table was blocked"
  failures=$((failures + 1))
fi

# Substrings and hyphenated compounds of fleet names are whole non-matching
# tokens, never roster hits — pins the tokenizer against splitting drift.
cat > "$TMP/window-substrings.md" <<EOF
| Component | Blueprint |
| Strategy | blue-green |
| Operator | mundane cashier nickname |
| Cadence | 0 2 * * 1 |
EOF
if ! bash "$GUARD" "$TMP/window-substrings.md" > /dev/null 2>&1; then
  echo "FAIL: non-roster substrings near cadence were blocked"
  failures=$((failures + 1))
fi

# Guard machinery is never exempt from secret detection.
mkdir -p "$TMP/no-bypass/.github/scripts" "$TMP/no-bypass/.github/workflows" "$TMP/no-bypass/tests"
for path in \
  .github/scripts/leak-guard.sh \
  .github/workflows/leak-guard.yml \
  tests/leak-guard.test.sh
do
  printf 'token=%s%s\n' 'ghp_' 'abcdefghijklmnopqrstuvwxyz1234567890ABCD' > "$TMP/no-bypass/$path"
  expect_block "gate-file bypass $path" "GitHub token" "$TMP/no-bypass/$path"
done

if [[ "$failures" -ne 0 ]]; then
  echo "leak-guard-adversarial.test: FAIL ($failures failure(s))"
  exit 1
fi
echo "leak-guard-adversarial.test: PASS"
