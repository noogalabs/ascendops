# Heartbeat Checklist - EXECUTE EVERY STEP. SKIP NOTHING.

This runs on your heartbeat cron (every 4 hours). Execute EVERY step in order.
Skipping steps = broken system. The dashboard monitors your compliance.

**Canonical binding:** this file is the sole Codex heartbeat procedure because the daemon cron tells Codex agents to read root `HEARTBEAT.md` at fire time. The heartbeat plugin skill points here and must never duplicate this checklist. Edit the procedure here, then keep the skill as a thin trigger and pointer.

## Step 1: Update heartbeat (DO THIS FIRST)

```bash
cortextos bus update-heartbeat "<1-sentence summary of current work>"
```

If this fails, your agent shows as DEAD on the dashboard. Fix it before anything else.

**Note:** `update-heartbeat` (Step 1) and `log-event heartbeat agent_heartbeat` (Step 4) are NOT interchangeable.
- `update-heartbeat` refreshes the dashboard status-string field.
- `log-event heartbeat …` appends to the activity feed (JSONL append-only event log).

Both are required every cycle.

## Step 2: Sweep inbox for un-ACK'd messages

Messages arrive in real time via the fast-checker daemon. This step is a safety sweep for anything that wasn't ACK'd.

Full reference: `plugins/cortextos-agent-skills/skills/comms/SKILL.md`

```bash
cortextos bus check-inbox
```

For any messages returned: process and ACK each one:

```bash
cortextos bus ack-inbox "<message_id>"
```

Un-ACK'd messages are re-delivered after 5 minutes. Target: 0 un-ACK'd after this sweep.

If any of those messages were Telegram-shape (`=== TELEGRAM from`), you should already have replied via `cortextos bus send-telegram` when they first arrived - if not, do it NOW before continuing.

## Step 3: Check task queue, stale tasks, and approvals

Full reference: `plugins/cortextos-agent-skills/skills/tasks/SKILL.md`

```bash
cortextos bus list-tasks --agent $CTX_AGENT_NAME --status pending
cortextos bus list-tasks --agent $CTX_AGENT_NAME --status in_progress
cortextos bus log-event action approvals_cron_fired info \
  --meta '{"agent":"'$CTX_AGENT_NAME'","source":"heartbeat-fold"}'
cortextos bus list-tasks --status pending
cortextos bus list-approvals --format json
```

- If you have pending tasks: pick the highest priority one
- If you have in_progress tasks older than 2 hours: either complete them NOW or update their status with a note
- If you have NO tasks: check GOALS.md for objectives, then message the orchestrator

The standalone `check-approvals` cron was retired; heartbeat absorbs it. For pending human tasks, surface blockers and send at most one reminder after 24 hours. For pending approvals, send at most one reminder after 4 hours during day mode (07:30-19:30 ET). Defer reminders at night. If both queues are empty, send nothing; the `approvals_cron_fired` event proves the sweep ran.

## Step 4: Log heartbeat event

Full reference: `plugins/cortextos-agent-skills/skills/event-logging/SKILL.md`

```bash
cortextos bus log-event heartbeat agent_heartbeat info --meta '{"agent":"'$CTX_AGENT_NAME'"}'
```

## Step 5: Write daily memory

Full reference: `plugins/cortextos-agent-skills/skills/memory/SKILL.md`

```bash
TODAY=$(date -u +%Y-%m-%d)
LOCAL_TIME=$(date +'%-I:%M %p %Z' 2>/dev/null || date)
MEMORY_DIR="$(pwd)/memory"
mkdir -p "$MEMORY_DIR"
cat >> "$MEMORY_DIR/$TODAY.md" << MEMORY

## Heartbeat Update - $(date -u +'%H:%M UTC') / $LOCAL_TIME
- WORKING ON: <task_id or "none">
- Status: <healthy/working/blocked>
- Inbox: <N messages processed>
- Next action: <what you will do next>
MEMORY
```

## Step 6: Check GOALS.md

Read GOALS.md. Goals are refreshed daily by the orchestrator each morning.

- If goals were updated today: you should already have tasks. If not, create them now - see `plugins/cortextos-agent-skills/skills/tasks/SKILL.md`
- If goals are stale (>24h without update): message the orchestrator to request fresh goals
- If you have no goals: message the orchestrator immediately. Don't idle.

## Step 7: Resume work

Full reference: `plugins/cortextos-agent-skills/skills/tasks/SKILL.md`

Select your highest priority task. Tasks should trace back to your current goals. Finish Steps 8-10 before beginning a long operation; this step chooses what resumes after the heartbeat procedure closes.

When starting:
```bash
cortextos bus update-task "<task_id>" in_progress
```

When done:
```bash
cortextos bus complete-task "<task_id>" --result "<summary of what was produced>"
```

If you are blocked, see `plugins/cortextos-agent-skills/skills/human-tasks/SKILL.md` for the human task and approval workflow.
If you need an approval before acting, see `plugins/cortextos-agent-skills/skills/approvals/SKILL.md`.

## Step 8: Guardrail self-check

Full reference: `plugins/cortextos-agent-skills/skills/guardrails-reference/SKILL.md`

Ask yourself: did I skip any procedures this cycle? Did I rationalize not doing something I should have?

If yes, log it:
```bash
cortextos bus log-event action guardrail_triggered info --meta '{"guardrail":"<which one>","context":"<what happened>"}'
```

If you discovered a new pattern that should be a guardrail, add it to GUARDRAILS.md now.

## Step 9: Update long-term memory (if applicable)

Full reference: `plugins/cortextos-agent-skills/skills/memory/SKILL.md`

If you learned something this cycle that should persist across sessions:
- Patterns that work/don't work
- User preferences discovered
- System behaviors noted
- Append to MEMORY.md

Then enforce the 24KB cap:

```bash
# MEMORY_SIZE_PROBE_BEGIN
MEMSZ_STATUS=measured
case "$(uname -s)" in
  Darwin)
    if ! MEMSZ=$(stat -f %z MEMORY.md 2>/dev/null); then
      MEMSZ=0
      MEMSZ_STATUS=unmeasurable
    fi
    ;;
  *)
    if ! MEMSZ=$(stat -c %s MEMORY.md 2>/dev/null); then
      MEMSZ=0
      MEMSZ_STATUS=unmeasurable
    fi
    ;;
esac
case "$MEMSZ" in
  ''|*[!0-9]*)
    MEMSZ=0
    MEMSZ_STATUS=unmeasurable
    ;;
esac
# MEMORY_SIZE_PROBE_END
if [ "$MEMSZ_STATUS" = "unmeasurable" ]; then
  echo "MEMORY.md size unmeasurable - investigate before declaring the cap healthy"
elif [ "$MEMSZ" -gt 24576 ]; then
  echo "MEMORY.md ${MEMSZ}B over 24KB cap - run archive pass"
fi
```

The explicit platform branch prevents GNU `stat -f` output from contaminating the captured size before a fallback. A measured zero remains `measured`; command failure or nonnumeric output becomes `unmeasurable` and reports loudly instead of looking like a healthy empty file. If the cap warning fires, queue an archive pass in the current session. Do not leave the cap breached across heartbeat cycles.

## Step 10: Re-ingest memory to knowledge base

Full reference: `plugins/cortextos-agent-skills/skills/knowledge-base/SKILL.md`

Keep your memory collection searchable and current:

```bash
cortextos bus kb-ingest ./MEMORY.md ./memory/$(date -u +%Y-%m-%d).md \
  --org $CTX_ORG --agent $CTX_AGENT_NAME --scope private --force
```

This runs automatically on every heartbeat cycle. It ensures past experiences, user preferences, and learned patterns are semantically searchable for future tasks. Skip if GEMINI_API_KEY is not configured.

Read the chunk count and embedding cost, not only the final success line. The privacy wall may intentionally refuse agent-memory paths while the command exits 0; a zero-chunk result is not proof that memory was indexed.

---

REMINDER: A heartbeat with 0 events logged and 0 memory updates means you did nothing visible.
Target: >= 2 events and >= 1 memory update per heartbeat cycle.
Invisible work is wasted work.

**Completion gate:** all 10 steps are mandatory on a heartbeat cron fire. A manual `update-heartbeat` call at session start or before a long operation is Step 1 only by design and does not trigger the full procedure.

---

## Updating Heartbeat

```bash
cortextos bus update-heartbeat "<one sentence: what you are doing right now>"
```

Call this:
- On every heartbeat cron fire
- On session start (before sending online notification)
- When starting a new significant task
- Before going into a long-running operation

**Never claim a status you haven't verified.** If your crons were reset on restart, run `cortextos bus list-crons $CTX_AGENT_NAME` before saying "crons running."

---

## Reading Fleet Heartbeats

```bash
# All agents in the org
cortextos bus read-all-heartbeats

# JSON format for parsing
cortextos bus read-all-heartbeats --format json
```

Returns: agent name, status, last update timestamp, current task.

**Stale threshold:** An agent that hasn't updated in >6h should be investigated. Check their status via `cortextos status` or their heartbeat file.

---

## Checking a Specific Agent

```bash
# Read their heartbeat file directly
cat "$CTX_ROOT/state/<agent-name>/heartbeat.json"

# Check agent status via daemon
cortextos status

# Check PM2 process status
pm2 list
```

---

## Heartbeat File Schema

```json
{
  "agent": "agent-name",
  "status": "active | idle | crashed",
  "timestamp": "2026-04-01T12:00:00Z",
  "current_task": "What I'm doing right now"
}
```

Location: `$CTX_ROOT/state/{agent}/heartbeat.json`
