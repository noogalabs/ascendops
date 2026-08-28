#!/bin/bash
# init-agent-worktree.sh
# Idempotent: create the per-agent git worktree if it doesn't exist yet.
# Part of the per-agent worktree-isolation pattern.
#
# Usage:
#   init-agent-worktree.sh [<agent>]
#
# Defaults agent to $CTX_AGENT_NAME. Resolves worktree path from
# $CTX_AGENT_WORKTREE or computes $CTX_ROOT/state/agents/$agent/worktree.
# Framework root is $CTX_FRAMEWORK_ROOT.
#
# Exits 0 if worktree exists or was created. Exits non-zero on failure.

set -uo pipefail
ORIGINAL_ARGS=("$@")

AGENT="${1:-${CTX_AGENT_NAME:-}}"
if [ -z "$AGENT" ]; then
  echo "init-agent-worktree.sh: AGENT required (positional arg or CTX_AGENT_NAME env)" >&2
  exit 2
fi

FRAMEWORK_ROOT="${CTX_FRAMEWORK_ROOT:-}"
if [ -z "$FRAMEWORK_ROOT" ] || [ ! -d "$FRAMEWORK_ROOT/.git" ]; then
  echo "init-agent-worktree.sh: CTX_FRAMEWORK_ROOT must be a git repo (got '$FRAMEWORK_ROOT')" >&2
  exit 2
fi

CTX_ROOT_VAL="${CTX_ROOT:-$HOME/.cortextos/default}"
WORKTREE="${CTX_AGENT_WORKTREE:-$CTX_ROOT_VAL/state/agents/$AGENT/worktree}"

CORTEXTOS_BIN="${CTX_CORTEXTOS_BIN:-cortextos}"
INSTANCE="${CTX_INSTANCE_ID:-default}"
if [ -z "${CTX_WORKTREE_LEASE_TOKEN:-}" ]; then
  exec "$CORTEXTOS_BIN" with-worktree-lease --instance "$INSTANCE" --owner "$AGENT" --repo "$FRAMEWORK_ROOT" -- "$0" ${ORIGINAL_ARGS[@]+"${ORIGINAL_ARGS[@]}"}
fi
[ -n "${CTX_WORKTREE_LEASE_REQUEST_ID:-}" ] && [ -n "${CTX_WORKTREE_LEASE_SCOPE:-}" ] || {
  echo "init-agent-worktree.sh: complete repository lease capability required" >&2; exit 2;
}
"$CORTEXTOS_BIN" check-worktree-lease \
  --instance "$INSTANCE" \
  --scope "$CTX_WORKTREE_LEASE_SCOPE" \
  --request-id "$CTX_WORKTREE_LEASE_REQUEST_ID" \
  --token "$CTX_WORKTREE_LEASE_TOKEN" >/dev/null 2>&1 || {
    echo "init-agent-worktree.sh: repository lease validation failed" >&2; exit 1;
  }

# Idempotency: a worktree path is "valid" if .git exists as a file (linked
# worktree marker) or as a directory (the canonical repo itself).
if [ -e "$WORKTREE/.git" ]; then
  echo "init-agent-worktree.sh: worktree already exists at $WORKTREE"
  exit 0
fi

# All registration writers share the same repository-scoped daemon lease as
# the reaper. Re-enter once under the measured external supervisor; the shell
# never reads or mutates lease persistence itself.
# Ensure parent dir exists, then create the worktree on a per-agent default
# branch based on origin/main. We CANNOT reuse 'main' directly because git
# worktree add refuses to reuse a branch that's already checked out elsewhere
# (the canonical CTX_FRAMEWORK_ROOT is typically on main, where the
# orchestrator stays). Instead each agent gets its own base branch
# 'agent/{agent}-base' tracking origin/main, which the refresh script keeps
# in sync. (Codex bot P1 catch on PR #53, 2026-05-23.)
mkdir -p "$(dirname "$WORKTREE")"
echo "init-agent-worktree.sh: creating worktree for agent=$AGENT at $WORKTREE"
BASE_BRANCH="agent/$AGENT-base"

# If the base branch already exists (e.g. from a prior init that was cleaned
# up but the branch ref stayed), use it; otherwise create new from origin/main.
if git -C "$FRAMEWORK_ROOT" rev-parse --verify "refs/heads/$BASE_BRANCH" >/dev/null 2>&1; then
  git -C "$FRAMEWORK_ROOT" worktree add "$WORKTREE" "$BASE_BRANCH"
else
  # Fetch origin/main first so the new branch tracks the latest.
  git -C "$FRAMEWORK_ROOT" fetch origin main
  git -C "$FRAMEWORK_ROOT" worktree add -b "$BASE_BRANCH" "$WORKTREE" origin/main
fi
