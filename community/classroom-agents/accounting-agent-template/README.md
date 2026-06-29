# Accounting Agent Template

This package is a classroom-ready accounting copilot agent template for property managers.

The agent is intentionally copilot-first:
- It reads source data.
- It verifies and reconciles.
- It drafts financial artifacts.
- It flags discrepancies.
- It never moves money, posts ledger corrections, sends owner draws, returns deposits, releases vendor payments, or sends external financial documents without human approval.

Before use, replace the placeholders in the bootstrap files:
- `{{agent_name}}`
- `{{company_name}}`
- `{{operator_name}}`
- `{{owner_name}}`
- `{{timezone}}`
- `{{maintenance_agent_name}}`
- `{{leasing_agent_name}}`

## Setup (manual)

This template ships with placeholders, not a guided setup wizard yet. To stand it up:

1. Unzip into your install's `templates/` folder and run `cortextos add-agent my-accounting --template accounting-agent-template`.
2. Replace the placeholders above in the bootstrap files (IDENTITY.md, SOUL.md, GOALS.md, AGENTS.md, CLAUDE.md, MEMORY.md, SYSTEM.md, TOOLS.md, USER.md, HEARTBEAT.md, GUARDRAILS.md, config.json, goals.json) with your own values.
3. Put this agent's Telegram bot token and chat id in its `.env`.
4. Start it: `cortextos start my-accounting`.

The agent boots in copilot mode: it reads, verifies, and drafts, and never takes an external or money action without your approval. Review the approval guardrails before you connect any live financial system.

## Recommended crons (add after setup)

This template ships with NO active crons on purpose: a fresh template should not run scheduled work before it is configured. Once the agent is set up, add the ones you want. Each is added with `cortextos bus add-cron <your-agent-name> <name> "<schedule>" "<prompt>"`, where `<schedule>` is an interval like `2h`/`30m`/`1d` or a 5-field cron expression like `0 8 * * 1-5`:

- `heartbeat`, schedule `2h`: Read HEARTBEAT.
- `ar-digest`, schedule `0 8 * * 1-5`: Run the ar-rent-posting skill in digest mode: read ledgers, verify payment application, and prepa....
- `bank-rec-am`, schedule `0 8 * * 1-5`: Run trust-reconciliation in morning verify-and-flag mode.
- `bank-rec-pm`, schedule `0 17 * * 1-5`: Run trust-reconciliation in evening verify-and-flag mode.
- `owner-statements-monthly`, schedule `0 9 1 * *`: Run owner-statement-drafting for the prior month: draft explainable statements and owner-draw rec....
- `deposit-deadline-watch`, schedule `30 8 * * *`: Run security-deposit-accounting deadline review.
