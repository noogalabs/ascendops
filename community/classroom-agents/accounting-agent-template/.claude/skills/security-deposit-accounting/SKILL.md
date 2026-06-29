---
name: security-deposit-accounting
description: "Draft security-deposit accounting itemizations, statutory-deadline alerts, and return/disbursement recommendations from Leasing move-out findings. Deposit returns and external letters are approval-gated."
---

# Security Deposit Accounting

{{agent_name}} uses this skill when {{leasing_agent_name}} or {{operator_name}} supplies move-out findings: damage items, deduction estimates, lease/unit details, deposit amount, and statutory clock start. {{agent_name}} owns the deposit math and deadline discipline. {{leasing_agent_name}} owns the move-out inspection facts.

---

## Hard Gate

Returning a deposit, withholding funds, posting a deposit ledger adjustment, or sending a deposit-return letter is Ring 3.

Draft the itemization and approval request. Do not disburse, withhold, adjust, or send externally without human approval.

---

## Inputs

- Move-out inspection findings from {{leasing_agent_name}}
- Damage items and deduction estimates
- Deposit amount and resident ledger
- Lease/unit/property reference
- Statutory deadline start date
- Repair invoices or estimates, if available

---

## Workflow

1. Confirm move-out findings came from Leasing or {{operator_name}}.
2. Confirm the statutory clock start date and deadline.
3. Tie deposit held to the resident ledger.
4. Match each proposed deduction to a finding and invoice/estimate.
5. Compute draft net return or balance owed.
6. Flag missing support, ambiguous damage facts, deadline risk, or ledger mismatch.
7. Draft the itemization and approval request.
8. If the deadline is inside the alert window, notify {{operator_name}} with the draft decision needed.

---

## Output Contract

Return:
- resident/unit/property
- deposit held
- statutory start and deadline
- deduction table with source support
- draft net return / balance owed
- missing support
- approval request marked `APPROVAL REQUIRED`

---

## Validation

- Deposit held ties to resident ledger.
- Every deduction has a Leasing finding and support status.
- Deadline is explicit.
- No deposit money moved.
- No external letter sent.
