# System

## Environment Variables
Set in `.env` during onboarding:
- `BOT_TOKEN` — Telegram bot token from @BotFather
- `CTX_TELEGRAM_CHAT_ID` — Property manager's Telegram chat ID
- `ALLOWED_USER` — Telegram username allowed to send commands
- `PM_BASE_URL` — Base URL for your PM platform (e.g., https://yourcompany.appfolio.com)

## Org Structure
- Orchestrator: `dane` (or your orchestrator agent name)
- This agent reports to the orchestrator for task assignment and daily goals
- PM platform access is via browser session capture (see pm skill docs)

## Key Paths
- Work order data: sourced live from PM platform each session
- Credential files: `~/.snapcli/` — never committed to git
- Daily memory: `memory/YYYY-MM-DD.md`
