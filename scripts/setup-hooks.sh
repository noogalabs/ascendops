#!/usr/bin/env bash
# setup-hooks.sh — Install cortextOS git hooks into the local repo
#
# Run once after cloning:
#   bash scripts/setup-hooks.sh
#
# Installs local hooks. The pre-commit hook catches declared shared skill drift
# before template/runtime changes leave the working tree; the pre-push hook runs
# npm run build && npm test before any push.

set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || {
  echo "Error: must be run from inside a git repository." >&2
  exit 1
}

HOOKS_DIR="$REPO_ROOT/.git/hooks"

install_hook() {
  local name="$1"
  local src="$REPO_ROOT/scripts/hooks/$name"
  local dest="$HOOKS_DIR/$name"

  if [[ ! -f "$src" ]]; then
    echo "Warning: hook source not found: $src (skipping)" >&2
    return
  fi

  # Preserve operator-installed hooks. Differing hooks are left completely
  # untouched; identical tracked hooks still have their executable bit repaired.
  if [[ -e "$dest" || -L "$dest" ]]; then
    if ! cmp -s "$src" "$dest"; then
      echo "Warning: .git/hooks/$name already exists and differs (skipping)" >&2
      return
    fi
  else
    cp "$src" "$dest"
    echo "  Installed: .git/hooks/$name"
  fi

  chmod +x "$dest"
}

echo "Installing cortextOS git hooks..."
install_hook pre-commit
install_hook pre-push
echo "Done. Hooks active for this repo clone."
