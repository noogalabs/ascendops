---
name: inspection-media-to-findings
description: "Turn a walkthrough video or photo set into a structured, act-on-it findings report: per-issue category, room, severity, recommended action, vendor type, turnover estimate, and tenant-damage vs normal-wear flags. Demo mode runs fully offline."
---

# Inspection Media to Findings

{{agent_name}} uses this skill to convert inspection media into validated findings, not just a transcript. It pulls spoken narration and cross-references it with what is visible in the frames so nothing said is lost. It is especially useful for deposit/chargeback decisions because it separates tenant damage from normal wear.

---

## Hard Gate

This skill produces findings; it does not message anyone, dispatch a vendor, or decide a chargeback. Creating work orders from the findings goes through vendor-coordination (approval-gated). The wear-vs-damage split is a recommendation, the final deposit/chargeback decision stays with a human. Inspection media is treated as sensitive: keep it in a scoped workspace, do not commit it, and delete it after.

---

## Inputs

- A walkthrough video and/or a set of photos
- Optional spoken narration in the recording
- Unit/property context and inspection type (move-in, move-out, routine)
- Vision-model and speech-to-text provider keys, read from your environment (never hardcoded)
- Demo mode flag for an offline run with zero external calls

---

## Workflow

1. Extract frames and audio from the media.
2. Transcribe any narration.
3. Have a vision model analyze the frames against the narration so spoken notes and visible evidence reconcile.
4. Produce validated findings, one issue per line, each with: category, room, severity, recommended action, vendor type, turnover estimate, and a tenant-damage vs normal-wear flag.
5. Flag the genuinely unclear wear-vs-damage calls for a human.
6. Emit a clean findings report. Downstream, a maintenance agent can create one work order per vendor line (via vendor-coordination) and mark the chargeback candidates.
7. Treat the media as sensitive: scoped workspace, not committed, deleted after.

---

## Output Contract

Produce a findings report with:
- per-issue: category, room, severity, recommended action, vendor type, turnover estimate
- tenant-damage vs normal-wear flag per issue (or `UNCLEAR, human decision`)
- a summary of must-fix vs cosmetic
- the source media referenced (not embedded/committed)
- chargeback candidates listed for human review

---

## Validation

- Every finding has a category, room, severity, and a wear-vs-damage flag.
- Spoken narration was reconciled against the frames.
- Demo mode made zero external calls.
- No keys were hardcoded; media was not committed.
- No chargeback was decided and no message was sent.
