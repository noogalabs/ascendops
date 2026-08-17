---
name: approvals
model: claude-haiku-4-5-20251001
description: "You are about to take an action that affects the outside world, cannot be undone, or involves real people — and you have not yet received explicit permission. This includes: sending any email or message to a real person, deploying code to production, posting on social media, making a purchase or financial commitment, deleting files or data, merging a PR to main, or publishing anything publicly. Stop, create an approval, block your task, and notify the user. Do not proceed until you receive the approval decision in your inbox."
triggers: ["need approval", "create approval", "request approval", "approval needed", "needs sign-off", "needs permission", "before deploying", "before sending email", "before deleting", "before posting", "external action", "irreversible action", "financial commitment", "purchase", "deploy to production", "merge to main", "send to real person", "publish", "approval workflow", "pending approval", "waiting for approval", "check approvals", "list approvals"]
---

# Approvals

Before any external, irreversible, or high-stakes action - stop and create an approval. The user decides. You execute only after they approve.

---

## When to Use

| Action type | Requires approval? |
|-------------|-------------------|
| Sending emails to real people | YES |
| Deploying code to production | YES |
| Posting on social media | YES |
| Making financial commitments | YES |
| Deleting data (files, DB rows, records) | YES |
| Merging to main branch | YES |
| Any action visible to external parties | YES |
| Internal work (writing files, creating tasks, research) | NO |

---

## External Commitments vs Informational Messages (the resident/vendor gate)

Messaging a real person (resident, vendor, tech) splits into content classes, but resident-visible content has a permanent narrower rule.

### Resident-visible protocol — exact states, not a generic permission

*(RESTRUCTURED 2026-07-30 by David direct: intake check FIRST — photos? description clear? — then exactly ONE message. The old message-1-alone + separate-follow-up sequence is superseded.)*

1. **Gas smell replaces everything:** send exactly `Please call your gas company.` with no gate, no thank-you before it, and nothing after it. Do not add 911, evacuation, vendor dispatch, or other safety detail.
2. **Photos present + clear description:** send only `Thank you for submitting the work order, we will get it assigned to the right person.` as the one message. Nothing appended.
3. **Missing photos:** send the COMBINED single message, byte-exact: `Thank you for submitting your work order. Can you please add a photo or video so that we can assign it to the right technician or vendor, and they'll know what to bring with them to complete this job?` — no per-send gate. HVAC melds (AC/cooling/heat) use the HVAC three-photo combined line from org `knowledge.md` INSTEAD, never in addition. Preserve `they'll` and the reason clause verbatim.
4. **Photos present but something still blocks assignment:** thank them for the photos and ask the blocking item in the SAME single message. BATCH every genuinely-needed ask into that one first message; drip-questioning across separate messages is banned.
5. **Approved self-fix:** an instruction may be reused only under the exact trigger and exact wording in the approved self-fix library in `../../knowledge.md`.
6. **Anything else:** David approval first, for every message beyond the combined first one. Wanting more detail when photos already exist is a blocking-ask judgment (state 4) only if it genuinely gates assignment; otherwise it is David-first.

Do not send hazard warnings, 911/utility instructions, process explanations, reassurance, or next-step previews except text David has placed verbatim in the approved reusable set.
- **A COMMITMENT**: any message that binds the company to future work, a vendor, a cost, a repair, or a timeline: "we will get a crew out," "we will have someone there tomorrow," "we will cover that." This is an external, hard-to-reverse commitment. It needs the gate EVEN IF the informational part of the same message is fine to send, and EVEN mid-emergency.

Two independent conditions must BOTH hold before you commit a crew/vendor/repair to a resident:
1. **David has authorized it** (propose-first: you do not put the company on the hook for work he has not approved).
2. **The vendor is confirmed** (vendor-first-confirm-THEN-resident: never tell a resident a crew is coming before a vendor has actually confirmed; see vendor scheduling order).

Mid-emergency: route the confirmed facts internally and hold every unapproved future-work commitment. Do not generate a resident-facing safety message. Interim fire/smoke posture pending David protocol: interrupt David immediately regardless of vacation and send the resident nothing. When a commitment is warranted, propose it to David and wait, or file the approval.

CONSEQUENCE: an unauthorized commitment reaches the resident and cannot be quietly taken back; it puts the company on the hook. Incident 2026-07-03: a resident was told "once the line is confirmed safe, we will get a crew out" with no vendor confirmed and no authorization; David caught it live. David lock 2026-07-03: "NO UNAUTHORIZED COMMITMENTS... applies to EVERYTHING." Cross-ref vendor-comms / assign-vendor-with-confirmation for the vendor-first sequencing, and the comms concision fix (same incident).

## Inline Authorization (low-risk internal actions)

An explicit owner or orchestrator authorization received IN-CONVERSATION satisfies the gate for a LOW-RISK INTERNAL action without a formal create-approval object, for example disabling a fork's noisy scheduled workflow, where a formal approval would be pure ceremony.

Worked example (2026-06-15): an agent authorized an agent inline to disable a noisy scheduled doc-audit workflow on a fork ("my sign-off clears the not-unilateral flag, internal housekeeping, no external impact"). The agent acted on that inline authorization, no formal approval object needed.

This applies ONLY to low-risk internal actions. EXTERNAL, irreversible, third-party-visible, financial, data-deletion, or merge-to-main actions ALWAYS require the full formal flow below. An inline "go ahead" does NOT substitute for those. When in doubt whether an action is low-risk-internal, use the formal flow.

---

## PM Decision Pre-log (MANDATORY for meld approvals)

Before creating any approval that involves a PM operation, you MUST log the decision first. No log = the copilot threshold system never sees this decision and your accuracy tracking breaks.

Identify the category from this table:

| Action | Category |
|--------|----------|
| Dispatching in-house tech | `inhouse_dispatch` |
| Dispatching a known vendor | `known_vendor_dispatch` |
| Dispatching a new/untested vendor | `new_vendor_assignment` |
| Lock change | `lock_change` |
| Messaging a resident | `resident_comms` |
| Closing or canceling a meld | `meld_closure` |
| Emergency dispatch | `emergency_dispatch` |

Then log before proceeding:

```bash
cortextos bus log-event quality blue_decision_presented info \
  --meta "{\"category\":\"<category>\",\"meld_id\":\"<meld_id>\",\"recommendation\":\"<one-line summary>\"}"
```

If the action does not involve a meld, skip this step and proceed directly to Step 1.

---

## Full Workflow

### Step 0: Check Human Task Queue (MANDATORY — run first)

```bash
cortextos bus log-event action approvals_cron_fired info --meta '{"agent":"'$CTX_AGENT_NAME'"}'
cortextos bus list-tasks --status pending
# Check output for tasks assigned to human or david
```

For each human task:
- If created >24h ago with no update: send one Telegram reminder
- If blocking agent work: surface explicitly with blocking context
- If night mode (after 19:30 ET): defer reminders to morning review

Even if both queues are empty, the log-event above confirms the cron cycle fired.

---

### 1. Create the approval

```bash
APPR_ID=$(cortextos bus create-approval \
  "<what you want to do>" \
  "<category>" \
  "<context: draft content, target, why needed>")
echo "APPR_ID=$APPR_ID"
```

Categories: `external-comms` | `financial` | `deployment` | `data-deletion` | `other`

### 2. Block your task on the approval

```bash
cortextos bus update-task "$TASK_ID" blocked
cortextos bus log-event task task_blocked info --meta "{\"task_id\":\"$TASK_ID\",\"blocked_by\":\"$APPR_ID\",\"reason\":\"awaiting approval\"}"
```

### 3. Notify the user

```bash
cortextos bus send-telegram "$CTX_TELEGRAM_CHAT_ID" \
  "Approval needed: <title> - check dashboard or reply to approve/reject"
```

### 4. Wait for inbox notification

When the user decides, you receive an inbox message:
```
approval_id: appr_xxx
decision: approved | rejected
note: <user's note>
```

**Latency note:** the decision is asynchronous — it arrives only after the user acts, which can be minutes or hours. Do NOT busy-poll `list-approvals` waiting for it. Once you have blocked the task (Step 2) and notified the user (Step 3), **end your turn**. The daemon injects the decision into a future turn via your inbox; if you keep executing tools the decision gets queued behind your work and you will not see it land. Block, notify, stop — then resume when the inbox message arrives.

### 5. Act on the decision

**Approved:**
```bash
# Unblock task
cortextos bus update-task "$TASK_ID" in_progress "Approval received - executing"
# Execute the action
# Complete the task
cortextos bus complete-task "$TASK_ID" --result "<what was done>"
```

**Rejected:**
```bash
cortextos bus complete-task "$TASK_ID" --result "Cancelled - approval rejected: <note>"
```

---

## Re-pinging

If an approval is still pending after 4 hours during day mode, send one re-ping:

```bash
cortextos bus send-telegram "$CTX_TELEGRAM_CHAT_ID" \
  "Reminder: approval for '<title>' is still pending. No rush, just flagging."
```

Send only ONE re-ping. Do not spam.

---

## Listing Pending Approvals

```bash
cortextos bus list-approvals --format json
```

---

## Human Task Check

*(Now moved to Step 0 above — this section is kept for reference only.)*

When the approvals cron fires, also check for tasks assigned to the user that may need a nudge:

```bash
cortextos bus list-tasks --status pending
# Check output for tasks assigned to human or david
```

For each human task:
- If created >24h ago with no update: send one reminder via Telegram
- If it is blocking agent work: surface it explicitly
- If low priority and David is in night mode: defer to morning review

```bash
cortextos bus send-telegram "$CTX_TELEGRAM_CHAT_ID" \
  "Reminder: '[task title]' is waiting on you. No rush — flagging so it doesn't get lost."
```

## Telegram Authorization Audit Trail

When David approves an action via Telegram rather than the dashboard:
```bash
APPR_ID=$(cortextos bus create-approval \
  "<what was approved>" \
  "other" \
  "Authorized via Telegram by David at <timestamp>. Message: '<quote>'")
# Mark the approval record approved immediately
cortextos bus update-approval "$APPR_ID" approved
```
This keeps the dashboard audit trail complete even for Telegram-authorized actions.

---

## Critical Rules

1. **Create approval BEFORE starting the action** - never take the action first and ask forgiveness
2. **Always block your task** pointing to the approval ID - so work isn't lost while waiting
3. **Never assume approval** - if you don't have an inbox confirmation, you don't have approval
4. **One re-ping max** - after 4h, ping once and wait
