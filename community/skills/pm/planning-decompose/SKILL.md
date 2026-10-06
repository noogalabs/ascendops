---
name: planning-decompose
effort: medium
description: "When a meld contains multiple interdependent or multi-trade work items, decompose it into parallel and sequential workstreams before acting. Prevents dispatching trade A before trade B's prerequisite work is done."
triggers: ["complex meld", "multiple trades", "multi-step repair", "sequential work", "decompose", "planning"]
---

# Planning Decompose

Use this skill when a meld describes more than one problem, involves multiple trades, or has sequential dependencies. Do not dispatch anything until the workstream map is built.

---

## When to Invoke

Invoke automatically when a meld description or thread contains ANY of:
- Two or more trade keywords (plumbing + flooring, HVAC + electrical, etc.)
- Language implying sequence ("once the leak is fixed, then...", "after demo...")
- Unknown scope requiring diagnosis before dispatch
- Multiple rooms or units affected

---

## Step 1 — Read the Full Thread

```bash
python3 scripts/pm-get-comments.py <meld_id>
```

Never decompose from the subject line. Read the thread.

---

## Step 2 — Identify Workstreams

For each distinct problem in the meld:

| Stream | Trade | Independent or Sequential? | Gate Condition |
|--------|-------|----------------------------|----------------|
| A | e.g., Plumbing | Gate for B | Leak must be fixed first |
| B | e.g., Flooring | Sequential after A | Cannot replace floor until dry |
| C | e.g., Painting | Sequential after B | Cannot paint until floor is in |

**Independent:** can be dispatched simultaneously  
**Sequential:** must wait for a prior stream to complete — name the gate condition explicitly

---

## Step 3 — Classify Each Stream

For each stream, determine:
- **Trade**: which vendor category handles it
- **Urgency**: Emergency / High / Normal / Low (see pm-meld-triage for definitions)
- **Vendor**: recommended vendor (or "unknown — diagnosis needed first")
- **Blocking**: which other streams, if any, this stream must complete before

---

## Step 4 — Surface the Plan to David

Format the plan as a numbered list. Do NOT send a wall of text. One line per stream:

```
Meld <id> — <address> — multi-stream:

1. [URGENT] Plumbing (Example Plumbing) — stop active leak → gates Stream 2
2. [Normal] Flooring (<configured-flooring-vendor>) — replace damaged subfloor → wait for Stream 1 completion + dry-out (est. 48–72h)
3. [Low] Painting (in-house: Alex) — touch-up after flooring complete

Recommend: dispatch Stream 1 today. Hold Streams 2–3 until leak confirmed dry.
```

Then create an approval if dispatch is needed, per the approvals skill.

---

## Step 5 — Track Gates in Daily Memory

For any sequential stream with a pending gate condition, log the gate in today's memory file:

```markdown
## Gated Workstream: Meld <id>
- Stream 2 (Flooring) blocked until: Stream 1 (plumbing) closed + 48h dry-out confirmed
- Check date: <today + 3 days>
```

On each heartbeat, check if any gated stream's condition has been met.

---

## Common Multi-Trade Patterns

| Pattern | Streams | Dispatch order |
|---------|---------|---------------|
| Water intrusion + floor damage | Plumbing → Flooring → Paint | Sequential |
| HVAC + pest (unrelated) | HVAC / Pest | Independent — dispatch simultaneously |
| Electrical + HVAC (shared breaker issue) | Electrical diagnosis first → HVAC | Sequential |
| Make-ready unit turnover | Cleaning + Paint + Flooring + Appliance check | Independent except appliance = last |
| Sewer backup + flooring + mold risk | Plumbing → Mold test → Flooring | Sequential, flag mold as High |

---

## Guardrails

- Never dispatch a downstream trade before its gate condition is confirmed met
- If scope is truly unknown (e.g., "everything is broken"), schedule a diagnosis visit first — do not dispatch multiple trades blind
- If the resident describes a safety risk in any stream, that stream overrides the plan and routes through habitability override in pm-meld-triage

---

*Use this skill before pm-meld-triage when the meld has multiple items. After decomposing, run each stream through pm-meld-triage individually.*
