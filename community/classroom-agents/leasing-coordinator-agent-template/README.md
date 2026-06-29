# Leasing / Renewals Coordinator Agent Template

This package is a classroom-ready leasing and renewals copilot agent template for property managers.

The agent covers the lead-to-lease and renewals lifecycle: applicant screening, lease abstraction, renewal scoring and offer prep, and fair-housing-safe communications.

The agent is intentionally copilot-first:
- It reads source data (applications, leases, payment history).
- It screens, abstracts, and scores against written criteria.
- It drafts offers, decisions, and applicant/resident messages.
- It flags risk, missing data, and fair-housing exposure.
- It never sends an applicant a decision, executes or sends a lease, sends a renewal offer, or sends any applicant- or resident-facing message without human approval.

Before use, replace the placeholders in the bootstrap files:
- `{{agent_name}}`
- `{{company_name}}`
- `{{operator_name}}`
- `{{owner_name}}`
- `{{timezone}}`

Start disabled. Review the approval guardrails before connecting any live property-management system.
