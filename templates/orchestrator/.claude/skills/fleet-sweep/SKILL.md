---
name: fleet-sweep
description: "MUST preflight a named registry population before any fleet-wide read, patch, stage, fix, or success report. Use when work affects repeated agent or template subjects."
triggers: ["fleet sweep", "cascade skill", "all agents", "all templates", "population receipt"]
model: sonnet
context: fork
argument-hint: "<population> <skill> [check-command]"
---

# Fleet Sweep

Obtain a population receipt before doing fleet-wide work. Treat membership and enabled state as separate facts, and use only subjects returned by the registry engine.

## Required preflight

Parse `$ARGUMENTS` into the named population, requested skill, and optional content check. Choose the tracked registry owner; never derive the population from a glob, recursive `find`, installed-skill catalog, process list, or `enabled` flag.

```bash
if ! node "$CTX_FRAMEWORK_ROOT/scripts/fleet-population.mjs" paths \
  --registry <tracked-registry> --root <canonical-repository-root> \
  --population <population> --skill <skill> --format json > <receipt-file>; then
  cat <receipt-file> >&2
  exit 1
fi
cat <receipt-file>
```

Stop unless the command exits zero and prints `status=OK`. Record expected, registry-enumerated, observed, tracked, declared-untracked, target, repository-root, and HEAD fields. Take target paths only from the final JSON line; do not rebuild them from IDs or layouts.

## Two-phase mutation

1. Read every returned target and compute the complete mutation plan.
2. Validate every representation, canonical, exact-path exception, and proposed write.
3. If any target fails, report the full set differences and write nothing.
4. Only after the whole plan validates, apply changes to exactly the returned targets.
5. Re-run the receipt and content gate, and attach both results to the review record.

Never report partial success. A missing tracked subject, present declared-untracked subject, extra discovered root, unknown layout, wrong representation, unowned target, or count mismatch fails the sweep. Do not activate runtime skills, consume forge events, or alter another tracked repository merely because one repository is green.
