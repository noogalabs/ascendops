# Build Notes — Accounting Coordinator Template

This template was genericized into the canonical role-agent shape, mirroring the
`leasing-coordinator` template's file set, voice, and bundled rule-skills.

## Accounting data connector is pulled via MCP — NOT baked in

The accounting data connector (the thing that reads ledgers, rent rolls, bank
feeds, and invoice packets) is **pulled via the Skool community-skills MCP during
onboarding (v2 wire-up) — it is not baked into this template.** This is the
pluggable model: the operator wires their own platform read connector at onboarding
and keeps it read-only. Until it is wired, the agent operates on exports/uploads the
operator drops in (export-fallback mode, see ONBOARDING.md Step 3).

No MCP server is stubbed or faked here. `.mcp.json` matches the leasing template
(icm only). The connector is registered through `.claude/skills/tool-registration/`
when the operator pulls it.

## Intentional differences vs `leasing-coordinator`

1. **Four connector / endpoint-discovery skills removed** (rule-skills-only build):
   the browser-automation skill, the two cli-anything / endpoint-discovery skills,
   and the PM work-order endpoint connector skill that the leasing template bundles
   under `.claude/skills/`. These are connectors / browser-automation / cli-anything
   tooling. They are excluded by design — the accounting connector arrives via MCP
   instead. (Run a file-set diff against `leasing-coordinator` to see exactly
   which four skill directories are absent.)
2. **This BUILD-NOTES.md** is added (not present in leasing).

Every other file mirrors the leasing template's file set. Role-specific docs
(IDENTITY, SOUL, GUARDRAILS, GOALS, goals.json, config.json heartbeat prompt,
AGENTS.md, CLAUDE.md, ONBOARDING.md) were rewritten for the accounting role.

## Copilot-first money safety (preserved generically)

The load-bearing rule from the source accounting agent is preserved without any
operator-internal names: read / verify / draft / flag freely, but never release
funds, post a ledger correction, move trust money, return a deposit, send an owner
draw, or send an external financial document without explicit human approval through
the approvals gate. See SOUL.md (Money-Movement Rule + Operating Rings) and
GUARDRAILS.md (Accounting-Specific Patterns + Copilot-First Approval Gate).

## CLI convention

The template uses the `ascendops` CLI throughout (matching the leasing template);
`ascendops` and `cortextos` are the same binary. All placeholders use the
`{{double_brace}}` convention and are filled in at onboarding.
