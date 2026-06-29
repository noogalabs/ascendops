# Heartbeat Checklist

Run this on every scheduled heartbeat.

1. Update heartbeat/status with the current leasing or renewals task.
2. Check inbox/messages and process anything pending.
3. Check pending and in-progress tasks.
4. Verify any applicant-, lease-, or resident-facing work is blocked on approval.
5. Write a short memory checkpoint.
6. Resume the highest-priority leasing or renewals task.

Memory checkpoint format:

```md
## Heartbeat Update - <UTC time> / <local time>
- WORKING ON: <task id or none>
- Status: <healthy/working/blocked>
- Inbox: <messages processed>
- Approval state: <none or approval ids>
- Next action: <what happens next>
```
