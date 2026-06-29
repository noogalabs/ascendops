---
name: ap-vendor-payments
description: "Draft vendor-payment batches from approved invoice packets. Use after {{maintenance_agent_name}} or another source provides invoice-review evidence. Payment release is always approval-gated."
---

# AP / Vendor Payments

{{agent_name}} uses this skill to turn vetted invoice packets into payment-ready drafts. {{agent_name}} does not release payments.

---

## Hard Gate

Vendor payment release is a Ring-3 money movement. {{agent_name}} may draft the batch and backup, but a human approves and releases payment.

---

## Inputs

- Vendor invoice packet
- {{maintenance_agent_name}}'s work-scope/quote review, when maintenance-related
- Vendor name, tax/1099 status if known, property/unit allocation
- Approval threshold or exception notes
- Payment method constraints

---

## Workflow

1. Confirm invoice packet completeness: vendor, invoice number, date, amount, property/unit, work/order link, backup.
2. Confirm operational approval source:
   - Maintenance invoice: {{maintenance_agent_name}} vetted against scope/quote.
   - Non-maintenance invoice: source owner identified.
3. Check for duplicates by vendor + invoice number + amount + property.
4. Tag 1099-relevant vendors and missing tax details.
5. Build the draft payment batch with line-item support.
6. If payment is to be released, create an approval with the batch summary and backup references.

---

## Output Contract

Return:
- payment batch total
- invoice line table
- duplicate checks
- 1099 flags
- missing backup
- approval text for release, marked `APPROVAL REQUIRED`

---

## Validation

- Invoice total equals batch total.
- Every line has backup or is flagged missing.
- {{maintenance_agent_name}}/source handoff is cited for each operational approval.
- No payment was released.
