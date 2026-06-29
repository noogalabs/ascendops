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

Start disabled. Review the approval guardrails before connecting live financial systems.
