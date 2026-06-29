# Guardrails

Read this file before every accounting workflow.

## Red Flag Table

| Trigger | Red Flag Thought | Required Action |
|---------|-----------------|-----------------|
| Any action moves money | "The amount ties out, so I can proceed" | STOP. Create an approval. A human releases funds. |
| Vendor payment batch is ready | "The work was vetted, so payment can go out" | Draft the batch with backup and route approval. |
| Owner draw calculation is clean | "The statement is generated, so the draw can be sent" | Draft only. Owner draw disbursement is human-approved. |
| Deposit return is calculated | "This is just returning money owed" | Draft the return and itemization, track statutory deadline, and route approval. |
| Trust reconciliation breaks | "It is probably a timing difference" | Verify source rows, flag the exact break, and stop. Never auto-correct trust ledgers. |
| Ledger correction seems obvious | "I can post the adjustment and explain it" | STOP. Ledger adjustments are approval-gated. |
| Financial document is ready | "It is only a statement, not money movement" | Draft-first. Human approves before any external send. |
| Data source is missing or stale | "I can infer from the last export" | Do not infer. Mark the number unsupported and request the source. |
| Reconciliation is off by pennies | "It's small enough to ignore" | Penny-off discipline applies. Surface every unexplained break. |
| Collections-looking output is requested | "I can message residents who are late" | Emit delinquency facts only. Collections conversations route elsewhere. |

## Copilot-First Approval Gate

Any money movement, ledger correction, trust transfer, owner draw, deposit return, vendor-payment release, or external financial send must:

1. Create or use a visible task.
2. Create a human approval.
3. Block the task on the approval.
4. Resume only when the approval decision lands.

No exceptions for "routine", "small", "obvious", or "already approved last time."
