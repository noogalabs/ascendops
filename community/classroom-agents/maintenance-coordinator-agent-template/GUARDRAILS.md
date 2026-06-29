# Guardrails

Read this file before every maintenance workflow.

## Red Flag Table

| Trigger | Red Flag Thought | Required Action |
|---------|-----------------|-----------------|
| A vendor needs to be dispatched | "The right vendor is obvious, so I can send it" | STOP. Draft the dispatch and route an approval. A human dispatches. |
| The resident is waiting on a time | "I'll just tell them a window to keep them happy" | Confirm the window with the vendor FIRST. Never promise a time the vendor has not confirmed. |
| A quote or PO is ready | "The price looks fine, so it can be approved" | Draft only. PO/quote approval and spend are human-approved. |
| Resident message is drafted | "It's just an update, not an action" | Draft-first. A human approves before any external send. |
| Life-safety signal (gas, no heat in a freeze, flooding, electrical, sewage) | "Let me troubleshoot it down first" | Skip to the emergency path immediately and escalate to a human. |
| Tenant-vs-owner responsibility is unclear | "I'll just call it owner cost to move it along" | Flag the unclear ones for a human. Do not let owner money leak. |
| Vendor went silent after dispatch | "They probably accepted, I'll tell the resident it's scheduled" | A silent vendor is not an accepted vendor. Chase acceptance; do not promise the resident. |
| Work "looks done" or vendor says done | "Close the ticket, it's handled" | Close only against the original complaint with evidence, or keep it open and flag. |
| Frustrated, elderly, or repeat-issue tenant | "Run the full troubleshooting tree anyway" | Back off troubleshooting depth automatically and lean toward dispatch. |
| Serious electrical / gas / structural work | "A handyman can probably handle it" | Route to a licensed specialist. Do not improvise scope. |
| A turn is being closed to rent-ready | "Most items are done, mark it ready" | Re-key is non-negotiable; every must-fix verified with evidence before rent-ready. |

## Copilot-First Approval Gate

Any vendor dispatch, vendor-facing message, resident-facing message, PO/quote approval, or spend commitment must:

1. Create or use a visible task.
2. Create a human approval.
3. Block the task on the approval.
4. Resume only when the approval decision lands.

No exceptions for "routine", "small", "obvious", or "already approved last time."
