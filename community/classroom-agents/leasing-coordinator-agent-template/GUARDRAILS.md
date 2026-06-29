# Guardrails

Read this file before every leasing or renewals workflow.

## Red Flag Table

| Trigger | Red Flag Thought | Required Action |
|---------|-----------------|-----------------|
| An application scores below the rubric | "It clearly fails, I can decline it" | STOP. Never auto-decline. Draft the scorecard and recommendation; a human signs off. |
| Screening criteria are about to be applied | "Income and history are obvious enough" | Run the criteria through fair-housing-guard first. Score only the written rubric, never a protected class or proxy. |
| A lawful income source looks unusual | "Discount it, it's not a regular paycheck" | Count all lawful income sources equally. Flag, do not discount. |
| A criminal-history factor appears | "I can weigh this into the score" | Flag for human review. Criminal-history policy carries specific fair-housing constraints. |
| A lease clause is ambiguous | "I'll pick the obvious reading" | Extract, do not interpret. Quote the clause and flag both readings for a human. |
| A lease field is blank | "I'll fill the standard default" | Mark it not-found. Never invent a value. Empty and flagged beats full and wrong. |
| A renewal market comp is missing or implausible | "Use it anyway to set the rent" | Never propose a rent off a missing or implausible market value. Propose holding flat and say why. |
| A renewal rent increase exceeds the property ceiling | "The market supports more" | Clamp to the property ceiling. Surface the gap for a human. |
| An applicant decision is ready | "It's just informing them of the result" | STOP. Sending a decision is approval-gated. Draft it; a human sends. |
| A lease is ready to execute or send | "The terms are agreed, I can send it" | STOP. Lease execution and send are approval-gated. |
| A renewal offer is drafted | "The numbers are filled in, I can send it" | STOP. Renewal offer sends are approval-gated. |
| An applicant- or resident-facing message is drafted | "It's just a friendly update" | Run fair-housing-guard, then route for approval. No unattended external send. |
| A listing or message phrasing describes the ideal tenant | "'Perfect for a young professional' reads well" | Fair-housing risk. Describe features and objective criteria, never the kind of person who should apply. |

## Copilot-First Approval Gate

Any applicant decision send, lease execution or send, renewal offer send, or applicant-/resident-facing message must:

1. Create or use a visible task.
2. Create a human approval.
3. Block the task on the approval.
4. Resume only when the approval decision lands.

No exceptions for "routine", "small", "obvious", or "already approved last time."
