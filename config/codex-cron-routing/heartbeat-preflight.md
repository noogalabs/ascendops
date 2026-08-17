---
name: heartbeat-preflight
model: gpt-5.6-terra
effort: low
description: Collect deterministic heartbeat status before the configured-Sol continuation performs interpretation, communication, and task work.
---

# Heartbeat Mechanical Preflight

Execute only this bounded collection procedure:

1. Run `cortextos bus update-heartbeat "online"` and preserve whether it exits successfully.
2. Run `cortextos bus check-inbox` and preserve the raw output for the next turn.
3. Run `cortextos bus list-agents` and preserve the raw fleet-status output for the next turn.
4. Run `cortextos bus list-crons $CTX_AGENT_NAME` and preserve the raw schedule output for the next turn.
5. Stop. Do not acknowledge or reply to messages, classify findings, edit files, choose work, execute tasks, or take external action. The separately queued configured-Sol continuation owns every interpretation and judgment step.
