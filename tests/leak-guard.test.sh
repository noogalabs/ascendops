#!/usr/bin/env bash
#
# Falsifiability test for the leak-guard scanner (.github/scripts/leak-guard.sh).
#
# A scanner nobody has watched FAIL on a real leak is unproven. This asserts:
#   (a) it FAILS on a planted leak carrying the exact shape that leaked on
#       2026-07-01 — agent roster + a cron-timing table + an operator abs-path
#       (ascendops operator identity);
#   (b) it PASSES on the current clean tree (no false positives on the
#       legitimate framework convention: agent-name placeholders, lifeos
#       test fixtures, obvious placeholder tokens);
#   (c) ascendops parameterization: an operator home path in a framework file
#       FAILS; same content in a PRIVATE orgs/ runtime path is exempt;
#   (d) ascendops fleet: agent+cron-schedule table in a non-test path FAILS,
#       in ANY letter case (roster matching is case-insensitive);
#   (e) a BARE operator home path (no trailing slash — EOL, quote, space) FAILS;
#   (f) NUL-safe plumbing: a leak in a filename containing a space is scanned
#       in --tree mode, not silently skipped;
#   (g) no self-skip wildcard: a leak planted at tests/leak-guard-exfil.md FAILS
#       (only the guard script + workflow are skipped, by exact path);
#   (h) PUBLIC orgs/ carve-outs are scanned: a leak in orgs/<org>/knowledge.md
#       or orgs/<org>/docs/durable/ FAILS; private orgs runtime paths stay exempt;
#   (i) the second operator identity is covered; the repo's known synthetic
#       fixtures pass ONLY via the exact-line allowlist.
#   (j) --tree reads the selected ref's blobs in both stale-disk directions,
#       including a tracked symlink target, rather than inspecting the worktree;
#       every requested subject is validated before scanning, and invalid refs,
#       missing files, and directories refuse to report clean and exit exactly 2.
#
# Operator usernames are split so THIS test file carries no operator-path literal.

set -uo pipefail
cd "$(dirname "$0")/.."
GUARD=".github/scripts/leak-guard.sh"
GUARD_ABS="${LEAK_GUARD_UNDER_TEST:-$PWD/$GUARD}"
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
DH="david""hunter"
CT="cortex""tos"
ORG="ascend""ops"
AGENT="da""ne"
USERS_ROOT="/""Users"
fails=0

# expect_fail LABEL MARKER FILE... — guard must exit non-zero AND report MARKER.
expect_fail() {
  local label="$1" marker="$2" out; shift 2
  out=$(bash "$GUARD_ABS" "$@" 2>&1) \
    && { echo "FAIL: scanner PASSED $label (should have failed)"; fails=1; }
  printf '%s\n' "$out" | grep -q "$marker" \
    || { echo "FAIL: '$marker' not reported for $label"; fails=1; }
}
# expect_pass LABEL FILE... — guard must exit zero.
expect_pass() {
  local label="$1"; shift
  bash "$GUARD_ABS" "$@" > /dev/null 2>&1 \
    || { echo "FAIL: scanner flagged $label (should pass)"; fails=1; }
}

# (a) planted leak: operator path + roster+cron table.
cat > "$TMP/planted.md" <<EOF
# Phase Multi-Agent Report
| Agents simulated | 5 (boris, paul, sentinel, donna, nick) |
| paul | 6 | heartbeat(4h), morning-review(0 13 * * *), evening-review(0 1 * * *) |
Checked at $USERS_ROOT/$DH/cortextos/orgs/lifeos/agents/boris/AGENTS.md
EOF
expect_fail "planted leak (operator path)" 'operator home path' "$TMP/planted.md"
expect_fail "planted leak (roster table)" 'roster' "$TMP/planted.md"

# (c1) operator path in a framework file (simulating src/) MUST FAIL.
cat > "$TMP/src_planted.ts" <<EOF
// config reference: $USERS_ROOT/$DH/cortextos/src/daemon/index.ts
EOF
expect_fail "operator path in framework file" 'operator home path' "$TMP/src_planted.ts"

# (e) BARE operator home path — EOL and quote-delimited — MUST FAIL.
cat > "$TMP/bare_eol.md" <<EOF
workdir is $USERS_ROOT/$DH
EOF
expect_fail "bare operator path at EOL" 'operator home path' "$TMP/bare_eol.md"
cat > "$TMP/bare_quote.md" <<EOF
HOME="$USERS_ROOT/$DH" make build
EOF
expect_fail "bare operator path before quote" 'operator home path' "$TMP/bare_quote.md"

# (i) second operator identity MUST FAIL outside the exact-line allowlist;
# the repo's real fixture files PASS only via that allowlist.
cat > "$TMP/ct_planted.md" <<EOF
log at $USERS_ROOT/$CT/.$CT/default/logs/outbound-messages.jsonl
EOF
expect_fail "second operator identity" 'operator home path' "$TMP/ct_planted.md"
expect_pass "sprint7 fixture file (exact-line allowlist)" tests/sprint7-environment.test.ts
expect_pass "send-telegram fixture file (exact-line allowlist)" tests/unit/cli/send-telegram-normalize.test.ts
expect_pass "portable privacy-wall source" knowledge-base/scripts/mmrag.py
expect_pass "privacy-wall regression fixtures" knowledge-base/scripts/test_privacy_wall.py

# (d) agent + cron-schedule table in a non-test doc MUST FAIL — both cases.
cat > "$TMP/docs_fleet.md" <<EOF
| dane | 4 | heartbeat(4h), morning-review(0 9 * * *), evening-review(0 1 * * *) |
EOF
expect_fail "lowercase roster+cron table" 'roster' "$TMP/docs_fleet.md"
cat > "$TMP/docs_fleet_uc.md" <<EOF
| Dane | 4 | heartbeat(4h), morning-review(0 9 * * *), evening-review(0 1 * * *) |
EOF
expect_fail "capitalized roster+cron table" 'roster' "$TMP/docs_fleet_uc.md"

# (g) tests/leak-guard-exfil.md is NOT self-skipped — MUST FAIL.
mkdir -p "$TMP/tests"
cat > "$TMP/tests/leak-guard-exfil.md" <<EOF
exfil: $USERS_ROOT/$DH/cortextos/orgs/$ORG/agents
EOF
pushd "$TMP" > /dev/null
out=$(bash "$GUARD_ABS" "tests/leak-guard-exfil.md" 2>&1) \
  && { echo "FAIL: scanner PASSED tests/leak-guard-exfil.md (self-skip too broad)"; fails=1; }
printf '%s\n' "$out" | grep -q 'operator home path' \
  || { echo "FAIL: operator home path not detected in tests/leak-guard-exfil.md"; fails=1; }
popd > /dev/null

# (h) PUBLIC orgs carve-outs are scanned; private orgs runtime stays exempt.
mkdir -p "$TMP/orgs/$ORG/docs/durable" "$TMP/orgs/$ORG/agents/$AGENT"
cat > "$TMP/orgs/$ORG/knowledge.md" <<EOF
memory archive: $USERS_ROOT/$DH/Documents/Owner-Private-Archive/01-Memory/daily/
EOF
cat > "$TMP/orgs/$ORG/docs/durable/planted-spec.md" <<EOF
worktree: $USERS_ROOT/$DH/cortextos-worktrees/example
EOF
cat > "$TMP/orgs/$ORG/agents/$AGENT/agent_state.md" <<EOF
$USERS_ROOT/$DH/cortextos/orgs/$ORG/agents/$AGENT/MEMORY.md
EOF
pushd "$TMP" > /dev/null
out=$(bash "$GUARD_ABS" "orgs/$ORG/knowledge.md" 2>&1) \
  && { echo "FAIL: scanner PASSED a leak in orgs knowledge.md (public carve-out)"; fails=1; }
printf '%s\n' "$out" | grep -q 'operator home path' \
  || { echo "FAIL: operator home path not detected in orgs knowledge.md"; fails=1; }
out=$(bash "$GUARD_ABS" "orgs/$ORG/docs/durable/planted-spec.md" 2>&1) \
  && { echo "FAIL: scanner PASSED a leak in orgs docs/durable (public carve-out)"; fails=1; }
out=$(bash "$GUARD_ABS" "orgs/$ORG/agents/$AGENT/agent_state.md" 2>&1) \
  && { echo "FAIL: guard PASSED a tracked private-runtime path (must report it — tracked private paths ship publicly)"; fails=1; }
printf '%s\n' "$out" | grep -q 'private runtime path is tracked' \
  || { echo "FAIL: tracked private-runtime path not flagged with the expected marker"; fails=1; }
popd > /dev/null

# (f) filename WITH A SPACE carrying a leak is scanned in --tree mode.
mkdir -p "$TMP/spacerepo"
pushd "$TMP/spacerepo" > /dev/null
git init -q .
printf 'ref %s/%s/x\n' "$USERS_ROOT" "$DH" > "leak file.md"
git add -A
git -c user.email=leak@test -c user.name=leak commit -qm plant > /dev/null
out=$(bash "$GUARD_ABS" --tree HEAD 2>&1) \
  && { echo "FAIL: --tree skipped a leaky filename containing a space"; fails=1; }
printf '%s\n' "$out" | grep -q 'operator home path' \
  || { echo "FAIL: operator home path not detected in spaced filename"; fails=1; }
popd > /dev/null

# (j) Requested direct subjects must not disappear behind scan_file's
# non-file return. Validate atomically: a valid leaky file must not be partially
# scanned when any sibling argument is invalid.
mkdir -p "$TMP/direct-subject-dir"
printf 'direct leak: /Users/%s/private\n' "$DH" > "$TMP/direct-leak.md"
printf 'unreadable content\n' > "$TMP/direct-unreadable.md"
chmod 000 "$TMP/direct-unreadable.md"
out=$(bash "$GUARD_ABS" \
  "$TMP/definitely-missing.md" \
  "$TMP/direct-subject-dir" \
  "$TMP/direct-unreadable.md" 2>&1)
rc=$?
[ "$rc" -eq 2 ] \
  || { echo "FAIL: invalid direct subjects exited $rc, expected exactly 2"; fails=1; }
printf '%s\n' "$out" | grep -q "$TMP/definitely-missing.md" \
  || { echo "FAIL: direct refusal did not name the missing subject"; fails=1; }
printf '%s\n' "$out" | grep -q "$TMP/direct-subject-dir" \
  || { echo "FAIL: direct refusal did not name the directory subject"; fails=1; }
printf '%s\n' "$out" | grep -q 'pass files explicitly, or use --tree' \
  || { echo "FAIL: directory refusal did not name the corrective invocation"; fails=1; }
printf '%s\n' "$out" | grep -q "$TMP/direct-unreadable.md (unreadable file)" \
  || { echo "FAIL: direct refusal did not name the unreadable subject as unreadable"; fails=1; }
printf '%s\n' "$out" | grep -q 'leak-guard: clean' \
  && { echo "FAIL: invalid direct subjects were still reported clean"; fails=1; }

out=$(bash "$GUARD_ABS" "$TMP/direct-leak.md" "$TMP/definitely-missing.md" 2>&1)
rc=$?
[ "$rc" -eq 2 ] \
  || { echo "FAIL: mixed valid/invalid direct invocation exited $rc, expected exactly 2"; fails=1; }
printf '%s\n' "$out" | grep -q 'operator home path' \
  && { echo "FAIL: mixed valid/invalid invocation partially scanned the valid subject"; fails=1; }
printf '%s\n' "$out" | grep -q 'leak-guard: clean' \
  && { echo "FAIL: mixed valid/invalid invocation was still reported clean"; fails=1; }

# (f2/j) --tree REF must inspect REF BLOBS, never the same-named worktree file.
# Keep the two directions separate: either one can be broken while the other
# stays green. A symlink target is blob content too and gets its own control.
mkdir -p "$TMP/refrepo"
pushd "$TMP/refrepo" > /dev/null
git init -q .
git config user.email leak@test
git config user.name leak

printf 'clean framework content\n' > ref-a.md
git add ref-a.md
git commit -qm 'clean ref'
printf 'worktree only: /Users/%s/private\n' "$DH" > ref-a.md
out=$(bash "$GUARD_ABS" --tree HEAD 2>&1)
rc=$?
[ "$rc" -eq 0 ] \
  || { echo "FAIL: --tree read a leaky WORKTREE file when the selected ref blob was clean"; fails=1; }

# Remove the first direction's worktree-only leak before proving the inverse.
# Otherwise the old implementation can fail on ref-a.md and accidentally rescue
# the ref-b.md assertion while still never reading ref-b.md from the ref.
printf 'clean framework content\n' > ref-a.md
printf 'committed leak: /Users/%s/private\n' "$DH" > ref-b.md
git add ref-b.md
git commit -qm 'leaky ref'
printf 'clean worktree replacement\n' > ref-b.md
out=$(bash "$GUARD_ABS" --tree HEAD 2>&1)
rc=$?
[ "$rc" -eq 1 ] \
  || { echo "FAIL: --tree missed a leaky REF blob hidden by a clean worktree file"; fails=1; }
printf '%s\n' "$out" | grep -q 'operator home path' \
  || { echo "FAIL: --tree did not report the operator path from the selected ref blob"; fails=1; }

ln -s "/Users/$DH/private" ref-link
git add ref-link
git commit -qm 'leaky symlink ref'
rm ref-link
ln -s 'portable-target' ref-link
out=$(bash "$GUARD_ABS" --tree HEAD 2>&1)
rc=$?
[ "$rc" -eq 1 ] \
  || { echo "FAIL: --tree missed a leaky symlink TARGET stored in the selected ref"; fails=1; }
printf '%s\n' "$out" | grep -q 'operator home path in symlink target' \
  || { echo "FAIL: --tree did not identify the selected ref symlink target"; fails=1; }

empty_tree=$(git mktree </dev/null)
out=$(bash "$GUARD_ABS" --tree "$empty_tree" 2>&1)
rc=$?
[ "$rc" -eq 0 ] \
  || { echo "FAIL: a valid empty tree was not accepted as genuinely clean"; fails=1; }
printf '%s\n' "$out" | grep -q 'leak-guard: clean' \
  || { echo "FAIL: a valid empty tree did not report clean"; fails=1; }

out=$(bash "$GUARD_ABS" --tree HEAD unexpected-one unexpected-two 2>&1)
rc=$?
[ "$rc" -eq 2 ] \
  || { echo "FAIL: extra --tree arguments exited $rc, expected exactly 2"; fails=1; }
printf '%s\n' "$out" | grep -q 'unexpected-one' \
  || { echo "FAIL: --tree refusal did not name the first extra argument"; fails=1; }
printf '%s\n' "$out" | grep -q 'unexpected-two' \
  || { echo "FAIL: --tree refusal did not name the second extra argument"; fails=1; }
printf '%s\n' "$out" | grep -q 'operator home path' \
  && { echo "FAIL: extra --tree arguments allowed a partial tree scan"; fails=1; }
printf '%s\n' "$out" | grep -q 'leak-guard: clean' \
  && { echo "FAIL: extra --tree arguments were still reported clean"; fails=1; }

out=$(bash "$GUARD_ABS" --tree refs/heads/definitely-missing 2>&1)
rc=$?
[ "$rc" -eq 2 ] \
  || { echo "FAIL: invalid --tree ref exited $rc, expected exactly 2"; fails=1; }
printf '%s\n' "$out" | grep -q 'unable to resolve tree ref' \
  || { echo "FAIL: invalid --tree ref did not explain the audit refusal"; fails=1; }
printf '%s\n' "$out" | grep -q 'leak-guard: clean' \
  && { echo "FAIL: invalid --tree ref was still reported clean"; fails=1; }

# A resolved tree can still disappear as a scan subject if enumeration fails.
# Force only ls-tree to fail after rev-parse/materialization have succeeded.
mkdir -p "$TMP/failing-git"
REAL_GIT=$(command -v git)
cat > "$TMP/failing-git/git" <<EOF
#!/usr/bin/env bash
if [ "\${1:-}" = "ls-tree" ]; then exit 77; fi
exec "$REAL_GIT" "\$@"
EOF
chmod +x "$TMP/failing-git/git"
mkdir -p "$TMP/guard-trap-tmp"
out=$(TMPDIR="$TMP/guard-trap-tmp" \
  PATH="$TMP/failing-git:$PATH" \
  bash "$GUARD_ABS" --tree HEAD 2>&1)
rc=$?
[ "$rc" -eq 2 ] \
  || { echo "FAIL: failed tree enumeration exited $rc, expected exactly 2"; fails=1; }
printf '%s\n' "$out" | grep -q 'unable to enumerate tree ref' \
  || { echo "FAIL: failed tree enumeration did not explain the audit refusal"; fails=1; }
printf '%s\n' "$out" | grep -q 'leak-guard: clean' \
  && { echo "FAIL: failed tree enumeration was still reported clean"; fails=1; }
find "$TMP/guard-trap-tmp" -mindepth 1 -print -quit | grep -q . \
  && { echo "FAIL: EXIT cleanup left a materialized tree after enumeration failure"; fails=1; }
popd > /dev/null

# (j) The workflow invokes direct mode, so its subject producer must emit only
# content-bearing tree entries. Execute the exact functions extracted from the
# workflow: a copied/reimplemented test helper could stay green while the caller
# silently widened back to gitlinks.
mkdir -p "$TMP/workflow-subject-repo"
awk '
  /# BEGIN leak-guard-subject-filter/ { capture=1; next }
  /# END leak-guard-subject-filter/ { exit }
  capture { sub(/^          /, ""); print }
' .github/workflows/leak-guard.yml > "$TMP/workflow-subject-filter.sh"
pushd "$TMP/workflow-subject-repo" > /dev/null
git init -q .
git config user.email leak@test
git config user.name leak
printf 'regular\n' > regular.md
printf '#!/bin/sh\nexit 0\n' > executable.sh
chmod +x executable.sh
ln -s regular.md link.md
git add regular.md executable.sh link.md
git commit -qm 'blob fixtures'
fixture_commit=$(git rev-parse HEAD)
git update-index --add --cacheinfo "160000,$fixture_commit,vendor/gitlink"
git commit -qm 'gitlink fixture'

# shellcheck disable=SC1090
source "$TMP/workflow-subject-filter.sh"
list_scannable_tree_subjects HEAD > "$TMP/tree-subjects.z"
tr '\0' '\n' < "$TMP/tree-subjects.z" | sort > "$TMP/tree-subjects.txt"
printf '%s\n' executable.sh link.md regular.md > "$TMP/expected-subjects.txt"
cmp -s "$TMP/expected-subjects.txt" "$TMP/tree-subjects.txt" \
  || { echo "FAIL: full-tree workflow subject list did not contain exactly blob/symlink modes"; fails=1; }

printf '%s\0' regular.md executable.sh link.md vendor/gitlink \
  | filter_scannable_changed_subjects HEAD > "$TMP/changed-subjects.z"
tr '\0' '\n' < "$TMP/changed-subjects.z" | sort > "$TMP/changed-subjects.txt"
cmp -s "$TMP/expected-subjects.txt" "$TMP/changed-subjects.txt" \
  || { echo "FAIL: changed-path workflow subject list did not contain exactly blob/symlink modes"; fails=1; }

mkdir -p "$TMP/workflow-failing-git"
REAL_GIT=$(command -v git)
cat > "$TMP/workflow-failing-git/git" <<EOF
#!/usr/bin/env bash
if [ "\${1:-}" = "ls-tree" ]; then exit 77; fi
exec "$REAL_GIT" "\$@"
EOF
chmod +x "$TMP/workflow-failing-git/git"
PATH="$TMP/workflow-failing-git:$PATH" list_scannable_tree_subjects HEAD \
  > "$TMP/failed-tree-subjects.z" 2>/dev/null
tree_subject_rc=$?
printf '%s\0' regular.md \
  | PATH="$TMP/workflow-failing-git:$PATH" filter_scannable_changed_subjects HEAD \
      > "$TMP/failed-changed-subjects.z" 2>/dev/null
changed_subject_rc=$?
[ "$tree_subject_rc" -eq 2 ] \
  || { echo "FAIL: full-tree workflow subject enumeration failure did not exit 2"; fails=1; }
[ "$changed_subject_rc" -eq 2 ] \
  || { echo "FAIL: changed-path workflow subject lookup failure did not exit 2"; fails=1; }
[ ! -s "$TMP/failed-tree-subjects.z" ] \
  || { echo "FAIL: failed full-tree subject enumeration emitted a partial population"; fails=1; }
[ ! -s "$TMP/failed-changed-subjects.z" ] \
  || { echo "FAIL: failed changed-path subject lookup emitted a partial population"; fails=1; }
popd > /dev/null

# (j) PATH-SEGMENT FALSE POSITIVE. A documentation reference can carry BOTH a
# roster name and a cron-marker token as ordinary path segments, because our
# skills are literally stored at agents/<name>/.claude/skills/<marker>/. That is
# a file path, not a roster-plus-schedule table, and must NOT fire.
cat > "$TMP/docs_path_ref.md" <<'EOF'
**File:** `$CTX_FRAMEWORK_ROOT/your org internal docs`
EOF
expect_pass "roster name and cron marker as path segments" "$TMP/docs_path_ref.md"

cat > "$TMP/docs_path_ref_evening.md" <<'EOF'
## FILE 8 — `$CTX_FRAMEWORK_ROOT/your org internal docs`
EOF
expect_pass "roster name and evening-review path segment" "$TMP/docs_path_ref_evening.md"

# (j1b) AGENT/SKILL COMPACT REFERENCES. Work queues name ownership with a
# canonical `agent/skill` token; the skill name is not cadence evidence. The
# exact incident-shaped line that exposed the false positive must remain clean.
cat > "$TMP/docs_agent_skill_ref.md" <<'EOF'
Run codie/comms incident audit, then dane/evening-review audit, then blue history sweep
Run Codie/comms incident audit, then Dane/Evening-Review audit, then Blue history sweep
EOF
expect_pass "adjacent agent/skill work-queue references" "$TMP/docs_agent_skill_ref.md"

cat > "$TMP/docs_agent_skill_compact_list.md" <<'EOF'
dane/evening-review,codie/morning-review,blue/human-task-sweep
Dane/Evening-Review;Codie/Morning-Review|Blue/Human-Task-Sweep
EOF
expect_pass "compact adjacent agent/skill reference lists" "$TMP/docs_agent_skill_compact_list.md"

cat > "$TMP/docs_agent_skill_prefixed_ref.md" <<'EOF'
work/dane/evening-review
queue/codie/morning-review,owners/blue/human-task-sweep
agents/dane/evening-review/SKILL.md
EOF
expect_pass "prefixed canonical refs and longer paths stay clean" "$TMP/docs_agent_skill_prefixed_ref.md"

# Masking the reference must not hide real cadence evidence elsewhere on the
# same line, in either order, or a separate bare marker after a compact list.
cat > "$TMP/docs_agent_skill_ref_with_cadence.md" <<'EOF'
dane/evening-review runs daily at 9am
EOF
expect_fail "agent/skill reference does not hide later cadence" 'roster' "$TMP/docs_agent_skill_ref_with_cadence.md"

cat > "$TMP/docs_cadence_before_agent_skill_ref.md" <<'EOF'
daily at 9am is the cadence for dane/evening-review
EOF
expect_fail "agent/skill reference does not hide earlier cadence" 'roster' "$TMP/docs_cadence_before_agent_skill_ref.md"

cat > "$TMP/docs_agent_skill_list_with_marker.md" <<'EOF'
dane/evening-review,codie/morning-review,evening-review
EOF
expect_fail "compact references do not hide a separate marker" 'roster' "$TMP/docs_agent_skill_list_with_marker.md"

# Keep the transform bounded on untrusted compact input. This also proves every
# adjacent reference is masked rather than only alternating members.
awk 'BEGIN {
  for (i = 0; i < 5000; i++)
    printf "dane/evening-review%s", (i == 4999 ? "\n" : ",")
}' > "$TMP/docs_agent_skill_large_compact_list.md"
if ! node - "$GUARD_ABS" "$TMP/docs_agent_skill_large_compact_list.md" <<'NODE'
const { spawnSync } = require('node:child_process');
const result = spawnSync('bash', [process.argv[2], process.argv[3]], {
  encoding: 'utf8',
  timeout: 5000,
});
if (result.error?.code === 'ETIMEDOUT') {
  console.error('FAIL: compact-reference masking exceeded 5000ms');
  process.exit(1);
}
if (result.status !== 0) {
  process.stderr.write(result.stderr || result.stdout || 'compact-reference scan failed\n');
  process.exit(1);
}
NODE
then
  fails=1
fi

# (j2) KNOWN POSITIVE, THE OTHER DIRECTION. The narrowing above must not buy its
# quiet by blinding the rule: a genuine roster-plus-cadence row, marker NOT
# preceded by a slash, must still fire. This is the test that makes (j) safe.
#
# The row deliberately carries NO cron expression and NO digits. An earlier
# draft used `morning-review at 0 9 * * *`, which is NOT a discriminating test:
# the bare five-field expression is picked up by the windowed awk branch, so the
# case stayed green even when the bare-name markers were deleted outright. It
# proved the rule fired, not that THIS rule fired. A known-positive that another
# branch can rescue is not a known-positive for the branch under change.
cat > "$TMP/docs_roster_same_line.md" <<'EOF'
| dane | primary | morning-review |
EOF
expect_fail "bare cadence marker beside a roster name still fires" 'roster' "$TMP/docs_roster_same_line.md"

# (j4) A SLASH-PREFIXED TOKEN IS NOT A PATH. Writing the cadence cell of an ops
# table as `/morning-review` gives it a leading slash and no trailing one. An
# exemption keyed on "preceded by /" alone would launder the whole row, so the
# exemption requires a genuine path SEGMENT: `/marker/`, slashes on both sides.
# (Found by the Codex reviewer on PR #184, P1. It is a real bypass, not a nit.)
cat > "$TMP/docs_slash_prefixed_cell.md" <<'EOF'
| dane | cadence | /morning-review |
EOF
expect_fail "slash-prefixed cadence cell is not a path segment" 'roster' "$TMP/docs_slash_prefixed_cell.md"

# (j5) The marker at END OF LINE with a leading slash is the same bypass without
# the trailing pipe. Guards against an exemption written as `/marker` + anything.
cat > "$TMP/docs_slash_prefixed_eol.md" <<'EOF'
dane cadence: /morning-review
EOF
expect_fail "slash-prefixed cadence at end of line still fires" 'roster' "$TMP/docs_slash_prefixed_eol.md"

# (j3) A path segment must not launder a real schedule sitting beside it. If the
# same line ALSO carries a bare cron expression, the slash exclusion must not
# rescue it.
cat > "$TMP/docs_path_plus_real_cron.md" <<'EOF'
See agents/dane/.claude/skills/morning-review/SKILL.md — runs (0 9 * * *) daily.
EOF
expect_fail "path segment does not launder an adjacent real schedule" 'roster' "$TMP/docs_path_plus_real_cron.md"

# (n1) NATURAL-LANGUAGE CADENCE — the known-positive for the WIDENING, built so
# that NO other branch can rescue it. No path, no bare marker, no parenthesized
# cadence, no five-field cron expression: the ONLY thing that can catch this row
# is the natural-language condition. Deleting that condition takes it RED.
# (This shape was never detected before; the gap was invisible because a related
# line was being caught incidentally via a skill path.)
cat > "$TMP/docs_nl_cadence.md" <<'EOF'
| dane | primary | daily at 9am |
EOF
expect_fail "roster + natural-language schedule (no path, no cron)" 'roster' "$TMP/docs_nl_cadence.md"

cat > "$TMP/docs_nl_cadence_weekdays.md" <<'EOF'
| dane | orchestrator | weekdays at 6pm |
EOF
expect_fail "roster + weekday natural-language schedule" 'roster' "$TMP/docs_nl_cadence_weekdays.md"

# (n2) The reviewer's original blocker: roster + path reference + natural cadence.
# It must fire on the CADENCE, not on the path, which is why (n1) exists as the
# isolated proof.
cat > "$TMP/docs_path_plus_nl_cadence.md" <<'EOF'
| dane | agents/dane/.claude/skills/morning-review/SKILL.md | daily at 9am |
EOF
expect_fail "path reference does not launder a natural-language schedule" 'roster' "$TMP/docs_path_plus_nl_cadence.md"

# (n3) NEGATIVE. A frequency word with NO clock time is ordinary prose and must
# stay clean — this is the false-positive bound on the widening.
cat > "$TMP/docs_freq_no_time.md" <<'EOF'
dane reviews the queue daily and escalates anything still open.
EOF
expect_pass "frequency word without a time is prose" "$TMP/docs_freq_no_time.md"

# (n4) NEGATIVE, AND THE ONE THAT MATTERS. A bare integer after "at" is a
# QUANTITY, not a clock time. An earlier draft matched `at [0-9]` and read all
# four of these as schedules. They are sentences people write, and the 2602-file
# corpus was blind to them only because our written history happens not to
# contain that combination — a corpus bounds false positives against the PAST.
# Mutation back to `at [0-9]` must take these RED.
cat > "$TMP/docs_qty_not_time.md" <<'EOF'
dane reviews daily occupancy at 9 properties.
dane bills hourly labor at 125 dollars per visit.
blue summarizes weekly delinquencies at 12 properties.
collie checks nightly output at 3 stages of the pipeline.
EOF
expect_pass "bare integer after 'at' is a quantity, not a clock time" "$TMP/docs_qty_not_time.md"

# (n6) NEGATIVE. A clock pattern must match a COMPLETE TOKEN, never a prefix of
# a longer word or number, and must not accept impossible times. `9 am` is a
# prefix of `9 amperes`; `09:17` is a prefix of `09:171`; an unconstrained
# two-digit form accepts `99:99`. The first is ordinary property-maintenance
# prose, which is what makes this a real false positive rather than a curiosity.
# Mutations: removing the terminal boundary must catch the amperes and 09:171
# cases; loosening the hour/minute ranges must catch 99:99.
# Deliberately THREE SEPARATE FILES, not one file with three lines. Bundled into
# one case, any single mutation turns the case RED and it is impossible to tell
# WHICH property was under test — the same rescue problem that made an earlier
# known-positive worthless here. Split, each mutation maps to a named case.
cat > "$TMP/docs_clock_prefix_word.md" <<'EOF'
dane bills hourly electrical load at 9 amperes.
EOF
expect_pass "am/pm must not match the prefix of a longer word (amperes)" "$TMP/docs_clock_prefix_word.md"

cat > "$TMP/docs_clock_prefix_num.md" <<'EOF'
blue summarizes weekly batches at 09:171 records.
EOF
expect_pass "HH:MM must not match the prefix of a longer number" "$TMP/docs_clock_prefix_num.md"

cat > "$TMP/docs_clock_impossible.md" <<'EOF'
collie checks nightly output at 99:99 records.
EOF
expect_pass "an impossible time is not a clock value" "$TMP/docs_clock_impossible.md"

# (n5) The clock forms that MUST still be caught, so the tightening above cannot
# be bought by simply blinding the condition: am/pm suffix, and HH:MM.
cat > "$TMP/docs_clock_ampm.md" <<'EOF'
| dane | primary | daily at 9 am |
EOF
expect_fail "am/pm clock time with a space still fires" 'roster' "$TMP/docs_clock_ampm.md"

cat > "$TMP/docs_clock_hhmm.md" <<'EOF'
| dane | primary | daily at 09:17 |
EOF
expect_fail "HH:MM clock time still fires" 'roster' "$TMP/docs_clock_hhmm.md"

# (n7) EDGE OF THE CLOCK CLASS, found by probing the class rather than the
# examples in hand. A leading-zero 12-hour time is a plausible way to write a
# schedule, and without an optional `0?` it escaped entirely — a BYPASS, not a
# false positive. Sits beside the boundary negatives deliberately: `at 09am`
# must fire while `at 09 amperes` must not, and only a complete-token rule can
# tell them apart.
cat > "$TMP/docs_clock_leading_zero.md" <<'EOF'
| dane | primary | daily at 09am |
EOF
expect_fail "leading-zero 12-hour time fires" 'roster' "$TMP/docs_clock_leading_zero.md"

cat > "$TMP/docs_clock_leading_zero_qty.md" <<'EOF'
dane bills hourly electrical load at 09 amperes.
EOF
expect_pass "leading-zero quantity is still not a clock time" "$TMP/docs_clock_leading_zero_qty.md"

# (r1) ORDER INDEPENDENCE. A roster-plus-schedule table does not become safe
# because Schedule is the first column. The rule was forward-only, so a cadence
# preceding the roster name passed clean. Isolated: natural-language cadence,
# reverse order, nothing else on the line that any other branch could catch.
cat > "$TMP/docs_reverse_nl.md" <<'EOF'
| daily at 9am | dane |
EOF
expect_fail "cadence before roster name still fires (natural language)" 'roster' "$TMP/docs_reverse_nl.md"

cat > "$TMP/docs_reverse_nl_cols.md" <<'EOF'
| Schedule | daily at 9am | Agent | dane |
EOF
expect_fail "cadence column before agent column still fires" 'roster' "$TMP/docs_reverse_nl_cols.md"

# (r2) The SAME reversal on a bare marker. Not part of the reported finding —
# the report covered natural-language cadence only — but the ordering assumption
# was in the shared pattern, so it was open for every cadence form. The machine
# cron shapes were rescued by the windowed awk branch, which is already
# order-independent, and that is precisely why the gap stayed invisible.
cat > "$TMP/docs_reverse_marker.md" <<'EOF'
| morning-review | dane |
EOF
expect_fail "bare cadence marker before roster name still fires" 'roster' "$TMP/docs_reverse_marker.md"

# (r3) NEGATIVE. Symmetry must not buy detection with prose false positives: the
# quantity look-alikes have to stay clean in the reverse direction too.
cat > "$TMP/docs_reverse_qty.md" <<'EOF'
hourly labor at 125 dollars for dane.
hourly electrical load at 9 amperes billed to dane.
EOF
expect_pass "reverse-order quantity prose stays clean" "$TMP/docs_reverse_qty.md"

# (w1) THE WINDOWED BRANCH MUST KNOW THE SAME CADENCE CLASS. It originally
# recognised machine-cron syntax only, so a multi-line ops table using a
# natural-language time slipped through in BOTH row orders while the identical
# table written with a cron expression was caught. Two branches disagreeing
# about what a cadence IS is what hid the single-line ordering bug as well.
cat > "$TMP/docs_window_nl_after.md" <<'EOF'
| Agent | dane |
| Role | orchestrator |
| Cadence | daily at 9am |
EOF
expect_fail "windowed natural cadence after roster row" 'within 3 lines' "$TMP/docs_window_nl_after.md"

cat > "$TMP/docs_window_nl_before.md" <<'EOF'
| Cadence | daily at 9am |
| Role | orchestrator |
| Agent | dane |
EOF
expect_fail "windowed natural cadence before roster row" 'within 3 lines' "$TMP/docs_window_nl_before.md"

# (w2) NEGATIVES bounding the windowed widening: quantity prose stays clean, and
# the existing W=3 contract is unchanged — the same rows further apart pass.
cat > "$TMP/docs_window_qty.md" <<'EOF'
| Agent | dane |
| Role | orchestrator |
| Billing | hourly labor at 125 dollars |
EOF
expect_pass "windowed quantity prose stays clean" "$TMP/docs_window_qty.md"

{
  printf '| Agent | dane |\n'
  for i in $(seq 1 4); do printf '| Note | filler line %s |\n' "$i"; done
  printf '| Cadence | daily at 9am |\n'
} > "$TMP/docs_window_nl_far.md"
expect_pass "windowed natural cadence beyond W=3 stays clean" "$TMP/docs_window_nl_far.md"

# (w3) A BARE MARKER IS DELIBERATELY NOT A WINDOWED CADENCE. Proximity is weaker
# evidence than adjacency: within 3 lines a skill name near a roster name is
# usually a skill INVENTORY, not a schedule. This exact shape is real — see
# worktree-hooks-audit-2026-05-23.md, a table of skills against a yes/no git-ops
# column with no cadence anywhere. The same marker on the SAME line as a roster
# name does still fire (test j2), which is the intended asymmetry.
cat > "$TMP/docs_window_marker_inventory.md" <<'EOF'
| Agent | dane |
| Role | orchestrator |
| Skill | morning-review |
EOF
expect_pass "bare marker in a 3-line window is an inventory, not a schedule" "$TMP/docs_window_marker_inventory.md"

# (g1) THE RECURRENCE CLASS. The frequency half of the cadence rule was a
# vocabulary list that stopped when its own examples passed; six ordinary forms
# escaped. It is now a stated finite class of FOUR structures over three closed
# vocabularies (see leak-guard.sh). These cases exercise each structure, and
# crucially INCLUDE FORMS NOBODY ENUMERATED while writing it — that is the test
# of a class rather than a list.
cat > "$TMP/docs_recurrence_class.md" <<'EOF'
| dane | primary | monthly at 9am |
| dane | primary | weekends at 9am |
| dane | primary | every Monday at 9am |
| dane | primary | each morning at 9am |
| dane | primary | every 4 hours at 9am |
| dane | primary | Mon-Fri at 9am |
| dane | primary | quarterly at 9am |
| dane | primary | annually at 9am |
| dane | primary | biweekly at 9am |
| dane | primary | every other week at 9am |
| dane | primary | every two weeks at 9am |
| dane | primary | Mondays at 9am |
| dane | primary | Mon, Wed, Fri at 9am |
| dane | primary | Monday and Friday at 9am |
EOF
expect_fail "recurrence class: all four structures fire" 'roster' "$TMP/docs_recurrence_class.md"

# Each structure ALSO isolated, so a single shared file cannot hide a structure
# that stopped working. A bundled positive proves only that SOMETHING fired.
for case in 'monthly at 9am' 'every other week at 9am' 'Mon-Fri at 9am' 'Mondays at 9am' 'Mon, Wed, Fri at 9am'; do
  printf '| dane | primary | %s |\n' "$case" > "$TMP/docs_rc_one.md"
  expect_fail "recurrence isolated: $case" 'roster' "$TMP/docs_rc_one.md"
done

# (g2) THE ONE DELIBERATE EXCLUSION. A bare singular day is NOT a recurrence:
# `Monday at 9am` is as likely to be a single meeting as a schedule. Plural,
# ranged and listed days DO fire (g1), so this is a bounded judgement call and
# not an oversight.
cat > "$TMP/docs_bare_single_day.md" <<'EOF'
| dane | primary | Monday at 9am |
EOF
expect_pass "a bare singular day is not a recurrence" "$TMP/docs_bare_single_day.md"

# (g3) NEGATIVE. The DAY and UNIT vocabularies must not match as substrings of
# ordinary words — `sun` in `sundae`, `mon` in `monsoon`/`monitor`, `sat` in
# `saturation`. This is the boundary failure that broke the clock half twice.
cat > "$TMP/docs_vocab_substrings.md" <<'EOF'
dane runs every sundae at 9am
dane runs every monsoon at 9am
dane checks every monitor at 9am
dane reviews each saturation at 9am
EOF
expect_pass "day/unit vocabularies do not match inside longer words" "$TMP/docs_vocab_substrings.md"

# (k) ZERO ARGUMENTS MUST FAIL LOUDLY. The script ended in `for f in "$@"`, so an
# invocation with no files iterated an empty list and exited 0 — a clean report
# from a scan that never happened. That is worse than a crash, because the clean
# report gets quoted as evidence. (Observed 2026-07-30: a pre-push gate that
# scanned nothing and was reported as proof the tree was clean.)
# The exit code is asserted EXACTLY, not merely as nonzero. The contract is that
# a caller can tell "you misused me" (2) from "I found a leak" (1); a test that
# accepts any nonzero leaves that contract decorative, since changing `exit 2` to
# `exit 1` would keep it green. Asserting the precise value is the only thing
# that makes the distinction real.
out=$(bash "$GUARD_ABS" 2>&1); rc=$?
[ "$rc" -eq 2 ] \
  || { echo "FAIL: zero-argument invocation exited $rc, expected exactly 2 (1 means 'leak found' and must stay distinguishable)"; fails=1; }
printf '%s\n' "$out" | grep -qi 'no files to scan' \
  || { echo "FAIL: zero-argument invocation did not say why it refused"; fails=1; }

# (b) MUST PASS on the full tracked tree — the script's own exemption predicate
# is authoritative (no pre-filtering here), so this also proves the predicate.
# NOTE: if pre-existing leaks exist in the scanned surface, this test WILL flag
# them — that is the guard working correctly. Remediate the files; do NOT
# bypass the check.
tree_out=$(bash "$GUARD" --tree HEAD 2>&1)
tree_exit=$?
if [ "$tree_exit" -ne 0 ]; then
  echo "WARNING: scanner found pre-existing leak(s) in the tracked tree (remediation needed):"
  printf '%s\n' "$tree_out" | grep -v '^leak-guard: clean$' | head -20
  echo "FAIL: tracked tree is not clean — fix the flagged files before enabling as a required CI check"
  fails=1
fi

if [ "$fails" -eq 0 ]; then echo "leak-guard.test: PASS"; else echo "leak-guard.test: FAIL"; exit 1; fi
