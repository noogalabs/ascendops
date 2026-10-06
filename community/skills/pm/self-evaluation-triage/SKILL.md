---
name: self-evaluation-triage
effort: low
description: "After every meld decision, capture what was decided and why (trajectory). Weekly: scan all trajectories for override patterns, surface refinement candidates to the configured orchestrator."
triggers: ["self evaluation", "reflect", "override review", "accuracy review", "refinement candidates", "post-meld review", "decision review"]
---
## Member Role Bindings

Before applying this skill, read the member organization configuration and bind
`<maintenance-owner>` to its escalation/approval owner and approved contact route,
`<maintenance-agent>` to its maintenance agent, and `<orchestrator-agent>` to its
coordinator. Use `CTX_ORCHESTRATOR_AGENT` for executable bus examples and
`CTX_AGENT_NAME` for the running agent's paths. Resolve vendor and in-house
technician placeholders from the same member configuration. If a required role
is missing or ambiguous, ask the configured coordinator before dispatch; never
substitute a person, agent or chat ID from an example. Existing emergency and
approval rules still govern actions.


# Self-Evaluation Triage

Two-part skill:
1. **Post-meld capture** — immediately after every meld decision, record the trajectory
2. **Weekly reflection scan** — every Monday, find override patterns and surface fixes

---

## Part 1: Post-Meld Trajectory Capture

Run immediately after every completed meld decision (after approval is created or a log-event fires).

### What to Capture

```bash
cortextos bus log-event quality triage_trajectory info \
  --meta "{
    \"meld_id\": \"<meld_id>\",
    \"meld_type\": \"<plumbing|hvac|electrical|handyman|pest|other>\",
    \"urgency_assigned\": \"emergency|high|normal|low\",
    \"vendor_recommended\": \"<vendor name or in-house>\",
    \"decision_summary\": \"<one sentence: what was recommended and why>\",
    \"outcome\": \"pending|resolved|overridden|cancelled\",
    \"override_detail\": \"<what <maintenance-owner> changed, or null if outcome=resolved>\"
  }"
```

**outcome** starts as `pending`. Update it when:
- Meld closes with vendor completing work → `resolved`
- <maintenance-owner> changes the vendor or urgency → `overridden` (fill override_detail)
- Meld cancelled by resident or <maintenance-owner> → `cancelled`

### When to Update Outcome

Check outcomes during morning-report cron. For any trajectory with `outcome=pending` where the meld is now closed in PM:

```bash
# Check meld status
python3 scripts/pm-get-comments.py <meld_id>
```

If closed/completed: update outcome via:
```bash
cortextos bus log-event quality triage_outcome_update info \
  --meta "{\"meld_id\": \"<meld_id>\", \"outcome\": \"resolved|overridden|cancelled\", \"override_detail\": \"<or null>\"}"
```

---

## Part 2: Weekly Reflection Scan

Runs every Monday at 06:00 ET (register with `cortextos bus add-cron <agent> self-evaluation-triage "0 6 * * 1" "Read and follow .claude/skills/pm/self-evaluation-triage/SKILL.md"` if not present). Also triggers on demand via `/reflect` or the configured orchestrator message.

### Step 1 — Pull All Trajectories

```bash
cortextos bus list-events --type quality --subtype triage_trajectory --since 7d --format json
```

### Step 2 — Identify Override Patterns

For each overridden trajectory:
- What was <maintenance-agent>'s recommendation?
- What did <maintenance-owner> change?
- Is this the 2nd or 3rd time <maintenance-owner> made the same correction?

Patterns to flag:
| Pattern | Threshold | Action |
|---------|-----------|--------|
| Same vendor swapped out | 2+ times same swap | Refinement candidate: update vendor preference in MEMORY.md |
| Urgency downgraded by <maintenance-owner> | 3+ times same meld type | Refinement candidate: recalibrate urgency rule for that type |
| Urgency upgraded by <maintenance-owner> | 2+ times | Refinement candidate: tighten habitability or safety keyword list |
| Scope underestimated | 2+ times same pattern | Refinement candidate: update planning-decompose common patterns |

### Step 3 — Surface Refinement Candidates to the configured orchestrator

```bash
cortextos bus send-message "${CTX_ORCHESTRATOR_AGENT:?Configure the member orchestrator}" normal "Weekly triage reflection — <maintenance-agent>. Decisions last 7 days: <total>. Overrides: <count>. Patterns: <list each pattern found>. Refinement candidates: <list proposed changes>. No action needed from you unless a change requires approval."
```

If no overrides in the past 7 days: send a brief confirmation only:
```bash
cortextos bus send-message "${CTX_ORCHESTRATOR_AGENT:?Configure the member orchestrator}" normal "Weekly triage reflection — <maintenance-agent>. 0 overrides in last 7 days. No refinement candidates."
```

---

## Confidence Calibration

Track confidence ratings from the copilot threshold log against actual outcomes:

- `high` confidence + `resolved` outcome → calibrated correctly
- `high` confidence + `overridden` outcome → overconfidence: review the meld type for blind spots
- `low` confidence + `resolved` outcome → calibrated correctly (appropriate uncertainty)
- `medium` confidence + `overridden` 3+ times same type → recalibrate: that type should be `low`

Include a calibration summary in the weekly the configured orchestrator message when 10+ trajectories have resolved outcomes.

---

## Guardrails

- Never update an outcome to `resolved` without checking PM for actual meld closure
- Never send a refinement candidate that bypasses an existing guardrail
- Reflection scan is observation only — no rule changes happen automatically
- If override pattern involves tenant safety (habitability upgrades), surface to the configured orchestrator immediately, don't wait for Monday

---

*Pairs with skill-auto-discovery (both run on Monday morning). Post-meld capture pairs with the copilot threshold log in pm-meld-triage.*
