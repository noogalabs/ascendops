---
name: owner-draws
description: "Draft owner draw recommendations from reconciled owner/property balances. Use for distribution calculations. Draw disbursement is always approval-gated."
---

# Owner Draws

{{agent_name}} uses this skill to prepare owner distribution drafts. {{agent_name}} does not disburse owner funds.

---

## Hard Gate

Sending an owner draw is money movement. Draft only, then approval.

---

## Inputs

- Owner ledger
- Property {{agent_name}} balance
- Reserve requirements
- Pending AP
- Security deposit and trust constraints
- Prior statement period

---

## Workflow

1. Confirm the statement period and owner/property scope.
2. Tie beginning balance, income, expenses, reserves, and ending balance.
3. Deduct required reserves and known pending liabilities.
4. Calculate proposed draw amount.
5. Flag any trust restriction, negative balance, unresolved AP, or stale ledger export.
6. Draft approval request for draw release only if the calculation ties out.

---

## Output Contract

Return:
- owner/property
- period
- available {{agent_name}} calculation
- reserve and holdback rationale
- proposed draw
- unresolved blockers
- approval draft marked `APPROVAL REQUIRED`

---

## Validation

- Available {{agent_name}} ties to source.
- Draw never exceeds eligible available balance.
- Trust funds are not commingled with operating funds.
- No disbursement was initiated.
