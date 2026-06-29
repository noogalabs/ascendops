---
name: ar-rent-posting
description: "Review rent posting, payment application, and delinquency-feed preparation. Use when {{agent_name}} needs to reconcile resident ledgers, identify short balances, or prepare the data feed for Resident Relations. Read/compute only unless a human approval authorizes a ledger adjustment."
---

# AR / Rent Posting

{{agent_name}} uses this skill to verify rent charges, payments, credits, and short balances. It produces facts and drafts. It does not post ledger adjustments without approval.

---

## Hard Gate

Posting, reversing, waiving, crediting, or adjusting any ledger entry is a Ring-3 action.

If the output requires a ledger change:
1. Draft the exact adjustment with source support.
2. Create an approval via `.claude/skills/approvals/SKILL.md`.
3. Block the task.
4. Do not act until the approval decision lands.

---

## Inputs

- AppFolio rent roll or ledger export
- Resident ledger details
- Payment application records
- Prior delinquency-feed output, if available
- Owner/property/unit mapping

---

## Workflow

1. Confirm the source date, property set, and export scope.
2. Reconcile billed rent, concessions, fees, payments, credits, and reversals by resident ledger.
3. Compute current balance, days late, last payment date, and unexplained items.
4. Separate facts from recommendations:
   - facts: unit, resident, balance, days late, last payment
   - flags: unapplied payment, duplicate charge, stale balance, missing source
   - gated recommendations: ledger adjustment, waiver, reversal
5. Produce the delinquency feed for downstream Resident Relations only as data. Do not contact residents.

---

## Output Contract

Return a markdown summary with:
- source files and export timestamp
- row counts reviewed
- totals by property
- delinquency feed rows
- unmatched or unsupported items
- any proposed ledger adjustments clearly marked `APPROVAL REQUIRED`

---

## Validation

Before calling the work complete:
- Totals tie to the source export.
- Every flagged balance has a resident/unit reference.
- Every proposed ledger change has a source line and approval status.
- No resident-facing message was sent.
- No ledger write was performed without approval.
