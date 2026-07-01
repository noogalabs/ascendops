---
name: meld-intake-triage
description: "You MUST use this skill whenever a NEW Property Meld maintenance request arrives and BEFORE any vendor or tech is assigned to it. It runs the front-gate intake: read the notes, classify emergency vs routine from the full meld content, confirm we have photos/eyes on the problem, and request photos from the tenant if missing. True emergencies route to immediate mitigation while photos are requested in parallel; routine work waits at the photo gate. Pass the meld ID after the command. Do not assign a vendor or trade inline in the main session before this gate returns a decision."
triggers: ["new meld", "intake meld", "triage intake", "before assigning", "new maintenance request", "should I assign this", "assign a vendor", "photos before assign", "emergency meld subject", "is this ready to assign"]
context: fork
model: sonnet
---

# Meld Intake Triage — the front gate

Run the intake gate on the Property Meld passed in `$ARGUMENTS` (a meld ID like `TXT2VMI`, optionally with a hint, e.g. `TXT2VMI water under sink, no photos yet`).

**Why this is a forked Sonnet skill:** intake triage is a repeating judgment call — read, gate on evidence, classify — not heavy multi-step root-cause reasoning (that is `meld-diagnose`, Opus). Sonnet is the right tier for a classification/gate decision. It is still `context: fork` so the gate runs in its own window and the main orchestrator session stays lean for routing and comms; the triage never bloats the main context. Opus is NOT spent here — only normal judgment is needed.

## Steps

1. **Read the meld** named in `$ARGUMENTS` — tenant notes, description, work_location, any attached media, current status.
2. **Classify emergency vs routine first** — against habitability/safety criteria (see hard rule 3), NOT against the subject line.
3. **If gas smell / gas leak is reported** — return `GAS_UTILITY_REFERRAL` with the tenant-facing message below EXACTLY, copying it verbatim and adding nothing before or after it. Do NOT request photos first, do NOT classify as `EMERGENCY_NOW`, and do NOT route property-side emergency mitigation.

   ```text
   Please call your gas company.
   ```
4. **Check for photos / eyes on the problem.** Does the meld carry photos (or an equivalent clear description that lets us pick the right trade with confidence)?
5. **If it is a true emergency** — route immediate mitigation now with the confirmed emergency facts. If photos are missing, request them from the tenant in parallel; do NOT park an active emergency waiting on photos.
6. **If it is routine and no photos / clear detail are present** — request photos from the tenant and WAIT. The meld is PARKED at the intake gate as "awaiting tenant photos," not advanced.
7. **If it is routine and the evidence gate passes** — return `CLEAR_TO_ASSIGN` to the main session with the classification + confirmed problem. The main session then uses the approved assignment workflow for its runtime; this intake template does not invoke a hard-coded downstream skill dependency.

## Hard rules — these fire EVERY time (the slippage these prevent is real)

1. **Photos-and-notes-before-routine-assign — HARD GATE.** No routine assignment until we have eyes on the problem (photos, or detail clear enough to pick the trade right). Blind assignment → wrong trade → wasted truck roll. the owner: "we know it's right and we rarely do it" — so this gate fires automatically, not when we remember it. If photos are missing on routine work, request + wait; do not advance the meld.
2. **Tenant photo-request uses generic, plain language.** Ask for "a photo of the problem" in plain words; do NOT name a trade or prescribe a cause in the request. (Generic-noun rule: TUUJCPB 5/24 — the owner edited my "plumber" → "someone." Default to "someone"/"a tech," never a trade noun, in any tenant-facing intake line.)
3. **Classify, don't assume — the subject line is not the signal.** An "Emergency meld" subject is an intake CATEGORY, not an urgency signal. Emergency classification requires real habitability/safety criteria from the meld CONTENT (water/electrical/lockout/no-heat/no-AC/habitability), verified against the body — not the subject. Gas smell is not `EMERGENCY_NOW`; it returns `GAS_UTILITY_REFERRAL` with exactly this tenant-facing output and nothing else: `Please call your gas company.` (PM "Emergency meld" subject = intake category: caught twice 5/19; verify the activity body before treating as urgent.)
4. **Emergency dispatch is not photo-blocked.** If the full meld content already proves active water, electrical hazard, lockout, no-heat/no-AC in extreme conditions, or another non-gas habitability/safety threat, request missing photos in parallel but route mitigation immediately. Photos improve scope; they do not delay emergency response. Gas smell is different: return only `Please call your gas company.` as the tenant-facing output, not property-side emergency mitigation or extra action wording.

## Invocation example

```
/meld-intake-triage TXT2VMI
/meld-intake-triage T76DZIB tenant says water under sink, no photos attached
```

The text after the command replaces `$ARGUMENTS`. The main agent stays on its lean model; this gate runs on Sonnet in its own window. It returns exactly one of: `GAS_UTILITY_REFERRAL` (tenant-facing output must equal `Please call your gas company.`), `EMERGENCY_NOW` (route non-gas mitigation immediately, photos parallel if needed), `AWAITING_TENANT_PHOTOS` (routine work parked), or `CLEAR_TO_ASSIGN` (routine work has enough evidence and classification for the main session's live assignment path).
