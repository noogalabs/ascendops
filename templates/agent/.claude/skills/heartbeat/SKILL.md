---
name: heartbeat
model: claude-haiku-4-5-20251001
effort: low
description: "Your heartbeat cron has fired and you need to update your status so the dashboard shows you as alive - AND run the approvals sweep folded in from the former check-approvals cron (RFC #8). Or you are checking whether another agent is responsive before sending them work. Or an agent appears offline or stale in the dashboard and you need to investigate whether their session is still running. A dead heartbeat means the system thinks you are down - update it proactively and check fleet health on every heartbeat cycle."
triggers: ["heartbeat", "update heartbeat", "check health", "agent health", "fleet health", "agent status", "is agent alive", "agent offline", "agent stale", "read heartbeats", "heartbeat cron", "i'm alive", "prove alive", "agent not responding", "stale agent", "check fleet", "fleet status", "who is online", "agent last seen"]
---

# Heartbeat

`OPERATING_MODEL.md` is the active gate for authority, approvals, external comms, and system-of-record boundaries. If this skill conflicts with `OPERATING_MODEL.md`, follow `OPERATING_MODEL.md` unless David gave a newer direct instruction.

The heartbeat is how the dashboard and other agents know you are alive. If you stop updating it, you appear DEAD.

**Mandatory:** Steps 0-13 run on EVERY heartbeat cron fire. Do not abbreviate later steps because they sit below a section break. Steps 6, 9, 10, and 11 are the `AGENTS.md` Memory Protocol heartbeat checkpoints; Steps 7, 8, and 12 close the goals, guardrail, and work-resumption loops. This file is the canonical Claude heartbeat procedure; `HEARTBEAT.md` must point here instead of duplicating it.

**Procedure-read preflight:** reading this file to obtain the procedure is preflight, not Step 0. Read it alone; do not bundle operational commands or unrelated file reads with that preflight. Once Step 0 starts, Step 1 must be the next operational command and must return successfully before any later command or file read. If this boundary is violated, name the first operational command that ran early in the guardrail event; do not classify the required procedure read itself as the violation.

**Cron-fire vs manual update (scope, so you do not over- or under-run):** the procedure below runs ONLY on a heartbeat-CRON fire. An `update-heartbeat` call on **session start** or **mid-task** (status refresh before a long operation) is **Step 1 only, by design** — it is NOT an abbreviated cron fire and must not trigger the full sweep. So: cron fire → full procedure; session-start / manual status → Step 1 alone. (Audit note: step coverage is graded only against actual cron fires; Step-1-only manual updates are correct, not "dropped steps.")

---

## Your Heartbeat Cron

Your `config.json` has a heartbeat cron (default every 4h). When it fires, run the complete procedure below.

**After Step 0 starts the duration record, Step 1 is a sequential barrier: `update-heartbeat` must finish before normal Step 2 or any later step runs and before any file is read.** A successful return enters the normal branch. A nonzero return enters only the narrow degraded branch: record the failure, write the degraded daily-memory checkpoint, close the timer degraded, and stop the fire. Only after successful Step 1 may independent later checks batch. Continue through Step 13; do not improvise an abbreviated version (audit 2026-06-08: later required steps were dropped after the first two ran).

```bash
bash "$CTX_FRAMEWORK_ROOT/orgs/$CTX_ORG/agents/_shared/scripts/heartbeat-timer.sh" start   # 0 duration instrumentation
if cortextos bus update-heartbeat "WORKING ON: <task>"; then                          # 1 foreground barrier
  cortextos bus check-inbox                                                           # 2
  cortextos bus log-event heartbeat agent_heartbeat info --meta "{\"agent\":\"$CTX_AGENT_NAME\",\"status\":\"active\"}"  # 3
  cortextos bus list-tasks --agent $CTX_AGENT_NAME --status in_progress               # 4 (flag >2h stale)
  cortextos bus log-event action approvals_cron_fired info --meta "{\"agent\":\"$CTX_AGENT_NAME\",\"source\":\"heartbeat-fold\"}"  # 5a
  cortextos bus list-tasks --status pending --format json | jq '[.[] | select(.assigned_to == "human" or .assigned_to == "david" or .project == "human-tasks")]'  # 5b discovery only
  cortextos bus list-approvals --format json                                          # 5c
  mkdir -p memory && TODAY=$(date -u +%Y-%m-%d)                                       # 6 daily-memory checkpoint (Memory Protocol Layer 1)
  cat >> "memory/$TODAY.md" << MEMEOF

## Heartbeat - $(date -u +%H:%M) UTC
- Current focus: <what I am working on and why>
- Active threads: <anything in progress or being monitored — state of each>
- Key decisions: <decisions made since last entry with brief rationale>
- Context notes: <anything non-obvious — user preferences discovered, environment state, blockers>
- Next: <what I am doing next>
MEMEOF
else
  cortextos bus log-event error heartbeat_update_failed error --meta "{\"agent\":\"$CTX_AGENT_NAME\",\"step\":1}"
  mkdir -p memory && TODAY=$(date -u +%Y-%m-%d)
  cat >> "memory/$TODAY.md" << MEMEOF

## Heartbeat - $(date -u +%H:%M) UTC
- Status: degraded
- Failure: Step 1 update-heartbeat returned nonzero; normal Steps 2-12 did not run.
- Next: investigate heartbeat status before resuming work.
MEMEOF
  bash "$CTX_FRAMEWORK_ROOT/orgs/$CTX_ORG/agents/_shared/scripts/heartbeat-timer.sh" end degraded
fi
```

The degraded branch is terminal for that fire. After it closes the timer, do not continue into the annotated reference or Steps 7-12.

**Normal-branch completion gate:** after Step 1 succeeds, running only Steps 1-2 leaves the heartbeat INCOMPLETE. Steps 3 (event), 4 (task check), 5 (approvals sweep), 6 (daily-memory checkpoint), 7 (goals), 8 (guardrail check), 9 (durable-memory update), 10 (kb-ingest), 11 (MEMORY.md cap check), and 12 (resume decision) are mandatory before a successful fire closes. The sweep is invisible if 5a never logs ("0 sweeps = approvals unattended"), and a successful fire that leaves no `## Heartbeat` entry in today's UTC memory file is equally incomplete. A failed Step 1 closes only through the terminal degraded branch above; it must not run normal Steps 2-12.

The annotated per-step reference follows:

```bash
# 1. Update your heartbeat with what you're doing
cortextos bus update-heartbeat "WORKING ON: <current task summary>"

# 2. Check inbox for messages
cortextos bus check-inbox

# 3. Log heartbeat event
cortextos bus log-event heartbeat agent_heartbeat info \
  --meta "{\"agent\":\"$CTX_AGENT_NAME\",\"status\":\"active\"}"

# 4. Check your task queue for anything stale
# MANDATORY — do not skip even when running alongside other crons
cortextos bus list-tasks --agent $CTX_AGENT_NAME --status in_progress
# Flag any task that has been in_progress for >2h without a memory update

# 5. Approvals sweep (folded from check-approvals cron, RFC #8) — MANDATORY on every fire
# 5a. Confirm the sweep cycle fired (replaces the old approvals_cron_fired event)
cortextos bus log-event action approvals_cron_fired info \
  --meta "{\"agent\":\"$CTX_AGENT_NAME\",\"source\":\"heartbeat-fold\"}"

# 5b. Human task queue — assignee- or project-marked pending tasks
cortextos bus list-tasks --status pending --format json | jq '[.[] | select(.assigned_to == "human" or .assigned_to == "david" or .project == "human-tasks")]'
#
# THIS RESULT IS FLEET-WIDE AND IS DISCOVERY ONLY.
# Seeing a task does not authorize reminding David about it. Age and assignee are
# not authority: "assigned to david and 24h old" describes every lane's backlog,
# not yours. Reminding on that basis is how one agent ends up speaking for a
# department it does not run.
#
# POSITIVE LANE GATE — require ONE of these, established affirmatively before
# any reminder. Absence of an obvious other owner is NOT a qualifying proof.
#   (a) OWNED: this agent created or requested the task, and it is still in this
#       agent's operating lane; or
#   (b) BLOCKING: it directly blocks a goal-linked task this agent owns right
#       now — name that task and the blocking edge in the reminder itself; or
#   (c) GRANTED: OPERATING_MODEL.md explicitly gives this agent org-wide or
#       orchestrator ownership of the human queue.
#
# For each task selected above that PASSES the lane gate (selection is by
# human/David assignee OR "human-tasks" project):
#   - If created >24h ago with no update: send ONE Telegram reminder.
#   - If blocking agent work: surface explicitly with the blocking context.
#   - If night mode (after 19:30 ET): defer reminders to next morning-review.
#   - State the qualifying proof (a/b/c) in the reminder so the decision is
#     auditable after the fact.
#
# For an out-of-lane task: DO NOT contact David. Leave it with its recorded
# owner. If ownership looks stale or absent, raise it to the orchestrator over
# the bus — internal escalation, not a human ping.
#
# See knowledge.md, "Lane-Owned David-Ask Routing" — same principle at the
# decision-ask surface: each lane carries its own asks to David.

# 5c. Pending approvals — list and re-ping if stale
cortextos bus list-approvals --format json
```

The standalone `check-approvals` cron was retired — heartbeat absorbs it. Run this sweep on every heartbeat cycle. **0 sweeps = system thinks approvals are unattended.**

For each pending approval in 5c, check `created_at`:
- If pending >4h AND it's day mode (07:30-19:30 ET) AND no re-ping has been sent yet for this approval → send ONE re-ping:
  ```bash
  cortextos bus send-telegram "$CTX_TELEGRAM_CHAT_ID" \
    "Reminder: approval for '<title>' is still pending. No rush, just flagging."
  ```
- Send only ONE re-ping per approval. Do not spam.
- Night mode (after 19:30 ET): skip re-pings, defer to next day's first heartbeat.

If both queues are empty, no Telegrams go out. The 5a `log-event` confirms the sweep fired regardless.

For full approvals workflow (creating new approvals, blocking tasks, etc.) see `.claude/skills/approvals/SKILL.md` — that skill is still loaded on-demand for the create/block path; only the periodic sweep moved here.

---

## Steps 6-12: Memory, Goals, Guardrails, and Work Resumption

Step 6 is the daily-memory checkpoint in the block above. Substitute its `<placeholders>` with real state before writing. Steps 7, 8, 9, and 12 were promoted from fleet-local `HEARTBEAT.md` files on 2026-07-30. Steps 10-11 were added to the mandatory procedure by the 2026-07-01 memory diagnosis. This file is the canonical per-fire checkpoint list; if `AGENTS.md` disagrees, update both in the same change.

### Step 7: Check GOALS.md

Read `GOALS.md`. Goals are refreshed by the orchestrator each morning.

- If goals were updated today and no matching tasks exist, create the tasks now.
- If goals are stale beyond 24 hours or empty, message the orchestrator for fresh goals. Do not infer new authorization from stale goals.

### Step 8: Guardrail Self-Check

Ask: did I skip a procedure this cycle, or rationalize not doing something required? If yes, log a `guardrail_triggered` action event naming the guardrail and what happened. If a new recurring pattern surfaced, add it to `GUARDRAILS.md`.

### Step 9: Update Long-Term Memory

If this cycle produced a durable pattern, user preference, system behavior, correction, or decision, append it to `MEMORY.md`. Keep `MEMORY.md` an index rather than a transcript; archive narratives under `archive/memory/`.

### Step 10: Re-ingest Memory

Run this after Step 9 so any durable-memory change is searchable in the same heartbeat:

```bash
ING=(./MEMORY.md "./memory/$TODAY.md")
for d in ./knowledge/policy ./knowledge/lessons ./knowledge/ops ./knowledge/projects; do
  [ -d "$d" ] && ING+=("$d")
done
cortextos bus kb-ingest "${ING[@]}" --org "$CTX_ORG" --agent "$CTX_AGENT_NAME" --scope private --force
```

The zsh array keeps each source as a distinct argument and remains safe for agents without a `knowledge/` tree. Do not replace it with a space-delimited scalar. Requires `GEMINI_API_KEY`; if ingest errors or policy-blocks every source, note it in the memory entry.

**WARNING - the success line lies on refusal (mechanism, checkable):** a privacy-wall refusal prints `Blocked`, then `Ingested 0 new chunk(s)`, then `Ingest complete` and exits 0. Success = a NONZERO chunk count (or embedding-token cost) in the output - never the final line, never the exit code. If chunks=0 on sources that should have ingested, record the ingest as BLOCKED in the heartbeat memory entry, not as complete. (Single-copy caution promoted fleet-wide 2026-07-31 from an agent OPERATING_MODEL:36.)

### Step 11: Check the MEMORY.md Size Cap

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

The explicit platform branch prevents GNU `stat -f` output from contaminating the captured size before a fallback. A measured zero remains `measured`; command failure or nonnumeric output becomes `unmeasurable` and reports loudly instead of looking like a healthy empty file. If the cap warning prints, queue an archive pass in the current session; do not leave the cap breached across fires.

### Step 12: Decide What Work Resumes

Pick the highest-priority task that traces to current goals. Move it to `in_progress` when starting and complete it with an artifact-bound result when done. If it is blocked, record the dependency, human task, or approval instead of leaving a silent blocker. Actual task execution resumes only after this heartbeat procedure closes.

### Step 13: Close the duration record — LAST ACTION OF THE FIRE

```bash
bash "$CTX_FRAMEWORK_ROOT/orgs/$CTX_ORG/agents/_shared/scripts/heartbeat-timer.sh" end ok
```

Run this even on a degraded or partial fire, with a status other than `ok`
(`heartbeat-timer.sh end degraded`). A fire that starts and never ends is recorded as
**abandoned** by the next start, which is a real signal about how long fires actually run
— do not let it be silently overwritten by skipping this step.

**Why it exists:** `last_idle.flag` is written by the Stop hook, and Stop fires when the
session queue DRAINS, not at turn end. Measured 2026-08-01 — the flag held 16:18:23Z past
18:00Z on an agent that completed many turns in between. So flag-to-flag measures
queue-drain, not work.

The timer starts only after a cron dispatch enters agent execution. A scheduler or model-service rejection before the first agent command produces no timer row. Therefore timer rows measure procedure entries and spans, not the denominator of attempted cron fires. For denominator or delivery reliability, pair them with daemon scheduler attempted/completed events. A missing timer row is not evidence that no cron fire occurred. These records are placement telemetry only; build-window clearance remains a separate frontier decision.

---

## Concurrent Cron Handling

When heartbeat fires at the same time as another cron (e.g., approvals):
- Run BOTH skill sequences fully — do not merge or abbreviate. Steps 3 through 12 are all mandatory even under concurrent-cron load.
- Both log-event calls must execute separately
- Both memory entries must be written
- Do not drop steps 3-12 because another cron is running

## Degraded Shell Handling

If shell commands fail (exit code 1 on all commands):
1. Alert David via direct Telegram API using WebFetch
2. Write a degraded heartbeat memory entry using the Write tool
3. Do not claim "heartbeat complete" - mark as "heartbeat degraded, shell broken"

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
