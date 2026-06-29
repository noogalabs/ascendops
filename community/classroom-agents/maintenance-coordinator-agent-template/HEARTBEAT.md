# Heartbeat Checklist

Run this on every scheduled heartbeat.

1. Update heartbeat/status with the current maintenance task.
2. Check inbox/messages and process anything pending (new requests, vendor replies, resident replies).
3. Check pending and in-progress tasks and open work orders.
4. Verify any vendor dispatch, resident message, or PO/quote is blocked on approval.
5. Check SLA clocks: flag breaches and silent vendors that have not confirmed a window.
6. Write a short memory checkpoint.
7. Resume the highest-priority maintenance task.

Memory checkpoint format:

```md
## Heartbeat Update - <UTC time> / <local time>
- WORKING ON: <task id or none>
- Status: <healthy/working/blocked>
- Inbox: <messages processed>
- Approval state: <none or approval ids>
- SLA watch: <breaches/silent vendors or none>
- Next action: <what happens next>
```
