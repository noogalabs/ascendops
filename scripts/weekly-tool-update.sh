#!/usr/bin/env bash
# weekly-tool-update.sh — auto-apply clean tool upgrades, surface anything risky.
#
# Per David spec (2026-05-11):
#   - Clean merge / clean upgrade   = AUTO-APPLY (no surface)
#   - Conflict / version-jump risk  = SURFACE to David with options
#   - Major-version jump            = SURFACE (do not auto-apply across major)
#   - Pinned-skip (caveman, etc.)   = SKIP, log as intentional
#   - Trial-integrity transitive    = SKIP during active trial (RULE locked by David)
#
# Output: logs/weekly-tool-update/YYYY-MM-DD.md
# Cron: existing weekly cron Sun 23:58 UTC — no cron changes; this is the script that runs.
#
# Companion docs:
#   - docs/weekly-tool-update/baseline-2026-05-11.md (initial inventory + spec findings)
#   - docs/onboarding/full-system-audit-2026-05-11.md (full system inventory)
#
# Usage:
#   bash scripts/weekly-tool-update.sh          # full pass, may auto-apply
#   bash scripts/weekly-tool-update.sh --dry    # plan only, no applies
#
# Exit code: 0 always for cron-friendliness. The output file holds the verdict.

set -uo pipefail

# ─── Config ───────────────────────────────────────────────────────────────────

# Pinned tools — never auto-apply. Format: "tool@pinned-rev"
declare -a PINS=(
  "caveman@84cc3c14fa1e"
)

# Active trials — anything upstream of these is on transitive integrity hold.
# Update this list when a trial opens or seals.
# mempalace-rooms-graphify-p4 SEALED as inconclusive 2026-07-06 (David approved):
#   stalled since 2026-05-10, no result artifact (42-node partial graph, no eval/verdict).
#   Restart later as a fresh scoped experiment with success criteria + written verdict.
declare -a ACTIVE_TRIALS=(
)

# Tools transitive-blocked while ACTIVE_TRIALS is non-empty.
declare -a TRIAL_TRANSITIVE_HOLDS=(
  "graphifyy"     # pipx — provides graphify CLI used by P4 trial harness
  "icm"           # brew — present in trial harness MCP wiring
  "mempalace"     # pipx — trial subject itself
)

# Skip-by-default (handled by other crons or out-of-scope)
declare -a SKIP_DEFAULT=(
  "cortextos"     # handled by daily-framework-upstream-auto-update cron
)

# ─── Setup ────────────────────────────────────────────────────────────────────

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TODAY="$(date -u +%Y-%m-%d)"
LOG_DIR="${REPO_ROOT}/logs/weekly-tool-update"
LOG_FILE="${LOG_DIR}/${TODAY}.md"
DRY_RUN=0

for arg in "$@"; do
  case "$arg" in
    --dry|--dry-run) DRY_RUN=1 ;;
    -h|--help)
      grep '^# ' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
  esac
done

mkdir -p "$LOG_DIR"

# ─── Helpers ──────────────────────────────────────────────────────────────────

log() { echo "$*" >> "$LOG_FILE"; }
log_section() { log ""; log "## $*"; log ""; }

now_utc() { date -u +%Y-%m-%dT%H:%M:%SZ; }

in_array() {
  local needle="$1"; shift
  local item
  for item in "$@"; do
    [[ "$item" == "$needle" || "$item" == "${needle}@"* ]] && return 0
  done
  return 1
}

is_pinned() { in_array "$1" "${PINS[@]}"; }
is_trial_held() {
  # Only hold when an active trial is declared. Empty ACTIVE_TRIALS = no holds.
  (( ${#ACTIVE_TRIALS[@]} == 0 )) && return 1
  in_array "$1" "${TRIAL_TRANSITIVE_HOLDS[@]}"
}
is_skip_default() { in_array "$1" "${SKIP_DEFAULT[@]}"; }

# Compare two semver-ish versions. Returns 0 if equal, 1 if v1<v2, 2 if v1>v2.
# Handles X, X.Y, X.Y.Z, with optional v prefix and trailing -alpha/-beta tags.
version_compare() {
  local v1="${1#v}" v2="${2#v}"
  v1="${v1%%-*}" v2="${v2%%-*}"
  if [[ "$v1" == "$v2" ]]; then return 0; fi
  local IFS=.
  local -a a1=($v1) a2=($v2)
  local i max=$((${#a1[@]} > ${#a2[@]} ? ${#a1[@]} : ${#a2[@]}))
  for ((i = 0; i < max; i++)); do
    local n1="${a1[i]:-0}" n2="${a2[i]:-0}"
    if (( 10#$n1 < 10#$n2 )); then return 1; fi
    if (( 10#$n1 > 10#$n2 )); then return 2; fi
  done
  return 0
}

# Classify upgrade severity. Echo: "patch" | "minor" | "major" | "same" | "unknown"
classify_upgrade() {
  local current="${1#v}" upstream="${2#v}"
  current="${current%%-*}" upstream="${upstream%%-*}"
  if [[ "$current" == "$upstream" ]]; then echo "same"; return; fi
  if [[ -z "$current" || -z "$upstream" ]]; then echo "unknown"; return; fi
  local IFS=.
  local -a c=($current) u=($upstream)
  local cmaj="${c[0]:-0}" umaj="${u[0]:-0}"
  local cmin="${c[1]:-0}" umin="${u[1]:-0}"
  if [[ "$cmaj" != "$umaj" ]]; then echo "major"; return; fi
  if [[ "$cmin" != "$umin" ]]; then echo "minor"; return; fi
  echo "patch"
}

# ─── Header ───────────────────────────────────────────────────────────────────

cat > "$LOG_FILE" <<EOF
# Weekly Tool Update — ${TODAY}

**Run:** $(now_utc)
**Mode:** $([ "$DRY_RUN" = 1 ] && echo "DRY-RUN (no applies)" || echo "LIVE (auto-apply clean upgrades)")
**Active trials:** ${ACTIVE_TRIALS[*]:-<none>}
**Pins:** ${PINS[*]:-<none>}

Per David spec: clean upgrades auto-applied. Major-version jumps, pinned tools, and
trial-integrity holds surfaced for review. Output is read on Sun cron firings.

EOF

# ─── Channel: Homebrew ────────────────────────────────────────────────────────

check_brew() {
  log_section "Brew packages"
  if ! command -v brew >/dev/null 2>&1; then
    log "_brew not installed on this host — skipping._"
    return
  fi
  log "| Package | Current | Upstream | Jump | Action |"
  log "|---|---|---|---|---|"

  # `brew outdated --verbose` output: "name (current_a, current_b...) < upstream"
  while IFS= read -r line; do
    [[ -z "$line" ]] && continue
    # parse: "pkg (curr_versions) < upstream"
    local pkg current upstream
    pkg="${line%% *}"
    pkg="${pkg##*/}"  # strip tap prefix like "rtk-ai/tap/icm" -> "icm"
    current="$(echo "$line" | sed -n 's/.*(\(.*\)) <.*/\1/p')"
    upstream="$(echo "$line" | sed -n 's/.* < //p')"
    [[ -z "$current" || -z "$upstream" ]] && { log "| $pkg | _parse-error_ | _parse-error_ | unknown | skip |"; continue; }

    local jump
    jump="$(classify_upgrade "$current" "$upstream")"

    local action
    if is_pinned "$pkg"; then
      action="**PINNED — skip**"
    elif is_trial_held "$pkg"; then
      action="**TRIAL-HOLD — skip until trial seal**"
    elif is_skip_default "$pkg"; then
      action="skip (handled elsewhere)"
    elif [[ "$jump" == "major" ]]; then
      action="**SURFACE — major-version jump, review before apply**"
    elif [[ "$jump" == "patch" || "$jump" == "minor" ]]; then
      if [[ "$DRY_RUN" == "1" ]]; then
        action="would auto-apply ($jump)"
      else
        # Auto-apply
        if brew upgrade "$pkg" >/dev/null 2>&1; then
          action="**AUTO-APPLIED ($jump)**"
        else
          action="**FAILED auto-apply — surface**"
        fi
      fi
    else
      action="**SURFACE — unknown jump classification**"
    fi

    log "| $pkg | $current | $upstream | $jump | $action |"
  done < <(brew outdated --formula --verbose 2>/dev/null)

  log ""
  log "_Tools NOT shown above are at upstream. Cleanly-upgraded tools land silently per spec._"
}

# ─── Channel: pipx ────────────────────────────────────────────────────────────

check_pipx() {
  log_section "pipx packages"
  if ! command -v pipx >/dev/null 2>&1; then
    log "_pipx not installed — skipping._"
    return
  fi
  log "| Package | Current | Upstream (PyPI) | Jump | Action |"
  log "|---|---|---|---|---|"

  # pipx list output includes "   package <name> <version>, installed using Python..."
  while IFS= read -r pkg; do
    [[ -z "$pkg" ]] && continue
    local current upstream jump action
    current="$(pipx list 2>/dev/null | grep -E "^   package ${pkg} " | head -1 | awk '{print $3}' | tr -d ',')"
    [[ -z "$current" ]] && continue
    upstream="$(curl -sf "https://pypi.org/pypi/${pkg}/json" 2>/dev/null | python3 -c "import json,sys; d=json.load(sys.stdin); print(d['info']['version'])" 2>/dev/null || echo "")"
    [[ -z "$upstream" ]] && { log "| $pkg | $current | _unreachable_ | unknown | skip |"; continue; }

    jump="$(classify_upgrade "$current" "$upstream")"
    if [[ "$jump" == "same" ]]; then
      continue  # at upstream, omit from report per spec
    fi

    if is_pinned "$pkg"; then
      action="**PINNED — skip**"
    elif is_trial_held "$pkg"; then
      action="**TRIAL-HOLD — skip until trial seal**"
    elif is_skip_default "$pkg"; then
      action="skip (handled elsewhere)"
    elif [[ "$jump" == "major" ]]; then
      action="**SURFACE — major-version jump, review before apply**"
    elif [[ "$jump" == "patch" || "$jump" == "minor" ]]; then
      if [[ "$DRY_RUN" == "1" ]]; then
        action="would auto-apply ($jump)"
      else
        if pipx upgrade "$pkg" >/dev/null 2>&1; then
          action="**AUTO-APPLIED ($jump)**"
        else
          action="**FAILED auto-apply — surface**"
        fi
      fi
    else
      action="**SURFACE — unknown jump classification**"
    fi

    log "| $pkg | $current | $upstream | $jump | $action |"
  done < <(pipx list 2>/dev/null | grep -E "^   package " | awk '{print $2}' | sort -u)
}

# ─── Channel: npm global ──────────────────────────────────────────────────────

check_npm_global() {
  log_section "npm-global packages"
  if ! command -v npm >/dev/null 2>&1; then
    log "_npm not installed — skipping._"
    return
  fi
  log "| Package | Current | Upstream (npm) | Jump | Action |"
  log "|---|---|---|---|---|"

  # npm outdated -g --json gives precise data
  local outdated_json
  # npm outdated -g --json returns exit 1 when updates ARE available — capture stdout regardless of exit code.
  outdated_json="$(npm outdated -g --json 2>/dev/null)" || true
  [[ -z "$outdated_json" ]] && outdated_json="{}"
  local pkgs
  pkgs="$(echo "$outdated_json" | python3 -c "import json,sys; d=json.load(sys.stdin); print('\n'.join(d.keys()))" 2>/dev/null)"
  [[ -z "$pkgs" ]] && { log "_all npm-global packages at upstream._"; return; }

  while IFS= read -r pkg; do
    [[ -z "$pkg" ]] && continue
    local current upstream jump action
    current="$(echo "$outdated_json" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d['$pkg']['current'])" 2>/dev/null)"
    upstream="$(echo "$outdated_json" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d['$pkg']['latest'])" 2>/dev/null)"
    [[ -z "$current" || -z "$upstream" ]] && { log "| $pkg | _parse-error_ | _parse-error_ | unknown | skip |"; continue; }

    jump="$(classify_upgrade "$current" "$upstream")"

    if is_pinned "$pkg"; then
      action="**PINNED — skip**"
    elif is_trial_held "$pkg"; then
      action="**TRIAL-HOLD — skip until trial seal**"
    elif is_skip_default "$pkg"; then
      action="skip (handled elsewhere)"
    elif [[ "$jump" == "major" ]]; then
      action="**SURFACE — major-version jump, review before apply**"
    elif [[ "$jump" == "patch" || "$jump" == "minor" ]]; then
      if [[ "$DRY_RUN" == "1" ]]; then
        action="would auto-apply ($jump)"
      else
        if npm install -g "${pkg}@${upstream}" >/dev/null 2>&1; then
          action="**AUTO-APPLIED ($jump)**"
        else
          action="**FAILED auto-apply — surface**"
        fi
      fi
    else
      action="**SURFACE — unknown jump classification**"
    fi

    log "| $pkg | $current | $upstream | $jump | $action |"
  done <<< "$pkgs"
}

# ─── Run ──────────────────────────────────────────────────────────────────────

check_brew
check_pipx
check_npm_global

# ─── Summary footer ───────────────────────────────────────────────────────────

log_section "Notes"
log "- Trial-integrity rule (David LOCKED 2026-05-11): tools upstream of an active trial stay on hold even on patch-clean upgrades, until the trial seals."
log "- Caveman is pinned at \`84cc3c14fa1e\` per the David pin rule. Update by editing the PIN list in this script."
log "- Major-version jumps NEVER auto-apply. Review the changelog + sandbox-test before merging."
log "- Full system inventory: \`docs/onboarding/full-system-audit-2026-05-11.md\`."
log "- Baseline reference: \`docs/weekly-tool-update/baseline-2026-05-11.md\`."

# Stamp and exit clean
log ""
log "_Completed: $(now_utc)_"
exit 0
