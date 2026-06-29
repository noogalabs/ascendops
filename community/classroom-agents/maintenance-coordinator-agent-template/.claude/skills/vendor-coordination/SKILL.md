---
name: vendor-coordination
description: "Run vendor dispatch with follow-through: pick the right vendor, confirm the window before telling the resident, track acceptance and SLA clocks, and verify the work against the original complaint before close-out. Every outward message is approval-gated."
---

# Vendor Coordination

{{agent_name}} uses this skill for the hard half of a maintenance job: not just hand-off, but follow-through. Dispatching is easy. This skill enforces that the vendor said yes, has a confirmed window, showed up, did the real work, and that it was verified before anyone is told the problem is solved.

---

## Hard Gate

Vendor dispatch, any vendor-facing message, any resident-facing message, and any PO/quote approval are external/spend actions and require human approval. {{agent_name}} drafts them; a human releases them.

**Vendor-before-resident:** confirm with the vendor and get a real appointment window BEFORE you promise the resident any time. A silent vendor is not an accepted vendor, never tell the resident a job is scheduled until the vendor has confirmed.

---

## Inputs

- The triaged ticket (category, severity, responsibility) from intake-triage
- Unit, access details, and tenant contact from your property-management system
- Photos or findings, when available
- Vendor roster with trade types and the handyman-first default
- Configured SLA windows (response clock, completion clock) per severity
- Spend threshold above which a quote/PO needs approval

---

## Workflow

1. Select the vendor: handyman-first; escalate to a licensed specialist or emergency vendor only when the work demands it (serious electrical, gas, structural, or a true emergency).
2. Draft the vendor dispatch (scope, unit, access, severity, photos) and route it for approval. Do not dispatch unattended.
3. On approval, track acceptance: a silent vendor is not accepted. Chase until the vendor confirms a real window.
4. Only after the vendor confirms the window, draft the resident message with that window and route it for approval. Never promise a time first.
5. If the job needs a quote/PO above threshold, draft it and route a PO/quote approval before work proceeds.
6. Watch the response and completion clocks; flag and draft escalations on SLA breaches.
7. Close the loop: verify the work against the ORIGINAL complaint with evidence (photo, verified result, or tenant confirmation). Do not close on "looks done" or "the vendor said so." If unverified, keep it open and flag.

---

## Output Contract

Return:
- selected vendor and why (handyman-first / escalation reason)
- drafted vendor dispatch, marked `APPROVAL REQUIRED`
- vendor acceptance + confirmed window status
- drafted resident message (only after window confirmed), marked `APPROVAL REQUIRED`
- any PO/quote draft, marked `APPROVAL REQUIRED`
- SLA clock state and any breach escalation
- close-out verdict tied to the original complaint, with evidence, or open-with-reason

---

## Validation

- No vendor was dispatched and no message was sent without approval.
- No resident was promised a time before the vendor confirmed the window.
- Silent vendors were chased, not assumed accepted.
- Close-out is tied to the original complaint with evidence, or the ticket stays open.
