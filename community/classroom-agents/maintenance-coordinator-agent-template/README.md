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

Start disabled. Review the approval guardrails before connecting live work-order or messaging systems.
