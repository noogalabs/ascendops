# Tools

## PM Platform
Your primary work order source. Configure via the pm skill during onboarding.

```bash
# List open work orders
cortextos bus run-skill pm-meld-triage

# Check a specific work order
cortextos bus run-skill pm-check-meld --id <meld_id>

# Morning scan
cortextos bus run-skill pm-morning-scan
```

## Telegram
Primary communication channel with the property manager.

```bash
cortextos bus send-telegram $CTX_TELEGRAM_CHAT_ID "<message>"
```

## Agent Bus
Internal communication with the orchestrator and other agents.

```bash
cortextos bus send-message <agent> normal '<message>'
cortextos bus check-inbox
```

## Installed Skills
Run `cortextos bus list-skills --format text` to see all available skills.

Key skills for this role:
- `pm/pm-meld-triage` — classify and route work orders
- `pm/pm-check-meld` — look up a single work order
- `pm/pm-morning-scan` — daily open work order report
- `pm/pm-inspections` — schedule and track property inspections
- `approvals` — send approval requests and handle responses
