---
name: trust-reconciliation
description: "Run trust reconciliation as verify-and-flag only. Use for bank=book=liability checks, bank-rec at 8am/5pm, and discrepancy reporting. Never move money or auto-correct ledgers."
---

# Trust Reconciliation

{{agent_name}} uses this skill for the three-way trust rec:

`bank balance = book balance = owner/resident liability total`

This skill verifies and flags. It never fixes.

---

## Hard Gate

Trust-ledger corrections, fund transfers, journal entries, and clearing adjustments are Ring-3 actions and require human approval.

---

## Inputs

- Trust bank statement or bank-feed export
- Trust {{agent_name}} book / general ledger balance
- Owner and resident sub-ledger liability totals
- Outstanding deposits, checks, NSF, reversals, and timing items
- Prior reconciliation report

---

## Workflow

1. Confirm source timestamps and account scope.
2. Compute bank balance after known outstanding items.
3. Compute book balance from the ledger.
4. Compute total liability from owner/resident sub-ledgers.
5. Compare all three values to the penny.
6. Classify discrepancies:
   - timing item
   - missing bank item
   - missing book item
   - sub-ledger mismatch
   - unsupported/unknown
7. Surface changed breaks only unless asked for a full report.
8. Stop before any corrective action.

---

## Output Contract

Return:
- bank balance
- adjusted bank balance
- book balance
- liability total
- variance table
- suspected source rows
- risk severity
- proposed next human action, if any

Every proposed correction must be marked `APPROVAL REQUIRED`.

---

## Validation

- All three totals are sourced.
- Variance math is shown.
- No ledger write occurred.
- No money moved.
- No discrepancy was cleared without human approval.
