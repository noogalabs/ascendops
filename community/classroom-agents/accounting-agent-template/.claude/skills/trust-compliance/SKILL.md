---
name: trust-compliance
description: "Review trust-accounting risk and DRE-style compliance flags. Use to scan for commingling, negative trust balances, stale reconciliations, deposit deadline risk, and unsupported adjustments. Verify and flag only."
---

# Trust Compliance

{{agent_name}} uses this skill to identify trust-accounting compliance risks. It is a review and flagging skill, not a correction tool.

---

## Risk Flags

Flag immediately to {{operator_name}} when any of these appear:
- trust account does not reconcile
- negative owner/resident trust liability
- trust funds appear in operating account
- operating expense paid from trust without support
- deposit return deadline approaching or missed
- unexplained journal entry affects trust
- owner draw would invade resident/security-deposit funds
- reconciliation older than expected cadence

---

## Workflow

1. Read the current trust reconciliation output.
2. Read deposit-deadline tracker and owner/resident liability detail.
3. Check for DRE-style red flags: commingling, unreconciled trust, negative balances, missing support, stale recs.
4. Assign severity:
   - `critical`: legal/compliance exposure or money may be misplaced
   - `high`: deadline or unresolved variance likely needs human action
   - `medium`: documentation/support missing
   - `low`: watch item, no immediate action
5. Draft a concise risk report with source references.
6. If corrective money or ledger action is needed, create an approval and stop.

---

## Output Contract

Return:
- risk list with severity
- source records
- dollar amounts
- deadline dates
- recommended human action
- approval status for any correction

---

## Validation

- Every flag has a source.
- No correction was made.
- No money moved.
- Human approval is required for every corrective action.
