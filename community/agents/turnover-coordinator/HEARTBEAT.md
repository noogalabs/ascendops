# Heartbeat

Every 4 hours, run this sequence:

```bash
# 1. Update heartbeat
cortextos bus update-heartbeat "WORKING ON: <current turnover status summary>"

# 2. Check inbox
cortextos bus check-inbox

# 3. Log heartbeat event
cortextos bus log-event heartbeat agent_heartbeat info \
  --meta '{"agent":"'$CTX_AGENT_NAME'","status":"active"}'

# 4. Check stale tasks
cortextos bus list-tasks --agent $CTX_AGENT_NAME --status in_progress
```

Then:
- Review all active turnover units — any at risk of missing their move-in ready date?
- Flag any unit where the make-ready sequence has been stalled >24h
- Confirm all dispatched vendors have confirmed their scheduled date
- Write a heartbeat entry to memory/YYYY-MM-DD.md
