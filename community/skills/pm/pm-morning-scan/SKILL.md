---
name: pm-morning-scan
effort: medium
description: "Morning meld review workflow. Pull all open melds, apply triage rules, check threads for genuinely unhandled items, surface only what needs action."
triggers: ["morning scan", "morning meld review", "run morning scan", "check open melds", "what needs attention"]
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


# PM Morning Scan

> Run once per morning before the 07:30 briefing. Output goes to the configured orchestrator, not <maintenance-owner> directly (unless emergency).

---

## When to Run

Triggered by morning cron at 06:30 ET, or manually on demand. Results feed the configured orchestrator's 07:30 morning review.

---

## Step 1: Pull All Open Melds

```bash
python3 scripts/pm-read-melds.py --all-open
```

Or via hash poller for change-delta only:

```bash
python3 scripts/pm-hash-poll.py
```

Prefer `pm-read-melds.py --all-open` for the morning scan — you want the full picture, not just changes since last poll.

Cap: script returns up to 100 melds. If portfolio exceeds 100 open melds, note this in the report.

---

## Step 2: Filter to Candidates

From the full list, keep only melds that meet at least one condition:

| Condition | Threshold |
|-----------|-----------|
| No vendor assigned | Any age |
| Emergency status | Any age |
| High priority, no scheduled date | Any age |
| Same status for >48h (normal) | Stale |
| Same status for >24h (high) | Stale |
| Last comment >24h old, no vendor | Needs follow-up |
| Make-ready with move-in <5 days | Urgent |

Skip melds that have:
- Vendor assigned AND scheduled date set
- A configured staff member's note or maintenance agent comment within last 6h
- Pest control classification with vendor search open

---

## Step 3: Check Threads on Candidates

For each candidate meld, run pm-check-meld:

```bash
python3 scripts/pm-get-comments.py <meld_id>
```

After reading thread, classify with pm-meld-triage rules:
- Is it actually unhandled, or does the thread show it's in progress?
- Designated property contact in member routing configuration? → route to that contact; ask the configured coordinator if routing is missing or ambiguous
- Habitability override condition? → escalate immediately, don't wait for report

Discard any candidate where thread reveals it is already actively managed.

---

## Step 4: Build the Report

For each genuinely unhandled meld, produce one line:

```
[PRIORITY] Meld <id> — <property address> — <issue type> — <age> — <why flagged>
```

Example:
```
[HIGH] Meld 18234 — 412 Elm St Unit 3 — No heat — 31h open — No vendor, high priority
[NORMAL] Meld 18190 — 88 Oak Ave — Leak under sink — 52h stale — Same status >48h
[NORMAL] Meld 18201 — 904 River Rd — Pest control — SUPPRESSED (vendor search open)
```

Group by priority: Emergency → High → Normal → Low.

---

## Step 5: Send to the configured orchestrator

```bash
cortextos bus send-message "${CTX_ORCHESTRATOR_AGENT:?Configure the member orchestrator}" normal "Morning Meld Scan — $(date +%Y-%m-%d)

Open melds reviewed: <total>
Flagged for action: <N>

<report lines>

Designated-contact items (routed per member configuration): <count>
Emergencies: <count or 'none'>
---
Ready for dispatch decisions."
```

If zero items flagged:
```bash
cortextos bus send-message "${CTX_ORCHESTRATOR_AGENT:?Configure the member orchestrator}" normal "Morning Meld Scan — $(date +%Y-%m-%d): All <N> open melds accounted for. No unhandled items."
```

---

## Step 6: Log Escalation Outcomes (the configured orchestrator Cycle 7)

For each meld that was escalated in a **previous** scan and now has a confirmed resolution (status changed, vendor assigned, owner/coordinator/configured staff member acted), append one JSON line to the outcomes surface:

```bash
OUTCOME_FILE="${CTX_ROOT}/orgs/${CTX_ORG}/agents/${CTX_AGENT_NAME}/experiments/surfaces/maintenance-quality-outcomes.jsonl"

echo '{"timestamp":"'$(date -u +%Y-%m-%dT%H:%M:%SZ)'","escalation_id":"<meld_id>","outcome_type":"acted_as_recommended","surface":"morning_scan","actor":"<maintenance-owner>","resolution_time_minutes":null,"notes":"<brief context>"}' >> $OUTCOME_FILE
```

**outcome_type values:** `acted_as_recommended` | `modified` | `dismissed`

Only log confirmed outcomes — skip melds still pending or with unknown resolution. Schema: `your org internal docs`

---

## Step 7: Log and Update Heartbeat

```bash
cortextos bus log-event action morning_scan_complete info \
  --meta '{"melds_reviewed":<total>,"flagged":<N>,"emergencies":<E>,"outcomes_logged":<O>}'

cortextos bus update-heartbeat "morning scan complete — <N> melds flagged"
```

---

## Emergencies: Don't Wait for the Report

If at any point during Steps 1–3 you find a meld meeting a habitability override condition (see pm-meld-triage), message <maintenance-owner> on Telegram immediately — do not batch it into the 06:30 report.

```bash
cortextos bus send-telegram $CTX_TELEGRAM_CHAT_ID "URGENT: <meld_id> — <condition>. <property>. Action needed now."
```

---

## Self-Check Before Sending

Before sending the report to the configured orchestrator, verify:

- [ ] Did I read the thread for every flagged meld (not just the title)?
- [ ] Did I suppress pest control melds with open vendor searches?
- [ ] Did I apply the member-configured property routing and resolve any missing or ambiguous contact before dispatch?
- [ ] Are zero genuinely-handled melds in the flagged list?
- [ ] Did any habitability conditions get caught and escalated already?

---

*Completeness check: if you can answer yes to all five, send the report.*
