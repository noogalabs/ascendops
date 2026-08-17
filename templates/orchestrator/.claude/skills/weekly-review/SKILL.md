---
name: weekly-review
description: "Weekly comprehensive synthesis. Run Sunday evening or when user requests. Reviews week's accomplishments across all agents, evaluates performance, plans next week."
triggers: ["weekly review", "weekly check-in", "end of week", "week summary", "run weekly review", "weekly briefing"]
---

# Weekly Review

> Comprehensive weekly check-in covering all agents' output, goals progress, orchestrator self-evaluation, and next-week planning.

**When:** Sunday evening (configured in cron) or when user requests.
**Duration:** ~15-30 minutes including user interaction.
**Output:** Memory log, actionable insights, next week plan.

---

## Phase 1: Data Aggregation

```bash
# All agent heartbeats
cortextos bus read-all-heartbeats

# All tasks this week
cortextos bus list-tasks
cortextos bus list-tasks --status completed

# This week's memory files (last 7 days)
for i in 0 1 2 3 4 5 6; do
  DATE=$(date -v-${i}d +%Y-%m-%d 2>/dev/null || date -d "$i days ago" +%Y-%m-%d)
  echo "=== $DATE ==="
  cat memory/${DATE}.md 2>/dev/null || echo "(no entry)"
done

# Goals and priorities
cat GOALS.md
cat $CTX_FRAMEWORK_ROOT/orgs/$CTX_ORG/goals.json

# Inbox
cortextos bus check-inbox
```

---

## Phase 1B: Forge Weekly-Heavy Build Assembly (MANDATORY)

Run the forge weekly-heavy hook before presenting the weekly review. This hook assembles the week's skill-drift candidates into specs and change-sets for your orchestrator/the owner gating; it does not auto-merge or runtime-activate anything.

Inputs:
- `forge_candidate` events logged during daily-light passes or instant-on-miss moments.
- `docs/ephemeral/forge-runs/candidates.md` if present.
- Any skill drift surfaced by the owner corrections, PR review loops, or under-fired skills this week.

**Plumbing guard:** if `$CTX_FRAMEWORK_ROOT/scripts/forge-candidates.mjs` does not exist (the forge plumbing has not landed in this runtime yet), write `FORGE WEEKLY BUILD: skipped (forge plumbing not deployed)` and skip the rest of 1B - do not error. Resume automatically once the plumbing is present.

Read the accumulated queue first - it merges the events since the last build marker with the pending run-log entries, deduped and grouped by create-vs-edit verdict:

```bash
node "$CTX_FRAMEWORK_ROOT/scripts/forge-candidates.mjs" queue
```

If the queue is empty, write `FORGE WEEKLY BUILD: queue empty - no build` and skip the rest of 1B. Otherwise invoke the forge skill in build mode:

```
/forge --build
```

Gate every spec'd skill in the change-set through the combined load gate (real-YAML parse + discoverable + ship features + references resolve from the target home; the trigger-fire smoke stays manual in the target agent's context). Pass `--target-home` as the skill's OWN tracked source home (its role-template `.claude/skills` dir, or `community/skills` for a shareable skill) - NOT the repo root: the reference check resolves names relative to that home, so the repo root would false-green a ref that exists anywhere in the monorepo but is absent from the skill's actual home:

```bash
node "$CTX_FRAMEWORK_ROOT/scripts/forge-load-gate.mjs" <skill-dir> --target-home "<the skill's tracked source home, e.g. templates/<role>/.claude/skills or community/skills>"
```

Do not consume at planning start, test-only RED, or when only one tracked repository is ready. Archive the queue only after every tracked change-set is assembled, all required population/load gates are green, and all PR URLs plus receipts are attached to the build record:

```bash
node "$CTX_FRAMEWORK_ROOT/scripts/forge-candidates.mjs" consume --build-id "build-$(date -u +%Y-%m-%d)"
```

Output a `FORGE WEEKLY BUILD` section with:
- `SKILLS TO SHIP` - new skill specs ready for source PR.
- `SKILLS TO SHARPEN` - existing skills with proposed diffs.
- `SKIP / WATCHLIST` - candidates that are not yet proven by a real incident or should wait.
- For every item: tied incident, proposed hard rule, tracked source home, runtime activation target, validation gate, and dev-side owner.

Hard stop: do not merge, edit live runtime, or auto-activate from this weekly hook. The weekly hook produces the spec/change-set for the gate; dev-side implementation and two-step registration happen only after approval.

---

## Phase 1C: Pending Skill-Audit Diff Triage — Apply Loop (MANDATORY, added 2026-07-01, Tip 1 P1)

Every skill-optimizer run writes a `*-diff.patch` that historically piled up unapplied (23 audits, 2 applied as of 2026-07-01). This phase closes the loop: every pending diff gets an explicit verdict every week. Zero PENDING rows may survive this phase — every enumerated skill ends the review as APPLIED, REJECTED, or DAVID-GATE (surfaced in Phase 2 with an explicit ask).

### 1C-1: Enumerate pending diffs (fleet-wide)

```bash
cd "$CTX_FRAMEWORK_ROOT"
SUBJECTS=$(mktemp)
if ! node scripts/fleet-population.mjs paths \
  --registry "orgs/$CTX_ORG/fleet-population.json" \
  --root "orgs/$CTX_ORG" --population "$CTX_ORG.agents" --format json > "$SUBJECTS"; then
  cat "$SUBJECTS" >&2
  exit 1
fi
cat "$SUBJECTS"
tail -n 1 "$SUBJECTS" | jq -r '.targets[].path' | while IFS= read -r subject_root; do
for dir in "$subject_root"/skill-improvement/*/; do
  [ -f "${dir}history.json" ] || continue
  skill=$(basename "$dir")
  agent=$(basename "$subject_root")
  latest_diff=$(ls "$dir" 2>/dev/null | grep -E '^[0-9]{4}-[0-9]{2}-[0-9]{2}(-[0-9]{2})?-diff\.patch$' | sort | tail -1)
  [ -n "$latest_diff" ] || continue
  resolved=$(jq -r '[.runs[] | select((.diff_applied // false) or (.diff_rejected // false) or (.superseded // false))] | length' "${dir}history.json")
  total=$(jq -r '.runs | length' "${dir}history.json")
  [ $((total - resolved)) -gt 0 ] && echo "PENDING agent=$agent skill=$skill latest=${dir}${latest_diff} unresolved_runs=$((total - resolved))"
done
done
```

### 1C-2: Triage each PENDING skill (latest diff only — older diffs are superseded)

Read the latest `*-analysis.md` + `*-diff.patch` for each PENDING skill. Verdict rules, in order:
- **REJECT** if: `patch --dry-run` fails against the current SKILL.md (stale diff), OR the change contradicts a locked David policy, OR the recommended text already exists in the skill.
- **APPLY** (no David gate) if: wording/clarity fix, fixes a factually wrong command or path, or adds a step already mandated elsewhere in protocol.
- **DAVID-GATE** if: it changes agent behavior (new mandatory step, removed step, changed trigger/threshold, anything touching external actions). Surface in the Phase 2 SKILL AUDIT section; apply only on David's go.
- If the latest run in history.json is already resolved but older runs are not: no triage needed — run only the superseded-marking command in 1C-5 and move on.

### 1C-3: Apply accepted diffs — template-first + cascade (never per-agent-copy-only)

Resolve the CANONICAL home for the skill in this exact order (first match wins):
1. `scripts/skill-mirrors.json` has an entry for the skill → use its `canonical` path.
2. The org registry binding names `shared-skills/<skill>/` → that tracked org canonical.
3. An accepted audit designates exactly one target returned by a named population.
4. None of the above → stop for a registry/binding decision. Never use a path glob or audited copy as an implicit population.

Before patching, obtain every applicable receipt. Keep the printed receipts in the triage row and take targets only from each final JSON line. Any nonzero result is a hard stop before content or history changes.

```bash
SKILL=<skill>; DIFF=<path-to-latest-diff.patch>; CANON=<canonical-dir-from-rules-above>
FRAMEWORK_TARGETS=$(mktemp); ORG_TARGETS=$(mktemp)
if ! node scripts/fleet-population.mjs paths \
  --registry scripts/fleet-populations.json --root . \
  --population framework.skill-templates --skill "$SKILL" --format json > "$FRAMEWORK_TARGETS"; then
  cat "$FRAMEWORK_TARGETS" >&2; exit 1
fi
cat "$FRAMEWORK_TARGETS"
if ! node scripts/fleet-population.mjs paths \
  --registry "orgs/$CTX_ORG/fleet-population.json" --root "orgs/$CTX_ORG" \
  --population "$CTX_ORG.agents" --skill "$SKILL" --format json > "$ORG_TARGETS"; then
  cat "$ORG_TARGETS" >&2; exit 1
fi
cat "$ORG_TARGETS"
patch --dry-run -u "$CANON/SKILL.md" < "$DIFF" && patch -u "$CANON/SKILL.md" < "$DIFF"

# Cascade only to registry-returned targets; never reconstruct a subject list.
for receipt in "$FRAMEWORK_TARGETS" "$ORG_TARGETS"; do
tail -n 1 "$receipt" | jq -r '.targets[].path' | while IFS= read -r target; do
  copy="$target/SKILL.md"
  [ -L "$target" ] && continue
  [ "$copy" -ef "$CANON/SKILL.md" ] && continue
  if patch --dry-run -u "$copy" < "$DIFF" >/dev/null 2>&1; then
    patch -u "$copy" < "$DIFF"; echo "CASCADED: $copy"
  else
    echo "CONFLICT (intentional divergence or drift — manual follow-up): $copy"
  fi
done
done
```

### 1C-4: One PR per accepted skill

```bash
cortextos bus create-skill-audit-pr "$SKILL"
```

This refuses branch/stage work unless the changed set exactly covers targets returned by a named population or the skill's explicit `skill-mirrors.json` group. The org tree is a separate tracked repository requiring its own reviewed change-set; it is not an untracked live side effect. PR execution/merge belongs to an agent per standing policy.

### 1C-4b: Version the orgs-side copies (nested repo)

The canonical shared-skills change and any patched per-agent copies belong to the separately tracked orgs repository. Stage only paths returned by its green receipt:

```bash
( cd orgs && git add --pathspec-from-file=<org-registry-returned-pathspec-file> && \
  git commit -m "skill-audit: apply $SKILL audit diff to registered org targets" )
```

Same gate as the framework PR — do not push the orgs commit without the same sign-off.

### 1C-5: Mark history.json (the flag the flywheel reads)

```bash
HIST=orgs/$CTX_ORG/agents/<agent>/skill-improvement/$SKILL/history.json
# APPLIED (latest run):
jq --arg ts "$(date -u +%Y-%m-%dT%H:%MZ)" --arg pr "<pr-url-or-manual>" --arg to "<canonical SKILL.md path>" \
  '.runs[-1] += {"diff_applied": true, "applied_at": $ts, "applied_to": $to, "pr": $pr}' \
  "$HIST" > /tmp/hist.tmp && mv /tmp/hist.tmp "$HIST"
# REJECTED (latest run):
jq --arg r "<one-line reason>" '.runs[-1] += {"diff_rejected": true, "reject_reason": $r}' \
  "$HIST" > /tmp/hist.tmp && mv /tmp/hist.tmp "$HIST"
# ALWAYS: mark all older unresolved runs superseded
jq '.runs[:-1] |= map(if ((.diff_applied // false) or (.diff_rejected // false) or (.superseded // false)) then . else . + {"superseded": true} end)' \
  "$HIST" > /tmp/hist.tmp && mv /tmp/hist.tmp "$HIST"
```

### 1C-6: Report

Add a triage table to the Phase 2 SKILL AUDIT section: `| Agent/Skill | Verdict | Applied to | Cascade | PR |` — one row per PENDING skill from 1C-1. Then:

```bash
cortextos bus log-event action workflow_completed info --meta '{"workflow":"skill_audit_diff_triage","applied":N,"rejected":N,"gated":N}'
```

---

## Phase 2: Present Review to User

Format into a comprehensive review and send as chunked Telegram messages:

```bash
cortextos bus send-telegram $CTX_TELEGRAM_CHAT_ID "<message chunk>"
```

### Review Template

```markdown
# Weekly Review - Week of [DATE]

---

## AGENT PERFORMANCE

| Agent | Status | Tasks Completed | Key Wins | Issues |
|-------|--------|----------------|----------|--------|
| [agent] | [heartbeat age] | X | [wins] | [gaps] |

Fleet Health:
- Agents online: X/N
- Agents stale (>5h): [list]
- Coordination events this week: X

---

## PRODUCTIVITY

Tasks this week (all agents combined):
- Completed: X
- In progress: Y
- Blocked: Z

Overnight work:
- Tasks dispatched: X
- Tasks completed: X

---

## GOALS PROGRESS

| Goal | Progress | Status |
|------|----------|--------|
| [north star goal] | [qualitative progress] | [on track / behind / blocked] |

---

## ORCHESTRATOR SELF-EVALUATION

| Dimension | Score (1-10) | Notes |
|-----------|-------------|-------|
| Usefulness | X | [why] |
| Proactivity | X | [why] |
| Coordination | X | [why] |
| Communication | X | [why] |
| Learning | X | [why] |
| **Total** | X/50 | |

What went well: [bullets]
What to improve: [bullets]
Key learnings: [bullets]

---

## SYSTEM IMPROVEMENT PROPOSALS

Based on this week's patterns:

[P1] [Category]: [Name]
- Problem observed: [specific pattern]
- Proposed solution: [concrete action]
- Assign to: [agent]
- Expected impact: [what changes]

[P2] ...

Agent gaps (capabilities needed):
- Missing: [capability]
- Proposed: [new skill or new agent]

---

## NEXT WEEK

Top priorities:
1. [priority]
2. [priority]
3. [priority]

Agent focus next week:
- [agent]: [priority work]

System improvements queued:
- [improvement 1]
- [improvement 2]
```

---

## Phase 3: Interactive Discussion

After sending the review, ask the user:
1. What went well this week in your view?
2. What was challenging or frustrating?
3. Any changes to priorities for next week?
4. Any new agents or capabilities needed?

---

## Phase 4: Update State

```bash
# Log event
cortextos bus log-event action briefing_sent info --meta '{"type":"weekly_review"}'

# Update heartbeat
cortextos bus update-heartbeat "weekly review complete - next week planned"

# Write to memory
TODAY=$(date -u +%Y-%m-%d)
cat >> "memory/$TODAY.md" << MEMEOF

## Weekly Review - $(date -u +%H:%M:%S)

### Summary
- Total tasks completed this week: X (all agents)
- Agents active: X/N
- Self-eval total: X/50
- Top priorities next week: [list]

### Key Insights
- [insight 1]
- [insight 2]

### System Improvements Queued
- [improvement 1]
MEMEOF

# Update MEMORY.md with persistent learnings
# Add any new patterns, preferences, or system behaviors discovered this week
```

---

## Custom Metrics

<!-- Added during onboarding - user-specific tracking preferences -->
<!-- Format: add bullet points below, each with the metric name and how to measure it -->

<!-- Example:
- **Platform MRR**: screenshot from your SaaS platform settings, extract MRR number
- **GitHub PRs merged this week**: gh pr list --state merged --json mergedAt | count those in last 7 days
- **Content pieces published**: count from alex agent completed tasks tagged content
-->

---

## Manual Trigger

```
"Run weekly review" → read .claude/skills/weekly-review/SKILL.md and execute
```

---

*This is the single source of truth for weekly review.*
