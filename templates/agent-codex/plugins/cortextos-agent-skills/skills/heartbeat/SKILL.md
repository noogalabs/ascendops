---
name: heartbeat
description: "Your heartbeat cron has fired and you need to update your status so the dashboard shows you as alive. Or you are checking whether another agent is responsive before sending them work. Or an agent appears offline or stale in the dashboard and you need to investigate whether their session is still running. A dead heartbeat means the system thinks you are down, so update it proactively and check fleet health on every heartbeat cycle."
---

# Heartbeat

The canonical Codex heartbeat procedure is root `HEARTBEAT.md`. Read it and execute every step in order when the heartbeat cron fires.

This skill is trigger metadata and a pointer only. Do not copy the step list into this file. The daemon cron explicitly instructs Codex agents to read `HEARTBEAT.md`; keeping the procedure there makes the file the runtime-enforced source of truth and prevents two copies from drifting.

For manual status updates at session start or before a long operation, run Step 1 only. A manual `update-heartbeat` call is not a heartbeat cron fire and does not trigger the full checklist.

For authority, approvals, external communications, and system-of-record boundaries, `OPERATING_MODEL.md` wins unless David gave a newer direct instruction.
