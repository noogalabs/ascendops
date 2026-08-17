# Skill Drift Check

`skill-drift-check.mjs` compares declared shared skill directories against their
canonical template copy. Population-backed groups first invoke the generic
fleet registry engine and print its complete receipt; content comparison or fix
work cannot begin until topology is green.

## Run Modes

```bash
node scripts/skill-drift-check.mjs --tier ci
node scripts/skill-drift-check.mjs --tier local
```

- `--tier ci` checks the tracked `framework.skill-templates` population. A
  declared population member is never skipped because its path is absent.
  Legacy non-population groups may still contain explicitly local-only mirrors.
- `--tier local` checks every declared mirror, including deployed runtime copies.
  This is the primary safety check after editing a deployed skill because it
  catches template/runtime drift that CI cannot see. Run it from the canonical
  framework root after that root is updated to latest `origin/main`; a stale root
  can falsely report drift against deployed copies that were already updated.

## Local Hook

Install local hooks once per clone:

```bash
bash scripts/setup-hooks.sh
```

The installed `pre-commit` hook runs the CI tier:

```bash
node scripts/skill-drift-check.mjs --tier ci
```

The hook runs the framework population check first, then the drift check. The
org runtime has its own separately tracked registry and CI gate; framework CI
does not pretend that private runtime subjects are present.

## Receipts and failure meaning

The receipt names the population, independent expected count, registry and
observed sets, tracked/declared-untracked boundary, resolved targets,
repository root, and HEAD. `status=OK` appears only on exact agreement. Exit 1
means a topology or content mismatch. Exit 2 means malformed schema, unsafe
paths, unreadable observation, or another invocation error. Neither code is a
skip, and `paths` emits no target JSON on failure.

## Periodic Deployed-Parity Runner

The deployed-copy check is a standalone local runner for the canonical framework
root:

```bash
bash scripts/skill-drift-local-runner.sh
```

The runner fails loud unless the framework root is at latest `origin/main`, then
runs:

```bash
node scripts/skill-drift-check.mjs --tier local
```

Wire this script into a heartbeat or daemon cron only after activation is gated.
For a runtime sweep, use the org registry and its canonical org root; do not
reuse the tracked-template gate as proof of runtime completeness.

Runner exit codes are stable for automation:

| Code | Meaning |
|---|---|
| 0 | Clean: every declared local mirror matches canonical. |
| 1 | Real drift found by `skill-drift-check.mjs`. |
| 2 | Operational/checker error: not in a git repo, checker files missing, bad manifest, or checker failure. |
| 3 | Stale root: after fetching `origin/main`, `HEAD` is not `origin/main`. |

If a deployed skill is intentionally agent-customized, do not force it into a
shared mirror group. Either remove it from the manifest or split the group so
only truly shared copies are compared. For example,
`framework-upstream-auto-update` is template-variant parity only because deployed
copies are personalized from `[AGENT_NAME]` / `[ORCHESTRATOR]` placeholders.

## Fix Mode

Fix mode is dry-run by default:

```bash
node scripts/skill-drift-check.mjs --tier local --fix
```

It prints the files that would be copied from canonical and writes nothing. To
apply declared mirror updates:

```bash
node scripts/skill-drift-check.mjs --tier local --fix --write
```

`--write` is scoped strictly to declared mirror members. Extra files in a mirror
are treated as a conflict (`declared-shared but locally modified`) and are not
removed automatically.
