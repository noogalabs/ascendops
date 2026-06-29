---
name: turnover-coordination
description: "Run the whole unit turn after move-out: build the make-ready punch list from inspection findings, split normal wear from tenant damage, sequence the trades, track to rent-ready, and hand off to {{leasing_agent_name}}. Re-key every turn is non-negotiable."
---

# Turnover Coordination

{{agent_name}} uses this skill to run a unit turn as a deadline project, vacancy costs money every day. It gets the unit cleaned, fixed, and showable fast without skipping the steps that protect the deposit disposition or the next resident's first impression. It owns the plan and the tracking, not the inspection tooling or the trade dispatch.

---

## Hard Gate

This skill plans and tracks. It does not dispatch trades, message anyone, decide a chargeback, or commit spend. Each trade job is handed to vendor-coordination (approval-gated). The wear-vs-damage split is a recommendation; the chargeback/deposit decision stays with a human. The unit flips to rent-ready only when every must-fix is verified with evidence.

---

## Inputs

- Move-out walk-through evidence (via inspection-media-to-findings)
- Unit/property context and the target ready date
- Vendor roster (handed to vendor-coordination for dispatch)
- Deposit/chargeback policy, for the wear-vs-damage recommendation

---

## Workflow

1. Start from the move-out walk-through, not from memory.
2. Classify each condition issue as normal wear (owner cost) or tenant-caused damage (possible chargeback); flag the genuinely unclear ones for a human.
3. Build an ordered punch list bucketed into repair, paint, floor, clean, and keys.
4. Sequence the trades so each leaves the unit ready for the next: paint after repairs, clean after the dusty work, re-key last. Re-key on every turn is non-negotiable.
5. Hand each trade job to vendor-coordination for dispatch (approval-gated). Do not dispatch directly.
6. Run the unit as a live checklist; track every item to done with photo evidence.
7. Flip to rent-ready only when every must-fix and standard item is verified, then hand off to {{leasing_agent_name}}.

---

## Output Contract

Produce a turn package with:
- the wear-vs-damage classification per issue (or `UNCLEAR, human decision`)
- the ordered punch list bucketed by trade
- the trade sequence with re-key last
- the live rent-ready checklist with per-item evidence status
- chargeback candidates listed for human review
- the rent-ready verdict and {{leasing_agent_name}} hand-off, or open-with-reason

---

## Validation

- The plan starts from the walk-through, not memory.
- Every trade job routed through vendor-coordination, none dispatched directly.
- Re-key is present on the turn.
- Rent-ready was declared only with every must-fix verified by evidence.
- No chargeback decided; no message sent without approval.
