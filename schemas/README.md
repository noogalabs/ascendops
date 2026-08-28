# Lifecycle status schemas

These checked-in JSON Schemas are the normative machine-readable contracts for
`cortextos lifecycle status`.

`cortext.status/v1` and `cortext.status.redacted/v1` describe the legacy bridge
profile only. Managed lifecycle profiles will use a future discriminated
contract instead of placing non-null managed evidence into this legacy shape.
Check results bind each policy to its exact v1 identifier and require empty
reasons on pass or at least one unique policy-specific reason on failure.
Passing results are additionally bound to the snapshot facts required by the
policy evaluator; the legacy `update-safe` policy has no passing schema branch.
Healthy summaries and checks require a running, responsive daemon and canonical
info-only observations; usable checks reject canonical blocking observations.
Observations that make legacy collection incomplete are declared once in the
shared partial-observation manifest; collectors, redaction, checks, schemas, and
data-driven mutation tests all consume that invariant.
Observation codes are bound to their fixed severity and domain. Redacted error
codes are likewise bound to one static message and detail code. Redacted
capabilities, observations, isolation evidence, and version strings are closed
public surfaces, and report identifiers and observation days use their exact
emitted formats. The redactor reconstructs observation metadata and derived
overall fields before recomputing checks rather than copying untrusted
assertions or strings.

When a status type changes, update its schema and the corresponding TypeScript
type together. Run the focused lifecycle and schema tests before committing:

```bash
npm test -- --run tests/unit/lifecycle/legacy-status.test.ts tests/unit/lifecycle/status-schema.test.ts
npm run build && node scripts/verify-lifecycle-status-cli.mjs
```

The schema tests validate emitted local and redacted snapshots, both error
envelopes, and recursive rejection of additional redacted properties. Schema
generation is intentionally not part of dependency installation: contributors
on every supported Node version receive the same reviewed contracts without an
additional code-generation supply chain.
