---
name: skill-auto-discovery
effort: low
description: "After completing a complex task, check whether the sequence of steps used represents a recurring pattern worth codifying into a skill. Logs skill candidates to the bus for weekly review by the configured orchestrator."
triggers: ["skill candidate", "repeated pattern", "should this be a skill", "codify this", "skill discovery"]
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


# Skill Auto-Discovery

After any task that required 5+ tool calls or a non-obvious sequence of decisions, run this checklist. The goal is to catch repeating workflows before they calcify into tribal knowledge.

---

## When to Run

Run automatically after completing any task where:
- Total tool calls exceeded 5
- You made a non-trivial routing decision not covered by existing skills
- You handled an edge case by improvising (vs. following a defined rule)
- You found yourself repeating a sequence you've done before

Also runs as part of the weekly reflection scan (see self-evaluation-triage skill).

---

## Detection Checklist

Before logging a skill candidate, verify it meets at least 2 of these 4 criteria:

| # | Criterion | Check |
|---|-----------|-------|
| 1 | Same sequence of tool calls used 2+ times in the last 30 days | grep daily memory files for similar task patterns |
| 2 | Decision tree with 3+ branches applied manually more than once | was there a multi-step if/then that didn't map to any existing skill? |
| 3 | Vendor selection heuristic applied 3+ times without a written rule | did you pick a vendor based on unwritten knowledge? |
| 4 | Edge case handled outside any existing skill | something new happened and you figured it out on the fly |

If 0 or 1 criteria match: log nothing. Not every task needs a skill.

---

## Logging a Skill Candidate

When 2+ criteria match:

```bash
cortextos bus log-event quality skill_candidate info \
  --meta "{
    \"proposed_name\": \"<kebab-case-name>\",
    \"description\": \"<one sentence: what it does>\",
    \"trigger_tasks\": [\"<task_id_1>\", \"<task_id_2>\"],
    \"evidence\": \"<what pattern was observed>\",
    \"effort_estimate\": \"low|medium|high\",
    \"agent\": \"<your-agent>\"
  }"
```

Then write a one-line entry to today's memory file:
```markdown
- SKILL CANDIDATE: <proposed_name> — <description>. Evidence: <tasks>. Effort: <low/medium/high>
```

Do NOT build the skill yourself. the configured orchestrator reviews candidates weekly and decides what to build.

---

## Weekly Surface (runs as part of weekly reflection scan)

On Monday morning, pull all skill_candidate events from the past 7 days:

```bash
cortextos bus list-events --type quality --subtype skill_candidate --since 7d --format json
```

If any candidates exist, send a message to the configured orchestrator:

```bash
cortextos bus send-message "${CTX_ORCHESTRATOR_AGENT:?Configure the member orchestrator}" normal "Weekly skill candidates from <maintenance-agent>: <count> candidates logged this week. Top candidates: <list proposed_name + description for top 3>. Full list in activity log."
```

If no candidates: no message needed.

---

## What Makes a Good Skill

A skill candidate is worth building when:
- It would save >10 min of reasoning per occurrence
- It occurs at least 2–3x per week
- It has clear inputs and outputs
- It does not require <maintenance-owner>'s judgment to execute

A candidate is NOT worth building when:
- It's a one-off edge case
- It requires judgment that belongs to <maintenance-owner>
- An existing skill already covers it with minor extension

---

## Guardrails

- Never propose a skill that bypasses an approval workflow
- Never propose a skill that touches tenant personal data without explicit rules
- Candidates are suggestions only — the configured orchestrator decides whether to build
- Do not log the same pattern twice in one week

---

*Pair with self-evaluation-triage for post-meld reflection. Pair with the tasks skill for tracking what patterns produce the most backlog.*
