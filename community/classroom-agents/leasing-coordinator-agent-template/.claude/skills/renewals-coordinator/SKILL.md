---
name: renewals-coordinator
description: "Score renewal risk off real payment history, recommend renew / month-to-month / non-renew, propose a market-checked, ceiling-clamped rent, and prep an offer packet for approval. Proposes only. Never sends a resident or owner anything."
---

# Renewals Coordinator

{{agent_name}} uses this skill as the leasing decision brain for a lease coming up on its end. Fed the lease terms and the resident's payment history, it scores renewal risk, recommends a path, proposes a sanity-checked rent, and preps a clean offer packet for {{operator_name}} to approve. It proposes only.

---

## Hard Gate

Sending a renewal offer, or any resident- or owner-facing message, is approval-gated. {{agent_name}} drafts the offer packet and recommendation; a human approves and sends. {{agent_name}} never sends a resident or owner anything.

Before any resident-facing draft is surfaced, run it through the fair-housing-guard skill.

---

## Inputs

- The lease record (terms, dates, current rent) from your property-management system
- The resident's payment history from your property-management system
- An optional comparable-rents feed for the market check
- The property's rent-increase ceiling and any active concession terms

---

## Workflow

1. Confirm the lease is actually in the renewal window. If not, stop.
2. Score renewal risk off the real payment record: low / medium / high band with the top two or three reasons.
3. Pick the path: renew, go month-to-month, or non-renew.
4. Propose a rent. The market check is guarded: never propose a rent cut off a missing or implausible market value; when in doubt, propose holding flat and say why.
5. Clamp any increase to the property's ceiling.
6. Flag what's worth knowing: expiring concession, balance owed, prior bounced payment.
7. Prep the offer packet: terms, proposed rent, market-check result, risk band, and flags.
8. Run any resident-facing message through fair-housing-guard.
9. Create an approval for the offer. Do not send.

---

## Output Contract

Return:
- resident / unit / property reference
- renewal-window confirmation
- risk band (low / medium / high) with top reasons
- recommended path (renew / month-to-month / non-renew)
- proposed rent with market-check result and ceiling-clamp note
- flags (expiring concession, balance owed, prior bounced payment)
- offer packet draft and approval request, marked `APPROVAL REQUIRED`

---

## Validation

- The lease was confirmed in the renewal window before any proposal.
- Risk was scored off the real payment record.
- No rent cut was proposed off a missing or implausible market value.
- Any increase is clamped to the property ceiling.
- No resident or owner was sent anything.
