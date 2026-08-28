#!/bin/bash
# Safely report or remove inactive agent worktrees. Default: dry-run.
#
# Destructive mode is deliberately marker-blind. A long-lived supervisor must
# acquire the daemon's repository lease and export the three lease values below
# for the entire invocation. This script neither reads nor mutates lease state.

set -uo pipefail

DELETE=0 OWNER="" INSTANCE="${CTX_INSTANCE_ID:-default}"
while [ "$#" -gt 0 ]; do
  case "$1" in
    --delete) DELETE=1; shift ;;
    --owner)
      [ "$#" -ge 2 ] && [ -n "$2" ] && [ "${2#-}" = "$2" ] || {
        echo "reap-agent-worktrees.sh: --owner requires an agent name" >&2; exit 2;
      }
      OWNER="$2"; shift 2 ;;
    --owner=*) OWNER="${1#--owner=}"; [ -n "$OWNER" ] || exit 2; shift ;;
    --instance)
      [ "$#" -ge 2 ] && [ -n "$2" ] && [ "${2#-}" = "$2" ] || {
        echo "reap-agent-worktrees.sh: --instance requires an ID" >&2; exit 2;
      }
      INSTANCE="$2"; shift 2 ;;
    --instance=*) INSTANCE="${1#--instance=}"; [ -n "$INSTANCE" ] || exit 2; shift ;;
    -h|--help) sed -n '2,7p' "$0"; exit 0 ;;
    *) echo "reap-agent-worktrees.sh: unknown argument '$1'" >&2; exit 2 ;;
  esac
done

INVOKER="${CTX_AGENT_NAME:-}"
OWNER="${OWNER:-$INVOKER}"
FRAMEWORK_ROOT="${CTX_FRAMEWORK_ROOT:-}"
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
GH_BIN="${WORKTREE_REAPER_GH_BIN:-gh}"
CORTEXTOS_BIN="${WORKTREE_REAPER_CORTEXTOS_BIN:-cortextos}"
ACTIVE_CWD_BIN="${WORKTREE_REAPER_ACTIVE_CWD_BIN:-}"
WORKTREE_LIST_BIN="${WORKTREE_REAPER_WORKTREE_LIST_BIN:-}"
SECOND_WORKTREE_LIST_BIN="${WORKTREE_REAPER_SECOND_WORKTREE_LIST_BIN:-}"
POST_PRUNE_WORKTREE_LIST_BIN="${WORKTREE_REAPER_POST_PRUNE_WORKTREE_LIST_BIN:-}"
CTX_ROOT_VAL="${CTX_ROOT:-$HOME/.cortextos/$INSTANCE}"
export CTX_ROOT="$CTX_ROOT_VAL"
export CTX_INSTANCE_ID="$INSTANCE"
# Accept both a primary checkout (.git is a directory) and a LINKED worktree
# (.git is a file pointing at the common dir) — the linked worktree is the
# expected location for an agent's git operations. `git rev-parse --git-dir`
# validates either shape; a bare `-d .git` test rejected linked worktrees.
[ -n "$OWNER" ] && [ -n "$FRAMEWORK_ROOT" ] && git -C "$FRAMEWORK_ROOT" rev-parse --git-dir >/dev/null 2>&1 || {
  echo "reap-agent-worktrees.sh: owner and a valid git CTX_FRAMEWORK_ROOT required" >&2; exit 2;
}

git_common_dir=$(git -C "$FRAMEWORK_ROOT" rev-parse --path-format=absolute --git-common-dir 2>/dev/null) || {
  echo "reap-agent-worktrees.sh: git common directory unknown" >&2; exit 2;
}
EXPECTED_SCOPE="repo:$git_common_dir"
if [ "$DELETE" -eq 1 ]; then
  [ -n "${CTX_WORKTREE_LEASE_TOKEN:-}" ] &&
    [ -n "${CTX_WORKTREE_LEASE_REQUEST_ID:-}" ] &&
    [ "${CTX_WORKTREE_LEASE_SCOPE:-}" = "$EXPECTED_SCOPE" ] || {
      echo "reap-agent-worktrees.sh: destructive mode requires a supervisor-held repository lease" >&2
      exit 2
    }
fi
verify_lease() {
  [ "$DELETE" -eq 0 ] && return 0
  "$CORTEXTOS_BIN" check-worktree-lease \
    --instance "$INSTANCE" \
    --scope "$CTX_WORKTREE_LEASE_SCOPE" \
    --request-id "$CTX_WORKTREE_LEASE_REQUEST_ID" \
    --token "$CTX_WORKTREE_LEASE_TOKEN" >/dev/null 2>&1
}
verify_lease || { echo "reap-agent-worktrees.sh: repository lease is not live" >&2; exit 1; }

if [ "$OWNER" != "$INVOKER" ] && [ "$DELETE" -eq 1 ]; then
  "$CORTEXTOS_BIN" bus send-message "$OWNER" normal \
    "Worktree reaper invoked by $INVOKER for owner $OWNER; the daemon-supervised safety scan is starting." >/dev/null 2>&1 || {
      echo "reap-agent-worktrees.sh: owner notification failed; refusing cross-owner deletion" >&2; exit 1;
    }
fi

tmp_files=()
cleanup() { local f; for f in "${tmp_files[@]}"; do [ -f "$f" ] && rm -f -- "$f"; done; }
trap cleanup EXIT
trap 'cleanup; exit 130' INT
trap 'cleanup; exit 143' TERM

new_tmp() {
  local output_var="$1" f
  f=$(mktemp) || return 1
  tmp_files+=("$f")
  printf -v "$output_var" '%s' "$f"
}
list_worktrees() {
  if [ -n "$WORKTREE_LIST_BIN" ]; then "$WORKTREE_LIST_BIN"
  else git -C "$FRAMEWORK_ROOT" worktree list --porcelain
  fi
}
materialize() {
  local command_bin="$1" raw="$2" tab="$3"
  if [ -n "$command_bin" ]; then "$command_bin" > "$raw"; else list_worktrees > "$raw"; fi || return 2
  awk '/^worktree /{if(p!="")print p"\t"b;p=substr($0,10);b="";next}
       /^branch /{b=substr($0,8);next} END{if(p!="")print p"\t"b}' "$raw" > "$tab" || return 2
}
physical_path() {
  local path="$1" parent target
  if [ -d "$path" ]; then (cd -P -- "$path" 2>/dev/null && pwd -P); return; fi
  parent=$(dirname -- "$path"); [ -d "$parent" ] || return 1
  if [ -L "$path" ]; then
    target=$(readlink "$path") || return 1
    case "$target" in /*) physical_path "$target";; *) physical_path "$parent/$target";; esac
  else
    printf '%s/%s\n' "$(cd -P -- "$parent" 2>/dev/null && pwd -P)" "$(basename -- "$path")"
  fi
}
resolved_owner() {
  local path="$1" branch="$2" base="${1##*/}" dir candidate best="" branch_best=""
  [ "$(physical_path "$path" 2>/dev/null)" = "$CANONICAL" ] && { printf '%s\n' "$OWNER"; return; }
  for dir in "$CTX_ROOT_VAL"/state/agents/*; do
    [ -d "$dir" ] || continue; candidate="${dir##*/}"
    [ "$path" = "$dir/worktree" ] && { printf '%s\n' "$candidate"; return; }
    case "$branch" in
      "refs/heads/$candidate/"*) printf '%s\n' "$candidate"; return ;;
      "refs/heads/agent/$candidate-"*) [ "${#candidate}" -gt "${#branch_best}" ] && branch_best="$candidate" ;;
    esac
  done
  [ -n "$branch_best" ] && { printf '%s\n' "$branch_best"; return; }
  for dir in "$CTX_ROOT_VAL"/state/agents/*; do
    [ -d "$dir" ] || continue; candidate="${dir##*/}"
    case "$base" in "$candidate-"*|"$candidate."*) [ "${#candidate}" -gt "${#best}" ] && best="$candidate";; esac
  done
  [ -n "$best" ] || return 1; printf '%s\n' "$best"
}
owner_session() {
  local value
  value=$("$CORTEXTOS_BIN" bus list-agents 2>/dev/null | jq -r --arg owner "$OWNER" \
    '[.[]|select(.name==$owner)|.running]|if length!=1 or (.[0]|type)!="boolean" then error("unknown") elif .[0] then "active" else "inactive" end' 2>/dev/null) || return 2
  [ "$value" = active ] && return 0; [ "$value" = inactive ] && return 1; return 2
}
active_cwd() {
  local tree="$1" status proc cwd listing
  if [ -n "$ACTIVE_CWD_BIN" ]; then
    "$ACTIVE_CWD_BIN" "$tree" >/dev/null 2>&1; status=$?
    case "$status" in 0|1) return "$status";; *) return 2;; esac
  fi
  if [ -d /proc ]; then
    for proc in /proc/[0-9]*; do
      [ -d "$proc" ] || continue
      if cwd=$(readlink "$proc/cwd" 2>/dev/null); then
        case "$cwd/" in "$tree/"*) return 0;; esac
      elif [ -d "$proc" ]; then
        # The process still exists but its cwd is unreadable (permissions,
        # hidepid, or instrument failure): UNKNOWN must refuse. A vanished PID
        # is the separate branch and contributes no active-cwd evidence.
        return 2
      fi
    done
    return 1
  fi
  command -v lsof >/dev/null 2>&1 || return 2
  listing=$(lsof -a -d cwd -Fn 2>/dev/null) || return 2
  while IFS= read -r cwd; do case "${cwd#n}/" in "$tree/"*) return 0;; esac; done <<< "$listing"
  return 1
}
bad_untracked() {
  local tree="$1" visible ignored item part allowed
  visible=$(git -C "$tree" ls-files --others --exclude-standard --directory --no-empty-directory 2>/dev/null) || return 2
  ignored=$(git -C "$tree" ls-files --others --ignored --exclude-standard --directory --no-empty-directory 2>/dev/null) || return 2
  while IFS= read -r item; do
    [ -n "$item" ] || continue; allowed=0
    IFS=/ read -r -a parts <<< "$item"
    for part in "${parts[@]}"; do case "$part" in node_modules|.data|.cortextOS) allowed=1; break;; esac; done
    [ "$allowed" -eq 0 ] && { printf '%s\n' "$item"; return 0; }
  done <<< "$visible"$'\n'"$ignored"
  return 1
}
pr_merged() {
  local branch="$1" head="$2" count
  count=$("$GH_BIN" pr list --repo "$(git -C "$FRAMEWORK_ROOT" remote get-url origin)" --head "$branch" \
    --state all --json state,mergedAt,headRefOid \
    --jq "[.[]|select(.state==\"MERGED\" and .mergedAt!=null and .headRefOid==\"$head\")]|length" 2>/dev/null) || return 2
  [ "$count" = 1 ] || return 1
}

CANONICAL_RAW=$("$SCRIPT_DIR/agent-worktree-path.sh" "$OWNER") || exit 2
CANONICAL=$(physical_path "$CANONICAL_RAW") || { echo "reap-agent-worktrees.sh: canonical path unknown" >&2; exit 2; }
new_tmp RAW || exit 2; new_tmp TAB || exit 2
materialize "" "$RAW" "$TAB" || { echo "reap-agent-worktrees.sh: worktree inventory unknown" >&2; exit 1; }

FAILURES=0 REAPED=0 PRUNED=0 PRUNE_DONE=0
echo "mode=$([ "$DELETE" -eq 1 ] && echo delete || echo dry-run) owner=$OWNER"
while IFS=$'\t' read -r TREE BRANCH; do
  [ -n "$TREE" ] || continue
  CANDIDATE_OWNER=$(resolved_owner "$TREE" "$BRANCH") || continue
  [ "$CANDIDATE_OWNER" = "$OWNER" ] || continue
  TREE_PHYSICAL=$(physical_path "$TREE" 2>/dev/null) || TREE_PHYSICAL=""
  [ -n "$TREE_PHYSICAL" ] && [ "$TREE_PHYSICAL" = "$CANONICAL" ] && { echo "REFUSE path=$TREE reasons=canonical-agent-worktree"; continue; }

  if [ ! -d "$TREE" ]; then
    echo "PRUNE-CANDIDATE path=$TREE reason=registration-missing-on-disk reclaimed_bytes=0"
    [ "$DELETE" -eq 1 ] && [ "$PRUNE_DONE" -eq 0 ] || continue
    owner_session; first_owner=$?
    [ "$first_owner" -eq 1 ] || { echo "REFUSE-PRUNE owner=$OWNER reason=agent-session-$([ "$first_owner" -eq 0 ] && echo active || echo unknown)"; continue; }

    new_tmp FIRST_RAW || exit 2; new_tmp FIRST_TAB || exit 2
    new_tmp SECOND_RAW || exit 2; new_tmp SECOND_TAB || exit 2
    materialize "" "$FIRST_RAW" "$FIRST_TAB" || { echo "ERROR owner=$OWNER reason=prune-first-census-failure" >&2; FAILURES=$((FAILURES+1)); continue; }
    materialize "$SECOND_WORKTREE_LIST_BIN" "$SECOND_RAW" "$SECOND_TAB" || { echo "ERROR owner=$OWNER reason=prune-second-census-failure" >&2; FAILURES=$((FAILURES+1)); continue; }
    owner_session; second_owner=$?
    [ "$second_owner" -eq 1 ] || { echo "REFUSE-PRUNE owner=$OWNER reason=post-census-agent-session-$([ "$second_owner" -eq 0 ] && echo active || echo unknown)"; continue; }
    cmp -s "$FIRST_TAB" "$SECOND_TAB" || { echo "REFUSE-PRUNE owner=$OWNER reason=inventory-changed-before-prune"; continue; }

    SAFE_PATHS=""; SAFE_COUNT=0; PRUNE_REFUSE=0
    while IFS=$'\t' read -r P B; do
      [ -n "$P" ] && [ ! -d "$P" ] || continue
      O=$(resolved_owner "$P" "$B") || { PRUNE_REFUSE=1; break; }
      [ "$O" = "$OWNER" ] || { PRUNE_REFUSE=1; break; }
      SAFE_PATHS="${SAFE_PATHS}${P}"$'\n'; SAFE_COUNT=$((SAFE_COUNT+1))
    done < "$SECOND_TAB"
    [ "$PRUNE_REFUSE" -eq 0 ] && [ "$SAFE_COUNT" -gt 0 ] || { echo "REFUSE-PRUNE owner=$OWNER reason=registration-outside-owner-or-unknown"; continue; }

    if ! verify_lease; then
      echo "ERROR owner=$OWNER reason=repository-lease-lost-before-prune" >&2; FAILURES=$((FAILURES+1)); continue
    fi
    if git -C "$FRAMEWORK_ROOT" worktree prune --expire now; then
      new_tmp POST_RAW || exit 2; new_tmp POST_TAB || exit 2
      if ! materialize "$POST_PRUNE_WORKTREE_LIST_BIN" "$POST_RAW" "$POST_TAB"; then
        echo "ERROR owner=$OWNER reason=post-prune-census-failure counts-frozen=true" >&2
        FAILURES=$((FAILURES+1)); PRUNE_DONE=1; continue
      fi
      removed=0
      while IFS= read -r P; do [ -n "$P" ] || continue; awk -F '\t' -v p="$P" '$1==p{found=1} END{exit !found}' "$POST_TAB" || removed=$((removed+1)); done <<< "$SAFE_PATHS"
      PRUNED=$((PRUNED+removed)); PRUNE_DONE=1
      echo "PRUNE owner=$OWNER registrations=$removed retained=$((SAFE_COUNT-removed)) reclaimed_bytes=0"
    else
      echo "ERROR owner=$OWNER reason=prune-command-failure" >&2; FAILURES=$((FAILURES+1))
    fi
    continue
  fi

  SHORT="${BRANCH#refs/heads/}"; REASONS=()
  HEAD=$(git -C "$TREE" rev-parse HEAD 2>/dev/null) || HEAD=""
  if [ -z "$HEAD" ]; then REASONS+=(head-unknown); else pr_merged "$SHORT" "$HEAD"; r=$?; [ "$r" -eq 0 ] || REASONS+=("owning-pr-$([ "$r" -eq 2 ] && echo unknown || echo not-merged-for-head)"); fi
  UPSTREAM=$(git -C "$TREE" rev-parse --abbrev-ref --symbolic-full-name '@{upstream}' 2>/dev/null) || UPSTREAM=""
  if [ -z "$UPSTREAM" ]; then REASONS+=(upstream-unknown); else AHEAD=$(git -C "$TREE" rev-list --count "$UPSTREAM..HEAD" 2>/dev/null) || AHEAD=""; [ "$AHEAD" = 0 ] || REASONS+=("commits-ahead-${AHEAD:-unknown}"); fi
  TRACKED=$(git -C "$TREE" status --porcelain --untracked-files=no 2>/dev/null) || TRACKED=UNKNOWN
  [ -z "$TRACKED" ] || REASONS+=(tracked-modifications)
  INDEX=$(git -C "$TREE" ls-files -v 2>/dev/null | awk 'substr($0,1,1)=="S" || substr($0,1,1)~/[a-z]/{print;exit}'); ir=$?
  [ "$ir" -eq 0 ] || REASONS+=(index-visibility-unknown); [ -z "$INDEX" ] || REASONS+=(index-visibility)
  GITLINK=$(git -C "$TREE" ls-files --stage 2>/dev/null | awk '$1=="160000"{print $4;exit}'); gr=$?
  [ "$gr" -eq 0 ] || REASONS+=(gitlink-census-unknown); [ -z "$GITLINK" ] || REASONS+=("submodule-gitlink:$GITLINK")
  BAD=$(bad_untracked "$TREE"); br=$?; [ "$br" -eq 0 ] && REASONS+=("untracked:$BAD"); [ "$br" -eq 2 ] && REASONS+=(untracked-unknown)
  owner_session; sr=$?; [ "$sr" -eq 0 ] && REASONS+=(active-agent-session); [ "$sr" -eq 2 ] && REASONS+=(agent-session-unknown)
  active_cwd "$TREE"; cr=$?; [ "$cr" -eq 0 ] && REASONS+=(active-agent-worktree); [ "$cr" -eq 2 ] && REASONS+=(process-cwd-unknown)
  [ "${#REASONS[@]}" -eq 0 ] || { echo "REFUSE path=$TREE reasons=$(IFS=,; echo "${REASONS[*]}")"; continue; }
  [ "$DELETE" -eq 1 ] || { echo "WOULD-REAP path=$TREE branch=$SHORT"; continue; }

  owner_session; sr=$?; active_cwd "$TREE"; cr=$?
  [ "$sr" -eq 1 ] && [ "$cr" -eq 1 ] || { echo "REFUSE path=$TREE reasons=post-scan-owner-or-cwd-unknown-or-active"; continue; }
  if ! verify_lease; then
    echo "ERROR path=$TREE reason=repository-lease-lost-before-remove" >&2; FAILURES=$((FAILURES+1)); continue
  fi
  if git -C "$FRAMEWORK_ROOT" worktree remove --force "$TREE"; then REAPED=$((REAPED+1)); echo "REAP path=$TREE branch=$SHORT"
  else echo "ERROR path=$TREE reason=remove-failed" >&2; FAILURES=$((FAILURES+1)); fi
done < "$TAB"

echo "summary reaped=$REAPED pruned=$PRUNED failures=$FAILURES lease_scope=$EXPECTED_SCOPE"
[ "$FAILURES" -eq 0 ]
