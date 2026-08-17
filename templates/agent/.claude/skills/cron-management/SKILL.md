---
name: cron-management
description: "Manage scheduled tasks (crons). Crons are daemon-managed and stored in crons.json - they survive restarts automatically. Use when: verifying crons on session start, creating new recurring tasks, updating or removing crons, troubleshooting scheduled tasks, or using the dashboard test-fire button."
triggers: ["remind me", "every day", "every hour", "every week", "schedule", "recurring", "daily", "weekly", "cron", "loop", "check regularly", "monitor", "keep an eye on", "set up a reminder", "repeat every", "run every", "automate", "schedule task", "restore crons", "crons missing", "cron not firing", "session start crons", "persist cron"]
---

# Cron Management

Crons are **daemon-managed**. They are stored in `${CTX_ROOT}/.cortextOS/state/agents/$CTX_AGENT_NAME/crons.json`
and dispatched by the cortextOS daemon. Crons survive agent restarts, context compactions,
and daemon restarts automatically. You do NOT need to recreate them on session start.

**Never use `/loop` or CronCreate for persistent recurring work** - those are session-local
and die on agent restart.

---

## On Session Start

Check that your crons are registered. Do not recreate them unless they are missing.

```bash
cortextos bus list-crons $CTX_AGENT_NAME
```

If a cron is missing from the list, add it:

```bash
cortextos bus add-cron $CTX_AGENT_NAME <name> <interval|cron-expr> "<prompt>"
```

---

## Adding a Recurring Cron

**Interval shorthand** (s/m/h/d/w):
```bash
cortextos bus add-cron $CTX_AGENT_NAME heartbeat 6h "Read HEARTBEAT.md and follow its instructions."
cortextos bus add-cron $CTX_AGENT_NAME health-check 30m "Check system health and report anomalies."
```

**5-field cron expression** (minute hour dom month dow):
```bash
cortextos bus add-cron $CTX_AGENT_NAME morning-report "0 9 * * 1-5" "Generate and send the daily analytics report."
cortextos bus add-cron $CTX_AGENT_NAME weekly-summary "0 17 * * 5" "Compile and deliver the weekly summary."
```

The daemon reloads automatically after `add-cron`. Confirm with `list-crons`.

---

## One-Shot Actions (fire once at a future time)

There are TWO mechanisms; they behave differently. Pick by whether the time is
precise/critical or "next time I wake."

**1. Persistent reminder - surfaces at your NEXT boot/restart (NOT real-time).**
`create-reminder` writes a persistent reminder that the daemon injects into your
boot/continue prompt the next time you start a session at-or-after `fire_at`. It
survives every restart type. It does **NOT** interrupt a running session at the
exact time - if you keep running past `fire_at` with no restart, it waits until
your next wake. Use it for "next time you wake after X, do Y" - never for a
time-critical fire.

```bash
cortextos bus create-reminder <fire-at-ISO-8601-UTC> "<prompt surfaced on next boot if overdue>"
# e.g. cortextos bus create-reminder 2026-04-05T19:00:00Z "On next wake, follow up on the call."
cortextos bus list-reminders          # pending reminders
cortextos bus ack-reminder <id>        # mark handled
```

**2. Precise wall-clock fire on a running agent - self-removing recurring cron.**
The daemon cron scheduler fires crons at their wall-clock time mid-run, but it
has no native one-shot (`type: once` is not supported). For a true "fire at 3pm
today" on a running agent, add a recurring cron at that minute whose prompt does
the action **and then removes itself** - the established self-removing pattern
(see the `telnyx-10dlc-campaign-poll` skill, "self-removes when done"):

```bash
cortextos bus add-cron $CTX_AGENT_NAME remind-3pm "0 15 * * *" \
  "Do <the one-time action>, then run: cortextos bus remove-cron $CTX_AGENT_NAME remind-3pm"
```

Rule of thumb: repeats → recurring cron; precise one-time wall-clock fire →
self-removing cron; "handle on next wake" → `create-reminder`.

---

## Updating a Cron

```bash
# Change the schedule
cortextos bus update-cron $CTX_AGENT_NAME heartbeat --interval 4h

# Update the prompt
cortextos bus update-cron $CTX_AGENT_NAME heartbeat --prompt "New prompt text."

# Disable (stops firing without removing it)
cortextos bus update-cron $CTX_AGENT_NAME heartbeat --enabled false

# Re-enable
cortextos bus update-cron $CTX_AGENT_NAME heartbeat --enabled true
```

---

## Removing a Cron

```bash
cortextos bus remove-cron $CTX_AGENT_NAME <name>
```

---

## Testing a Cron Immediately

From the dashboard (`/workflows/$CTX_AGENT_NAME/<name>`), click **Test Fire** to inject the
cron's prompt immediately. A 30-second cooldown prevents accidental rapid-fires.

Set `manualFireDisabled: true` on a cron definition to block dashboard test-fires (e.g. for
crons that must only fire on schedule).

---

## Checking Execution History

```bash
# All crons for this agent
cortextos bus get-cron-log $CTX_AGENT_NAME

# Filter to a specific cron
cortextos bus get-cron-log $CTX_AGENT_NAME <name>
```

Each log entry: `ts`, `cron`, `status` (fired/retried/failed), `attempt`, `duration_ms`, `error`.

---

## Troubleshooting

**Cron not firing:**
1. `cortextos bus list-crons $CTX_AGENT_NAME` - confirm it is registered and not disabled.
2. `cortextos bus get-cron-log $CTX_AGENT_NAME <name>` - check for `status: failed` entries.
3. Check daemon log: `~/.cortextos/$CTX_INSTANCE_ID/logs/$CTX_AGENT_NAME/`

**`crons.json` corrupted:**
- `readCrons` automatically falls back to `crons.json.bak` on parse failure. Usually self-healing.
- If both files are bad, re-add crons via `add-cron` or force re-migration:
  `cortextos bus migrate-crons $CTX_AGENT_NAME --force`

**Scheduler retained stale schedule after reload:**
- If a reload produces an empty schedule (transient corruption), the daemon keeps the last-good
  schedule in memory (`lastGoodSchedule`). Crons keep firing. Repair `crons.json` and the
  scheduler recovers automatically on the next reload.
