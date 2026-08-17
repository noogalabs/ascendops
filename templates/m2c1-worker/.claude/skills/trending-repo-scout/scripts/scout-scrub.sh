#!/usr/bin/env bash
set -euo pipefail

fallback_keys=(
  BOT_TOKEN
  CHAT_ID
  CTX_TELEGRAM_CHAT_ID
  ACTIVITY_CHAT_ID
  GEMINI_API_KEY
  DATABASE_URL
  TELNYX_API_KEY
  RELAY_INTERNAL_TOKEN
  RELAY_URL
  MONDAY_API_KEY
  OPENAI_API_KEY
  ANTHROPIC_API_KEY
)

secrets_file=""
if [ -n "${CTX_PROJECT_ROOT:-}" ] && [ -n "${CTX_ORG:-}" ]; then
  candidate="${CTX_PROJECT_ROOT}/orgs/${CTX_ORG}/secrets.env"
  if [ -f "$candidate" ]; then
    secrets_file="$candidate"
  fi
fi
if [ -z "$secrets_file" ]; then
  script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  probe="$script_dir"
  while [ "$probe" != "/" ]; do
    if [ -f "$probe/orgs/${CTX_ORG:-ascendops}/secrets.env" ]; then
      secrets_file="$probe/orgs/${CTX_ORG:-ascendops}/secrets.env"
      break
    fi
    probe="$(dirname "$probe")"
  done
fi
if [ -n "${SCOUT_SECRETS_ENV:-}" ] && [ -f "$SCOUT_SECRETS_ENV" ]; then
  secrets_file="$SCOUT_SECRETS_ENV"
fi

keys_tmp="$(mktemp)"
trap 'rm -f "$keys_tmp"' EXIT
printf '%s\n' "${fallback_keys[@]}" > "$keys_tmp"
if [ -n "$secrets_file" ] && [ -r "$secrets_file" ]; then
  grep -oE '^[A-Z_][A-Z0-9_]*=' "$secrets_file" | sed 's/=$//' >> "$keys_tmp" || true
fi

unset_args=()
while IFS= read -r key; do
  case "$key" in
    ""|CLAUDE_CODE_OAUTH_TOKEN)
      continue
      ;;
  esac
  unset_args+=("-u" "$key")
done < <(sort -u "$keys_tmp")

exec env "${unset_args[@]}" "$@"
