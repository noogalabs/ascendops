---
name: fair-housing-guard
description: "Pre-send compliance pass for anything touching an applicant or resident. Flags protected-class language, steering, inconsistent treatment, and disparate-impact risk, and proposes compliant rewrites. Advisory only; surfaces risks for a human, does not send. Not legal advice."
---

# Fair Housing Guard

{{agent_name}} uses this skill as the pre-send checkpoint for any draft message, listing copy, screening criterion, or leasing decision that touches an applicant or resident. It reads the full item in context, flags risk, explains why, and proposes a compliant rewrite that keeps the legitimate intent. It surfaces; it does not send.

---

## Hard Gate

This skill is advisory and is not legal advice. It surfaces risks for a human to judge; it never sends anything. Anything needing legal judgment, disparate-impact risk, criminal-history policy, an unusual decline, routes up to a human. Local and state rules add protected classes beyond the federal list, so a human confirms the rule set that actually applies before the item goes out.

Wire this in as the pre-send pass on any applicant- or resident-facing comms, and run screening criteria through it before they are used.

---

## Inputs

- The full item in context: a draft message, listing copy, a screening criterion, or a leasing decision
- The applicable jurisdiction's protected-class list, as confirmed by a human (federal plus any state/local additions)

---

## Workflow

1. Read the full item in context.
2. Scan against five categories:
   - protected-class language, including soft phrasing ("perfect for a single professional", "great family neighborhood")
   - steering
   - inconsistent treatment
   - disparate-impact risk
   - unsafe phrasing generally
3. For each hit, record the exact text, the category, the risk, and a severity.
4. Propose a rewrite that describes features and objective criteria, never the kind of person who should apply.
5. Route anything needing legal judgment (disparate impact, criminal-history policy, an unusual decline) up to a human.
6. Surface the findings and rewrites. Do not send.

---

## Output Contract

Return:
- per-flag table: exact text, category, risk, severity
- proposed compliant rewrite for each flag
- items routed to a human for legal judgment
- a note confirming the applicable protected-class rule set was set by a human
- overall advisory verdict, with the reminder that this is not legal advice

---

## Validation

- Every flag cites the exact text, category, and severity.
- Each rewrite describes features and objective criteria, not the kind of applicant.
- Legal-judgment items are routed to a human, not decided here.
- Nothing was sent.
