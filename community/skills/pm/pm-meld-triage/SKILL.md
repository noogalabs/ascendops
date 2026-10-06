---
name: pm-meld-triage
effort: low
description: "Triage rules playbook for Property Meld work orders. Determines urgency, routing, and suppression rules before any action is taken."
triggers: ["triage meld", "classify meld", "triage rules", "how urgent", "should I escalate"]
---

# PM Meld Triage Playbook

> Compressed operational reference. Read the message thread first — never triage from subject line alone.

## Email Processing Rule (Critical)

**New work orders** (same-day emails, fresh meld submissions): Triage immediately — read the meld, classify urgency, post a PM message or alert David as needed. **Never bulk-label and queue a fresh work order.**

**Old notification emails** (historical backlog, activity on existing melds, same-day notifications for melds you've already processed): Apply the label configured by `config.gmail_watch.processed_label_id` and mark read. The matching `gmail_watch.query` must include `-label:<processed-label-name>`. No triage required.

**How to distinguish**: Check the email date. Same-day = immediate triage. Older = bulk label.

---

## Step 0: Always Read the Thread First

Before classifying any meld, pull comments:

```bash
python3 scripts/pm-get-comments.py <meld_id>
```

A meld that looks unhandled from the subject may already have a vendor reply, scheduled appointment, or staff note in the thread. **Triage on thread state, not title.**

---

## Urgency Classification

| Level | Definition | Response |
|-------|-----------|----------|
| **Emergency** | Active safety/habitability threat | Telegram David immediately, any hour |
| **High** | No heat, sewage, lock-out, water intrusion | Escalate to an agent during day hours; wake David only if containment risk |
| **Normal** | Routine repair, appliance, cosmetic | Standard dispatch, SLA applies |
| **Low** | Cosmetic, non-functional (e.g. paint, landscaping) | Batch in next morning scan |

---

## Routing Rules

### Configured Property Routing → Designated Contact
Consult the member-maintained property routing configuration before dispatch. If the property has a designated contact, route to that contact. If routing is missing or ambiguous, ask the configured coordinator before dispatch; do not infer a contact from an area name.

```
→ cortextos bus send-message <configured-coordinator-agent> normal "Meld <id> — designated property contact <configured-contact>; routing per member configuration"
```

### Standard Portfolio → Vendor Dispatch
All other melds follow normal vendor assignment flow.

---

## Suppression Rules

### Pest Control
Suppress pest control meld alerts **while a vendor search is open** for that meld.
- Check: does the meld have a `vendor_assigned: null` and a pending vendor search event?
- If yes: do not ping an agent. The search is already in flight.
- If vendor search has been open >48h with no assignment: apply RULE_R1 (see meld-ops).

### Routine Follow-ups
Do not re-alert on a meld that has:
- An assigned vendor AND a scheduled date
- A configured staff member's note marked "handled" or "scheduled"
- A comment from Blue within the last 6h

---

## Habitability Override

The following conditions **bypass all suppression rules** and escalate immediately:

- No heat when outdoor temp is at or below 40°F
- Active water leak with structural or unit spread risk
- No hot water >24h
- Gas smell or suspected leak
- Lock-out (tenant cannot enter unit)
- Fire or smoke (call 911 first, then David)

**Override action:**
```bash
cortextos bus send-telegram $CTX_TELEGRAM_CHAT_ID "URGENT: <meld_id> — <condition>. <property>. Immediate action needed."
```

---

## Tenant SLA Targets

| Priority | First Response | Resolution Target |
|----------|---------------|-------------------|
| Emergency | Immediate | 4h vendor on-site |
| High | 2h | 24h |
| Normal | 24h | 5 business days |
| Low | 72h | 14 days |

SLA clock starts from meld open timestamp, not from Blue's detection.

---

## Age-Based Escalation Thresholds (Property Meld benchmarks)

Apply to any open meld regardless of priority, measured from meld open timestamp:

| Age | Flag | Action |
|-----|------|--------|
| ≥ 4 days open | **Approaching critical** | Include in morning scan report with age. Message an agent if no vendor assigned. |
| ≥ 5.5 days open | **Critical threshold** | Flag prominently in report. Message an agent immediately regardless of time of day. Resident churn risk is active at this point. |

**Why 5.5 days:** Property Meld data shows that repairs exceeding 5.5 days drive the probability of a positive resident review to near zero. 46% of move-outs cite maintenance as a factor.

**4-day early warning** leaves response time to assign, schedule, and complete before hitting the critical threshold.

---

## Water Intrusion Containment Protocol

If meld description mentions: leak, flood, water coming in, ceiling drip, pipe burst, or toilet overflow:

1. Classify as **High** minimum (Emergency if active/spreading)
2. Pull thread immediately — check if tenant has already isolated source
3. If no isolation confirmed: message an agent to call tenant for containment steps
4. Flag for same-day vendor regardless of day/hour

---

## Make-Ready Urgency

Make-ready melds (unit turnover prep) are time-sensitive when:
- Move-in date is within 5 days
- Lease is already signed

Treat as **High** urgency. Use the member-configured designated property contact when present; otherwise escalate to the configured coordinator with the move-in date.

---

## Decision Tree (quick reference)

```
Read thread
  → Already handled (vendor assigned + date set)?  → Log only, no action
  → Designated contact in property routing?        → Route to configured contact
  → Habitability override condition?               → Telegram David immediately
  → Pest control + vendor search open?             → Suppress alert
  → Age ≥ 5.5 days?                               → Critical flag, message an agent immediately
  → Age ≥ 4 days?                                 → Approaching critical, include in report
  → Emergency priority + no vendor 4h+?            → RULE_R2: Telegram David
  → High priority?                                 → Message an agent (day hours only)
  → Normal/Low?                                    → Standard dispatch or batch
```

---

## Copilot Threshold Logging (MANDATORY)

Before sending any recommendation to David for approval, log the decision with a full reasoning trace:

```bash
cortextos bus log-event quality blue_decision_presented info \
  --meta "{
    \"category\": \"<category>\",
    \"meld_id\": \"<meld_id>\",
    \"recommendation\": \"<one-line summary>\",
    \"safety_keywords\": [\"<keyword1>\", \"<keyword2>\"],
    \"decision_path\": [\"<rule1>:<result>\", \"<rule2>:<result>\"],
    \"confidence\": \"high|medium|low\",
    \"confidence_reason\": \"<brief reason>\"
  }"
```

### Field Definitions

**safety_keywords** — list every safety-related word found in the meld description or thread. If none: `[]`.  
Examples: `["leak", "flooding"]`, `["no heat", "40F outside"]`, `["gas smell"]`

**decision_path** — ordered list of rules checked, each as `"rule:outcome"`.  
Standard path:
```
"habitability_override:no|yes"
"configured_property_route:none|designated|unresolved"
"pest_control_suppressed:no|yes"
"age_days:<N>"
"age_flag:none|approaching_critical|critical"
"priority:emergency|high|normal|low"
"vendor_available:yes|no"
```
Stop the path at the first rule that terminates the decision (e.g., if habitability_override:yes, no need to log further rules).

**confidence** — how certain Blue is about the recommendation:
- `high` — clear match to existing rules, no ambiguity
- `medium` — rule applies but some unknown (vendor availability, scope unclear)
- `low` — novel situation, significant unknowns, or conflicting signals

**confidence_reason** — one sentence explaining confidence level. Examples:  
`"Trade is clear, vendor is known and available"`  
`"Scope is unclear — resident described it vaguely, may need diagnosis visit first"`  
`"Two rules conflict: meld age is 3 days (normal) but description mentions possible water intrusion (high)"`

### Category Mapping
- Dispatching in-house tech → `inhouse_dispatch`
- Dispatching known vendor → `known_vendor_dispatch`
- Dispatching new/untested vendor → `new_vendor_assignment`
- Lock change → `lock_change`
- Messaging resident → `resident_comms`
- Closing/canceling meld → `meld_closure`
- Emergency dispatch → `emergency_dispatch`

**Log first, send recommendation second.** Skipping this means the decision is invisible to an agent and your accuracy score never accumulates.

---

---

## Tenant Follow-Up Escalation Ladder (3-Day Rule)

When a meld is awaiting tenant response (photos, troubleshooting answers) and no vendor is assigned:

| Day | Action | Notes |
|-----|--------|-------|
| Day 1 | Send PM message requesting photos/response | Standard intake SOP |
| Day 2 | Send second PM follow-up | Substitute for SMS until A2P available |
| Day 3 | Send third PM follow-up, then escalate to David regardless of response | Surface to David as needing direct involvement |
| Day 4+ | David's direct involvement required | Do not continue self-resolving |

**Tracking:** Log first contact date in daily memory. Check elapsed days on each heartbeat/morning scan.

**Future upgrades (automatic when available):**
- When A2P SMS is live: Day 2 becomes an outbound text instead of PM message
- When calling is available: Day 3 becomes a phone call instead of PM message

**Apply to:** Any PENDING_ASSIGNMENT meld where Blue sent the initial photo/response request and tenant has not replied.

---

*Single source of truth for triage decisions. Do not apply rules without reading the thread first.*
