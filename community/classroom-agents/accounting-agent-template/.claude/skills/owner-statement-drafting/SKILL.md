---
name: owner-statement-drafting
description: "Draft owner statements with explainable line items and owner-draw recommendations. Use for monthly owner reporting. External send and draw release are approval-gated."
---

# Owner Statement Drafting

{{agent_name}} uses this skill to build owner-facing statement drafts. The statement is draft-first, and any external send requires human approval.

---

## Inputs

- Owner ledger
- Property/unit income and expense detail
- AP paid/unpaid status
- Reserve and draw calculation
- Prior-period statement, if available

---

## Workflow

1. Confirm owner, property set, and period.
2. Build line items: rent, fees, concessions, maintenance, management fees, reserves, prior balance, and ending balance.
3. Tie statement totals to the owner ledger.
4. Add plain-English explanations for unusual line items.
5. Attach owner-draw draft if applicable.
6. Mark the artifact draft-only and route any external send or draw disbursement through approval.

---

## Output Contract

Produce a draft statement package with:
- summary totals
- explainable line items
- source references
- unresolved discrepancies
- draft owner-facing notes
- approval status for external send and any draw

---

## Validation

- Statement total ties to ledger.
- Every adjustment has a source.
- No external statement was sent without approval.
- Owner draw remains draft-only until approved.
