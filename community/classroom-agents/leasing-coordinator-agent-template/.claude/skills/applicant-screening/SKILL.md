---
name: applicant-screening
description: "Score a rental application against a consistent, written, fair-housing-safe rubric and produce an approve / approve-with-conditions / decline recommendation for a human to sign off. Never auto-declines. Sending the decision is always approval-gated."
---

# Applicant Screening

{{agent_name}} uses this skill to score an application against criteria set once, in writing, before anyone is screened, and applied the same way to every applicant on the unit. {{agent_name}} produces a scorecard and a recommendation. It never auto-declines, and it never sends an applicant a decision.

---

## Hard Gate

Sending an applicant an approve, approve-with-conditions, or decline decision reaches an outside party and is approval-gated. {{agent_name}} drafts the scorecard, recommendation, and any applicant message; {{operator_name}} or the designated human approver makes and sends the final call. This is not legal advice.

Before any recommendation or applicant message is surfaced, run it and the screening criteria through the fair-housing-guard skill.

---

## Inputs

- The application and supporting documents
- The written screening rubric and thresholds (set before screening, identical for every applicant on the unit): income-to-rent ratio, credit/background signals, rental history, employment verification
- Lawful income sources to count (all counted equally)
- Any approve-with-conditions options the operator allows (e.g. additional deposit, co-signer)

---

## Workflow

1. Confirm the rubric and thresholds are written and fixed before scoring; apply the same ones to every applicant on the unit.
2. Check completeness. A gap is a "cannot verify," not an automatic fail.
3. Score each dimension with the value, the threshold, the result, and a one-line factual reason.
4. Count all lawful income sources equally.
5. Flag criminal-history factors for human review rather than scoring them; this area carries specific fair-housing constraints.
6. Sanity-check that nothing outside the rubric crept in (no protected class, no proxy).
7. Run the criteria and any applicant-facing message through fair-housing-guard.
8. Produce the recommendation: approve, approve-with-conditions, or decline, each backed by the scored lines.
9. Create an approval for the decision and any applicant message. Do not send.

---

## Output Contract

Return:
- applicant / unit / property reference
- scorecard: each dimension with value, threshold, result, and factual reason
- completeness gaps marked "cannot verify"
- criminal-history factors flagged for human review
- recommendation (approve / approve-with-conditions / decline) with conditions if any
- fair-housing-guard result
- approval request for the decision and any message, marked `APPROVAL REQUIRED`

---

## Validation

- The same written rubric was applied to every applicant on the unit.
- Every scored line has a value, a threshold, and a factual reason.
- No protected class or proxy was scored.
- No application was auto-declined.
- No applicant decision or message was sent.
