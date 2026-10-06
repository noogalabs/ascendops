---
name: pm-check-meld
effort: low
description: "Pull meld status and full message thread via pm-get-comments.py before taking any action on a meld. Single-meld context fetch."
triggers: ["check meld", "pull meld", "get meld comments", "what's the status on meld", "read meld thread", "look at meld"]
---

# PM Check Meld

> Always run this before triaging, responding to, or escalating a meld. Never act on subject line alone.

---

## Usage

```bash
python3 scripts/pm-get-comments.py <meld_id>
```

Output: JSON with meld metadata + full message thread, printed to stdout.

---

## What to Extract

From the output, note:

| Field | Where to find it | Why it matters |
|-------|-----------------|----------------|
| Current status | `status` field | Is it already assigned, scheduled, or resolved? |
| Vendor assigned | `vendor` or `assigned_to` | Is someone already on it? |
| Last comment author | Last entry in `comments[]` | Did a configured staff member or a vendor already respond? |
| Last comment timestamp | `comments[-1].created_at` | How recent is the last activity? |
| Tenant last message | Scan `comments[]` for tenant author | Is tenant escalating, or satisfied? |
| Scheduled date | `scheduled_date` or comment mention | Is an appointment already booked? |

---

## Freshness Rule

If the last comment is:
- **< 6h old**: meld is actively managed — do not alert an agent unless habitability override applies
- **6–24h old**: may need follow-up — triage against urgency level
- **> 24h old with no vendor**: flag for RULE_R1 review

---

## Error Handling

| Error | Meaning | Action |
|-------|---------|--------|
| Script exits non-zero | Session or login failure | Log `meld_poll_blocked`, message an agent with stderr |
| Empty `comments` array | Meld has no thread yet | Proceed to triage on meld metadata only |
| `login` in redirect URL | Cookie expired | Script handles fresh login automatically; retry once |

---

## After Pulling Comments

Feed results into `pm-meld-triage` skill:

```
Read pm-meld-triage SKILL.md and classify meld <id> based on:
- Status: <status>
- Vendor: <assigned or none>
- Last activity: <timestamp> by <author>
- Thread summary: <1-2 sentence summary>
```

---

## Batch Usage

To check multiple melds (e.g. during morning scan), loop:

```bash
for MELD_ID in 12345 12346 12347; do
  echo "=== Meld $MELD_ID ==="
  python3 scripts/pm-get-comments.py $MELD_ID
  echo ""
done
```

---

*Run this first. Always. It's one script call and prevents false escalations.*
