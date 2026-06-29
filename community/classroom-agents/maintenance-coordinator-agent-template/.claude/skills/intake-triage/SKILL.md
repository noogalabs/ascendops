---
name: intake-triage
description: "Read an inbound tenant maintenance request, classify category and urgency, decide tenant-vs-owner responsibility, and propose routing. Platform-agnostic. Drafting only, any resident reply or dispatch is approval-gated."
---

# Intake Triage

{{agent_name}} uses this skill to turn a raw inbound maintenance request into a structured, routable ticket. {{agent_name}} reads what the tenant actually said and proposes a plan. It does not message the resident or dispatch a vendor on its own.

---

## Hard Gate

Any resident-facing reply and any vendor dispatch are external actions and require human approval. This skill triages and drafts only. A life-safety classification is escalated to a human immediately on the emergency path, it does not wait silently in a queue.

---

## Inputs

- The raw inbound request text (and any photos/video the tenant attached)
- Unit/property and tenant identity, if available from your property-management system
- Prior history on this unit/issue (repeat-issue signal)
- Configured troubleshooting depth (0 = just dispatch, up to 5 = exhaust the tree first)
- Configured tenant-vs-owner responsibility policy / lease terms, if available

---

## Workflow

1. Read the request and restate the actual problem in one line; do not infer beyond what was said.
2. Classify the category (plumbing, electrical, HVAC, appliance, structural, pest, cosmetic, access/lock, other).
3. Rank severity: emergency, high, medium, low, cosmetic, so the right SLA clock starts.
4. Life-safety check FIRST: gas smell, no heat in a freeze, active flooding, electrical hazard, sewage, carbon-monoxide, lockout in unsafe conditions. Any hit routes straight to the emergency path and escalates to a human.
5. Decide tenant-vs-owner responsibility from policy/lease; flag the genuinely unclear ones for a human rather than guessing.
6. Decide whether troubleshooting is worth a step (to the configured depth) before dispatch. Back off automatically for a frustrated, elderly, or repeat-issue tenant and lean toward dispatch.
7. Propose routing: troubleshoot-with-resident, dispatch to vendor type (handyman-first), or escalate. Hand a dispatch-bound ticket to vendor-coordination.
8. Draft the proposed resident acknowledgement and the proposed routing as approval items. Do not send.

---

## Output Contract

Return a triaged ticket with:
- one-line restated problem
- category
- severity with the SLA clock it starts
- life-safety flag (yes/no and why)
- tenant-vs-owner responsibility call, or `UNCLEAR, human decision`
- recommended troubleshooting depth and any first step to try
- proposed routing (vendor type or escalation)
- drafted resident acknowledgement, marked `APPROVAL REQUIRED`

---

## Validation

- Every request has a category and a severity.
- Life-safety triggers were checked before anything else.
- Responsibility is either decided with a cited basis or explicitly flagged unclear.
- No resident message was sent and no vendor was dispatched.
