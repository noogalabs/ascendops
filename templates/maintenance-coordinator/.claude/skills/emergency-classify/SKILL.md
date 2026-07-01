---
name: emergency-classify
description: "You MUST use this skill whenever a meld or message reads as urgent, after-hours, or an emergency, and BEFORE you escalate to the owner or pull an overnight watch on it. It decides the one question that matters — is this a real emergency that needs action NOW, or an emergency that is already CONTAINED with a known resolution path — and applies the stand-down rule so we do not babysit a settled situation overnight. Pass the meld ID or a short description after the command."
triggers: ["emergency", "urgent meld", "after hours", "stand down", "is this an emergency", "overnight escalation", "should I escalate", "habitability", "no heat", "no AC", "water leak", "gas leak", "lockout", "do I pull a watch"]
context: fork
model: sonnet
---

# Emergency Classify + Stand-Down

Classify the urgent-looking situation passed in `$ARGUMENTS` (a meld ID or short description, e.g. `door kicked in, secured, Carlo coming 8am` or `TG6J0DU AC out`).

**Why this is a forked Sonnet skill:** emergency-vs-contained is a repeating judgment call with a fixed decision tree, not open-ended reasoning — Sonnet is the right tier. It is `context: fork` so the classification runs in its own window and the main session stays lean; it also keeps the urgent-escalation decision OFF the reflex path, forcing the stand-down check to fire before anything reaches the owner. Opus is not needed; disciplined classification is.

## Steps

1. **Read the full situation** named in `$ARGUMENTS` — the FULL message body and the CURRENT meld state, not a snippet or a first parse (see hard rule 2).
2. **Ask the one question:** is this a **real emergency requiring action NOW**, a **gas utility referral**, or an emergency that is **already contained with a known resolution path**?
3. **If contained** — confirm it has all four: (a) contained/secured, (b) a clear next action, (c) an owner, (d) a time/ETA. If all four hold → **STAND DOWN**: note the scheduled resume moment and stop. Do NOT pull an overnight watch or re-surface it before that moment.
4. **If gas smell / gas leak is reported** — return the tenant-facing message below EXACTLY, copying it verbatim and adding nothing before or after it. Do NOT classify it as `EMERGENCY_NOW`; do NOT add any extra action wording; do NOT route property-side emergency mitigation or wake the orchestrator for it.

   ```text
   Please call your gas company.
   ```
5. **If a true emergency** (hard rule 3 list) — take the action path: surface immediately with the confirmed body + current state, and drive the now-action.
6. **Return** to the main session: classification (emergency-now vs contained-scheduled vs gas-utility-referral), the resume moment (if contained), the standard gas-company referral (if gas), or the action taken (if emergency).

## Hard rules — these fire EVERY time (the slippage these prevent is real)

1. **Stand-down rule — HARD.** Once a situation is contained + has a clear next action + an owner + a time, STAND DOWN and resume at that scheduled moment. Do NOT babysit a known situation overnight. (Door-kick 6/4: unit secured + Carlo coming AM = path fully set, yet the watch was pulled all night — wildly inefficient.) This is the no-resurface-static-state rule made operational: a contained situation with a path is static; surface only on a real CHANGE, not on "still secured / still pending."
2. **Confirm full body AND current meld state before any urgent escalation.** Never fire a the owner-facing urgent off a truncated fast-checker snippet plus a partial/first parse. (TG6J0DU false urgent: claimed "unassigned, no vendor, baby in the house" — ALL false; meld was COMPLETED, tech returning, and the baby detail was hallucinated. Delayed shell-output flushing was the trap.) Verify before confirmed, in the escalation path especially.
3. **True-emergency list gets the action path; everything else gets contained/scheduled.** Action-now criteria: active water, electrical hazard, lockout, no-heat or no-AC in extreme conditions, or any habitability/safety threat other than gas smell — verified from the meld content. Anything outside that list, or anything in that list once it is contained with a path, takes the contained/scheduled path (apply rule 1).
4. **Gas smell is a utility referral, not `EMERGENCY_NOW`.** If the tenant reports gas smell / gas leak, the tenant-facing output is exactly one line: `Please call your gas company.` Copy the fenced line from step 4 verbatim. Add nothing else. The gas utility is the emergency responder; do not route property-side emergency mitigation, do not wake the orchestrator, and do not classify it as emergency-now.

## Invocation example

```
/emergency-classify door kicked in, unit secured, Carlo coming 8am
/emergency-classify TG6J0DU tenant says AC out
```

The text after the command replaces `$ARGUMENTS`. The main agent stays lean; this classification runs on Sonnet in its own window and either stands the situation down to its scheduled moment or routes it to the action path — never an overnight babysit of a settled situation.
