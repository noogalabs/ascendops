#!/usr/bin/env bash

set -uo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
fails=0

make_repo() {
  local repo="$1"
  mkdir -p "$repo/scripts/hooks"
  cp "$ROOT/scripts/setup-hooks.sh" "$repo/scripts/setup-hooks.sh"
  cp "$ROOT/scripts/hooks/pre-commit" "$repo/scripts/hooks/pre-commit"
  cp "$ROOT/scripts/hooks/pre-push" "$repo/scripts/hooks/pre-push"
  git -C "$repo" init -q
}

run_installer() {
  local repo="$1" stdout="$2" stderr="$3"
  (cd "$repo" && bash scripts/setup-hooks.sh) >"$stdout" 2>"$stderr"
}

# Fresh installs create both tracked hooks and make them executable.
fresh="$TMP/fresh"
make_repo "$fresh"
if ! run_installer "$fresh" "$TMP/fresh.out" "$TMP/fresh.err"; then
  echo "FAIL: fresh installer exited nonzero"
  fails=1
fi
for hook in pre-commit pre-push; do
  if [[ ! -f "$fresh/.git/hooks/$hook" || ! -x "$fresh/.git/hooks/$hook" ]]; then
    echo "FAIL: fresh $hook was not installed executable"
    fails=1
  fi
done

# Identical content with a lost executable bit is repaired in place.
identical="$TMP/identical"
make_repo "$identical"
cp "$identical/scripts/hooks/pre-commit" "$identical/.git/hooks/pre-commit"
chmod -x "$identical/.git/hooks/pre-commit"
if ! run_installer "$identical" "$TMP/identical.out" "$TMP/identical.err"; then
  echo "FAIL: identical-hook installer exited nonzero"
  fails=1
fi
if [[ ! -x "$identical/.git/hooks/pre-commit" ]]; then
  echo "FAIL: identical hook executable bit was not restored"
  fails=1
fi

# A differing operator hook keeps both its bytes and its existing mode.
differing="$TMP/differing"
make_repo "$differing"
printf '#!/usr/bin/env bash\necho operator-hook\n' > "$differing/.git/hooks/pre-commit"
chmod -x "$differing/.git/hooks/pre-commit"
before=$(shasum -a 256 "$differing/.git/hooks/pre-commit" | awk '{print $1}')
if ! run_installer "$differing" "$TMP/differing.out" "$TMP/differing.err"; then
  echo "FAIL: differing-hook installer exited nonzero"
  fails=1
fi
after=$(shasum -a 256 "$differing/.git/hooks/pre-commit" | awk '{print $1}')
if [[ "$before" != "$after" ]]; then
  echo "FAIL: differing operator hook content changed"
  fails=1
fi
if [[ -x "$differing/.git/hooks/pre-commit" ]]; then
  echo "FAIL: differing operator hook mode changed"
  fails=1
fi
if ! grep -q 'already exists and differs' "$TMP/differing.err"; then
  echo "FAIL: differing operator hook warning missing"
  fails=1
fi

if [[ "$fails" -eq 0 ]]; then
  echo "setup-hooks.test: PASS"
else
  echo "setup-hooks.test: FAIL"
  exit 1
fi
