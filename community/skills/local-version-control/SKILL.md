---
name: local-version-control
description: "Daily local snapshots of the invoking agent's allowlisted state. Requires a clean index, verifies the actual staged set, reviews the diff, commits locally, and never pushes."
triggers: ["auto-commit", "git snapshot", "commit changes", "version control"]
external_calls: []
---

# Local Version Control

The 2026-07-31 incident staged 147 files and about 194,743 insertions, including databases, WAL files, bytecode, generated `dist` backups, and broad agent content. The workflow was disarmed while the candidate filter was replaced. The replacement was merged, built, independently activated, and explicitly re-enabled on 2026-07-31. This history remains part of the operating contract.

## Closed Scope

Only these paths for the invoking agent are eligible:

- `orgs/$CTX_ORG/agents/$CTX_AGENT_NAME/MEMORY.md`
- `orgs/$CTX_ORG/agents/$CTX_AGENT_NAME/GOALS.md`
- `orgs/$CTX_ORG/agents/$CTX_AGENT_NAME/config.json`

Daily `memory/` journals remain excluded from Git pending David's privacy ruling in `task_1785556710544_11012959`; they are not part of the active allowlist.

Everything else is reported as blocked. Gitignore still governs whether an allowlisted path is visible to Git.

## Single-Writer Boundary

The CLI acquires a state-side, persistent single-writer lease before it inspects the shared index. The lease remains held after staging so it covers review and commit even though the staging process has exited. Contention refuses immediately and names the holder and expiry. The default lease is 10 minutes; `ecosystem.local_version_control.lease_ttl_ms` may override it only from 5 through 60 minutes. Out-of-bounds values refuse instead of clamping. This closes the gate tracked by `task_1785555336924_76305344`.

The lease serializes auto-commit writers only. Do not start during a protected build or deploy window, or while a person or another process is staging or committing in the canonical checkout. Check `cortextos bus auto-commit-lease-status` during preflight. Never infer that an expired lease is gone: acquisition performs the atomic takeover and records the prior owner.

## Workflow

1. Confirm no protected build/deploy window or concurrent canonical-tree Git mutation is active. Read the lease status, then change to the canonical root and require an empty index. Never mix this workflow with work already staged by a person or another process.

   ```bash
   cortextos bus auto-commit-lease-status
   cd "${CTX_FRAMEWORK_ROOT:?CTX_FRAMEWORK_ROOT must be set}"
   test -z "$(git diff --cached --name-only)" || { echo "Refusing: git index is not empty"; return 1 2>/dev/null || exit 1; }
   ```

2. Run the live filter and preserve its output and exit status.

   ```bash
   RESULT=$(cortextos bus auto-commit)
   STATUS=$?
   printf '%s\n' "$RESULT"
   ```

   `clean` or `nothing_to_stage` means there is no snapshot to create; the CLI releases its lease before returning. A nonzero status is a refusal or error. If its report says `lease.status: held`, abort as one unit: save the exact token, unstage the workflow's index, then release with that token. Never release first.

   ```bash
   LEASE_TOKEN=$(printf '%s' "$RESULT" | jq -r 'select(.lease.status == "held") | .lease.token // empty')
   if [ "$STATUS" -ne 0 ] && [ -n "$LEASE_TOKEN" ]; then
     git reset
     cortextos bus auto-commit-release "$LEASE_TOKEN"
   fi
   test "$STATUS" -eq 0 || { return "$STATUS" 2>/dev/null || exit "$STATUS"; }
   ```

3. For `status: staged`, require the held lease token and compare the report's `staged` array with the real index:

   ```bash
   LEASE_TOKEN=$(printf '%s' "$RESULT" | jq -er '.lease | select(.status == "held") | .token')
   git diff --cached --name-only
   ```

   They must be identical, and every path must be inside the closed scope above. Any mismatch or review rejection takes the mandatory abort unit: `git reset`, then exact-token `auto-commit-release`. Never leave a rejected index staged and never release while it remains staged.

4. Review the full staged diff. Reject secrets, credentials, personal data that should not be versioned, unexpected volume, or content outside the intended daily record.

   ```bash
   git diff --cached --check
   git diff --cached
   ```

5. Assert the exact token still owns the lease with at least 60 seconds remaining, then commit and release as one unit. If the assertion refuses, reset and report without committing. A failed commit takes the abort unit instead. Never omit release after a commit attempt.

   ```bash
   ASSERT_RESULT=$(cortextos bus auto-commit-assert-held "$LEASE_TOKEN")
   ASSERT_STATUS=$?
   printf '%s\n' "$ASSERT_RESULT"
   if [ "$ASSERT_STATUS" -ne 0 ]; then
     git reset
     return "$ASSERT_STATUS" 2>/dev/null || exit "$ASSERT_STATUS"
   elif git commit -m "daily: <summary of agent-state changes>"; then
     cortextos bus auto-commit-release "$LEASE_TOKEN"
   else
     git reset
     cortextos bus auto-commit-release "$LEASE_TOKEN"
     return 1 2>/dev/null || exit 1
   fi
   ```

   The fixed 60-second floor is not configurable. A commit that somehow runs longer than that margin could still outlive the lease; this workflow does not claim atomic commit coverage.

6. Confirm the index is empty and the commit contains exactly the reviewed paths. Never push automatically.

   ```bash
   git diff --cached --name-only
   git show --stat --oneline HEAD
   ```

Manual, user-directed version-control work outside this closed scope uses its own explicit staging and review process.
