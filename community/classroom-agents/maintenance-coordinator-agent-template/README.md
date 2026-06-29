# Maintenance Coordinator Agent Template

This package is a classroom-ready maintenance coordinator copilot agent template for property managers.

The agent runs a maintenance request from the first tenant message to a closed work order: intake, triage, troubleshooting, vendor coordination, scheduling, verification, and close-out. It also coordinates make-ready and turnover work on vacant units.

The agent is intentionally copilot-first:
- It reads inbound requests, work orders, units, access details, and inspection media.
- It triages urgency, decides tenant-vs-owner responsibility, and picks the right vendor.
- It drafts every vendor dispatch and every resident message.
- It tracks acceptance, SLA clocks, and verifies the work is genuinely done against the original complaint.
- It never dispatches a vendor, messages a resident, or approves a PO/quote without human approval.
- It confirms with the vendor and gets a real window BEFORE telling the resident any time.

Before use, replace the placeholders in the bootstrap files:
- `{{agent_name}}`
- `{{company_name}}`
- `{{operator_name}}`
- `{{owner_name}}`
- `{{timezone}}`
- `{{leasing_agent_name}}`

## Setup (manual)

This template ships with placeholders, not a guided setup wizard yet. To stand it up:

1. Unzip into your install's `templates/` folder and run `cortextos add-agent my-maintenance --template maintenance-coordinator-agent-template`.
2. Replace the placeholders above in the bootstrap files (IDENTITY.md, SOUL.md, GOALS.md, AGENTS.md, CLAUDE.md, MEMORY.md, SYSTEM.md, TOOLS.md, USER.md, HEARTBEAT.md, GUARDRAILS.md, config.json, goals.json) with your own values.
3. Put this agent's Telegram bot token and chat id in its `.env`.
4. Start it: `cortextos start my-maintenance`.

The agent boots in copilot mode: it reads, verifies, and drafts, and never takes an external or money action without your approval. Review the approval guardrails before you connect any live work-order or messaging system.

## Recommended crons (add after setup)

This template ships with NO active crons on purpose: a fresh template should not run scheduled work before it is configured. Once the agent is set up, add the ones you want. Each is added with `cortextos bus add-cron <your-agent-name> <name> "<schedule>" "<prompt>"`, where `<schedule>` is an interval like `2h`/`30m`/`1d` or a 5-field cron expression like `0 8 * * 1-5`:

- `heartbeat`, schedule `2h`: Read HEARTBEAT.
- `intake-sweep`, schedule `30m`: Run the intake-triage skill on any new inbound maintenance requests: categorize, rank severity, d....
- `sla-watch`, schedule `1h`: Run vendor-coordination SLA review: flag silent vendors that have not confirmed a window, respons....
- `open-wo-digest`, schedule `0 8 * * 1-5`: Run an open work-order digest: list every open ticket with severity, vendor status, SLA state, an....
- `make-ready-review`, schedule `0 9 * * 1-5`: Run make-ready-scheduling for active turns: refresh the trade sequence, recompute the critical pa....
