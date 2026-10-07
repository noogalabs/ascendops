# Member updates

Run `ascendops update` to review and apply upstream changes. `--check` reports
changes without applying them; `--yes` supplies confirmation for a scripted run.
The checkout must be on `main`, tracking `upstream/main` for a plain clone or
`origin/main` for a fork. Finish a merge or rebase and save other local changes
before updating. Only an exact generated PM2 configuration is saved and restored
automatically; edited configurations are refused.

The updater merges source, installs the lockfile and compiles in a separate
staging checkout. The installed runtime and dependencies stay in place during
installation and compilation. After success, the new pair replaces them and the
previous pair remains in the ignored update recovery directory. A failed
publication restores the previous pair. Restart agents only after a successful
update; a source rollback alone does not finish a failed update.

Recovery prints `ascendops update --rebuild`, which also rebuilds an already
current source checkout. Ordinary up-to-date checks remain a no-op. A saved
rebuild checkpoint authorizes an automatic retry only for its recorded HEAD.

For a scheduled member apply, use `ascendops bus check-upstream --apply` with
`CORTEXTOS_CONFIRM_UPSTREAM_MERGE=yes`. It uses the same install, staging,
publication and recovery routine. `--owner-only` still checks ownership before
applying. The operator `cortextos` lane keeps its existing merge-only behavior.

The installer and a successful member update record a local Git setting,
`ascendops.memberCheckout=true`. This permits later manual `npm run build`
commands in an upstream-only member checkout to validate against `upstream/main`.
Forks continue to validate against `origin/main`; an unmarked operator checkout
does not receive that fallback. Source divergence still blocks a live build.
