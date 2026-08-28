#!/bin/bash
# refresh-agent-worktree.sh
# Sync the per-agent worktree to origin/main at task-start time.
#
# DESTRUCTIVE-RESET REQUIRES OPT-IN (a review note on PR #53):
# The hard-reset path can discard uncommitted work in the worktree. To prevent
# accidental loss on a routine refresh, the destructive path is gated behind
# --force-discard. Default behavior is a non-destructive fetch + status check;
# the caller decides whether to discard.
#
# Usage:
#   refresh-agent-worktree.sh [--force-discard | --keep-branch <branch>] [<agent>]
#
#   No flag           — fetch + status check; refuses to reset if working tree
#                       is dirty. Exits 3 (dirty) when discard is needed.
#   --force-discard   — fetch + hard reset to origin/main (drops local work).
#   --keep-branch X   — fetch + checkout X (no reset; stays on feature branch).

set -uo pipefail
ORIGINAL_ARGS=("$@")

KEEP_BRANCH=""
AGENT=""
FORCE_DISCARD=0

while [ $# -gt 0 ]; do
  case "$1" in
    --keep-branch)
      KEEP_BRANCH="${2:-}"
      shift 2
      ;;
    --keep-branch=*)
      KEEP_BRANCH="${1#--keep-branch=}"
      shift
      ;;
    --force-discard)
      FORCE_DISCARD=1
      shift
      ;;
    *)
      AGENT="$1"
      shift
      ;;
  esac
done

AGENT="${AGENT:-${CTX_AGENT_NAME:-}}"
if [ -z "$AGENT" ]; then
  echo "refresh-agent-worktree.sh: AGENT required (positional arg or CTX_AGENT_NAME env)" >&2
  exit 2
fi

CTX_ROOT_VAL="${CTX_ROOT:-$HOME/.cortextos/default}"
WORKTREE="${CTX_AGENT_WORKTREE:-$CTX_ROOT_VAL/state/agents/$AGENT/worktree}"

CORTEXTOS_BIN="${CTX_CORTEXTOS_BIN:-cortextos}"
INSTANCE="${CTX_INSTANCE_ID:-default}"
if [ -z "${CTX_WORKTREE_LEASE_TOKEN:-}" ]; then
  FRAMEWORK_ROOT="${CTX_FRAMEWORK_ROOT:-$(git -C "$WORKTREE" rev-parse --show-toplevel 2>/dev/null)}"
  [ -n "$FRAMEWORK_ROOT" ] || { echo "refresh-agent-worktree.sh: repository root unknown" >&2; exit 2; }
  exec "$CORTEXTOS_BIN" with-worktree-lease --instance "$INSTANCE" --owner "$AGENT" --repo "$FRAMEWORK_ROOT" -- "$0" ${ORIGINAL_ARGS[@]+"${ORIGINAL_ARGS[@]}"}
fi
[ -n "${CTX_WORKTREE_LEASE_REQUEST_ID:-}" ] && [ -n "${CTX_WORKTREE_LEASE_SCOPE:-}" ] || {
  echo "refresh-agent-worktree.sh: complete repository lease capability required" >&2; exit 2;
}
"$CORTEXTOS_BIN" check-worktree-lease \
  --instance "$INSTANCE" \
  --scope "$CTX_WORKTREE_LEASE_SCOPE" \
  --request-id "$CTX_WORKTREE_LEASE_REQUEST_ID" \
  --token "$CTX_WORKTREE_LEASE_TOKEN" >/dev/null 2>&1 || {
    echo "refresh-agent-worktree.sh: repository lease validation failed" >&2; exit 1;
  }

if [ ! -e "$WORKTREE/.git" ]; then
  echo "refresh-agent-worktree.sh: worktree not found at $WORKTREE (run init-agent-worktree.sh first)" >&2
  exit 1
fi

# Fetch/checkout/reset/merge mutate shared repository metadata and therefore
# run only inside the same repository-scoped lease used by reap/prune/remove.
echo "refresh-agent-worktree.sh: fetching origin in $WORKTREE"
git -C "$WORKTREE" fetch origin

BASE_BRANCH="agent/$AGENT-base"

# CRITICAL: never touch 'main' directly here. Git refs are SHARED across
# linked worktrees — a `checkout -B main origin/main` in this worktree would
# force-reset the canonical worktree's main HEAD too, with full blast radius
# across the fleet. Always operate on the per-agent base branch instead.
# (Codex bot P1 catch on PR #54 hotfix, 2026-05-23.)
if [ -n "$KEEP_BRANCH" ]; then
  echo "refresh-agent-worktree.sh: keeping branch $KEEP_BRANCH (no reset)"
  git -C "$WORKTREE" checkout "$KEEP_BRANCH"
elif [ "$FORCE_DISCARD" -eq 1 ]; then
  echo "refresh-agent-worktree.sh: --force-discard set; hard-reset $BASE_BRANCH to origin/main"
  git -C "$WORKTREE" checkout "$BASE_BRANCH"
  git -C "$WORKTREE" reset --hard origin/main
else
  # Default non-destructive path: report dirty status, exit 3 if dirty.
  DIRTY=$(git -C "$WORKTREE" status --porcelain)
  if [ -n "$DIRTY" ]; then
    echo "refresh-agent-worktree.sh: working tree at $WORKTREE has uncommitted changes; refusing to reset without --force-discard"
    echo "$DIRTY" | head -10
    exit 3
  fi
  echo "refresh-agent-worktree.sh: clean tree, fast-forwarding $BASE_BRANCH to origin/main"
  git -C "$WORKTREE" checkout "$BASE_BRANCH"
  git -C "$WORKTREE" merge --ff-only origin/main
fi
