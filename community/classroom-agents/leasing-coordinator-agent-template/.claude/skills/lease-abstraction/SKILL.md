---
name: lease-abstraction
description: "Extract the key terms of a lease into structured data with source quotes, and flag any clause that is missing, ambiguous, or contradictory. Extract, do not interpret. The abstraction is a draft until a human confirms it."
---

# Lease Abstraction

{{agent_name}} uses this skill to pull the key terms out of a lease and into a clean schema instead of leaving them buried in a document. For every field it captures the value plus, where it helps, a short quote or section reference so a human can verify the source. It reads and structures; it does not fetch, store, or interpret.

---

## Hard Gate

Lease abstraction is extract-don't-interpret. {{agent_name}} pulls what the lease says; it does not decide what a clause legally means and it never invents a value to fill a blank. The abstraction is a draft until {{operator_name}} or the designated human confirms it becomes authoritative data downstream. Legal-meaning questions route to a human. This is not legal advice.

---

## Inputs

- The lease file (PDF, scan, or text) from a document source in your property-management system or file store
- Any prior abstraction or amendment, if available
- The target schema fields to populate

---

## Workflow

1. Read the full lease in context.
2. For each schema field, capture the value plus a short quote or section reference where it helps verification:
   - parties
   - term and start/end dates
   - rent and escalations
   - deposit
   - renewal and notice clauses
   - pet / parking / utility responsibilities
   - special terms
3. Mark any missing field as not-found rather than inferring a default.
4. Quote ambiguous clauses instead of picking a reading.
5. Surface both sides of any internal contradiction.
6. Flag low-confidence reads off a scan or a handwritten edit.
7. Assemble the structured abstraction with per-field source support and a flag list.
8. Route the abstraction to a human to confirm before it becomes authoritative.

---

## Output Contract

Return:
- structured field table: value plus source quote/section reference per field
- not-found fields explicitly marked
- ambiguous clauses with the quoted text and the competing readings
- internal contradictions with both sides shown
- low-confidence reads flagged
- confirmation request, marked `APPROVAL REQUIRED` before the data is treated as authoritative

---

## Validation

- Every populated field has a value and, where helpful, a source quote or reference.
- No blank was filled with an inferred default.
- Ambiguous and contradictory clauses are quoted, not resolved.
- No clause was interpreted for legal meaning.
- Empty and flagged beats full and wrong.
