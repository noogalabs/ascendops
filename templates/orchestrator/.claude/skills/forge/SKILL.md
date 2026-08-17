---
name: forge
description: "You MUST use this skill to hunt slippage and turn it into skills — either DETECT (scan a day/agent/domain for a known rule that got missed or the same reasoning done by hand 3+ times, and produce a candidate list) or BUILD (forge a new skill or sharpen an existing one from the candidates, to the locked template, through the load gate). Pass the scope after the command. Detection is cheap and runs nightly; building is real work and runs weekly or on an explicit ask."
triggers: ["forge", "forge a skill", "hunt slippage", "what rule got missed", "we keep doing this by hand", "sharpen this skill", "this skill under-fired", "detect skill drift", "skill candidate", "did the skill fire", "build the skill from this", "this should be a skill"]
context: fork
model: opus
---

**Why this is a forked Opus skill:** the slippage-hunt is heavy reasoning — reading a day of transcripts/events, recognizing that a rule was missed or that the same judgment was reconstructed by hand several times, and deciding whether that becomes a new skill or a sharpening of an existing one. That is exactly the work Opus is for. It is `context: fork` so the heavy pass runs in its own window and the caller's session (an evening/weekly review, or an orchestrator turn) stays lean. The detect pass is cheap-by-cadence (nightly, skip-on-empty); the build pass is deliberate (weekly), so Opus is spent only where the reasoning earns it.

## Purpose

Turn how-we-actually-slipped into rule-baked skills, on a cadence, so slippage stops compounding. The forge is an Opus engine that runs ONE deliberate loop — detect → spec → build → test-it-fires → next-pass-audits-whether-it-fired — over two methods: the **create-new** approach (draft a new skill, the `auto-skill` method) and the **edit-existing** approach (audit a skill against a transcript and produce a sharpening diff, the `skill-optimizer` method). The forge DOES this work itself; it invokes the `auto-skill` / `skill-optimizer` skills opportunistically when they are loadable in the running agent, but does NOT hard-depend on them, so the engine is self-contained and portable to any orchestrator agent. It runs on everything, not just maintenance.

## Steps

1. **Parse the scope** from `$ARGUMENTS`: `<domain> [date|agent]` and the mode. Examples: `/forge maintenance 2026-06-05` (detect a domain on a day), `/forge blue` (detect an agent), `/forge --build` (run the weekly build over the accumulated candidate list). Default mode = **detect** unless `--build` is passed.

2. **DETECT mode (daily-light — never builds here):**
   - **Cost-guard first:** if the scope has no meaningful activity and no `forge_candidate` events, STOP — do not spend the Opus pass on an empty day. Return "no candidates."
   - Scan the scope's transcripts + event logs (sweep `forge_candidate` events FIRST — those are real misses that already reached David) for two signals: **(a)** a known rule that got missed, **(b)** the same reasoning done by hand 3+ times with no skill covering it.
   - For each signal, emit a **candidate**: the slippage + the tied real incident (meld/PR/date — REQUIRED) + a proposed hard rule + a **create-vs-edit verdict** (no skill covers it → create-new; a skill under-fired or a covered area newly slipped → edit-existing).
   - **PERSIST every HIGH candidate durably before returning** — detect runs unattended (nightly, via the evening-review hook), so its output MUST survive the session or the weekly build loses it. Write each candidate to the durable forge candidate queue: emit a `forge_candidate` event per candidate (preferred — same store the cost-guard and instant-on-miss already use) AND/OR append it to the run log `docs/ephemeral/forge-runs/candidates.md`. The session-visible list is a convenience copy; the persisted records are the source of truth the weekly build reads.
   - Output = the HIGH-confidence candidate list (to the caller) PLUS the durable persistence above. **Build nothing.**

3. **BUILD mode (weekly-heavy or explicit `--build`):**
   - **Read the accumulated candidate list from the durable forge candidate queue** — the `forge_candidate` events (and/or `docs/ephemeral/forge-runs/candidates.md`) persisted by the detect passes since the last build. Do NOT rely on an in-session list; the candidates were found on prior unattended runs. For each candidate, run the matching method (the forge performs the method itself; if the named helper skill is loadable in the running agent, delegate to it — but never block on it being present):
     - **Create-new** (the `auto-skill` method): draft a new skill to the locked template (frontmatter + steps + hard rules), bake the tied-incident rule, set the model tier + `context: fork`, and route the tracked home (role-specific → role template; shareable → `community/skills/` via skill-autopr).
     - **Edit-existing** (the `skill-optimizer` method): audit the relevant transcript against the target SKILL.md, produce a sharpening diff (tighten triggers / add a hard rule / fix structure), and own the gate + apply + re-activate.
   - Assemble the change-set as SPECS, not merges. Role-split: detection + the hard-rule spec are the orchestrator's judgment lane; the build/PR/wire is dev-side (an agent/an agent).

4. **Gate every output through the combined load gate** (see hard rule 4) and the two-step registration (tracked-source PR → runtime activation), then **return**: in detect, the candidate list; in build, the gated change-set + which skills are ready to ship/sharpen.

5. **Close the loop:** the next forge pass audits whether each shipped skill actually FIRED on its triggers. A skill that shipped but never fired is itself a candidate (its description/triggers under-fired).

## Hard rules — these fire EVERY time (the slippage these prevent is real)

1. **Every candidate ties to a REAL incident.** Cite the meld/PR/date that proves the slippage. No speculative skills "we might need" — the forge builds from where we actually slipped, not from imagination. (Speculative-concerns-are-not-current-blockers, applied to skill creation.)

2. **No skill ships without all three features.** Model tier + `context: fork` (the fork works both directions — heavy reasoning forks UP to Opus, rote forks DOWN to Haiku), `$ARGUMENTS`, and an imperative `description` + a separate `triggers` array. A skill missing any of the three is not done.

3. **Detect never builds at night; build never rushes.** The daily-light pass DETECTS only (cheap, keeps slippage from compounding). Building a skill well is real work — it happens on the weekly pass or an explicit `--build`, never as a nightly rush. This also respects nighttime mode: no live changes overnight.

4. **The frontmatter LOAD GATE is mandatory and uses a REAL YAML parser — never regex.** The harness skill loader parses frontmatter as YAML; an unquoted colon-space in the description (e.g. `intake: read`) is rejected (`mapping values are not allowed`) → the skill silently fails to load and is undiscoverable. Regex-based `list-skills` and regex frontmatter smoke MASK this (PR #99, 2026-06-06). So the gate is ONE combined check, all three required: **does it parse (real YAML) → is it discoverable → does it fire on its trigger** in the target agent's context. **Quote every free-text frontmatter value** (description especially) so punctuation cannot reintroduce the break; the text stays verbatim, only wrapped in quotes.

5. **Every referenced skill must resolve FROM THE TARGET HOME/RUNTIME — not just exist somewhere.** If a forged skill hands off to or names another skill, verify that name resolves where the skill will actually run: `git ls-files` for the tracked home (NOT an unscoped `find`, which sweeps gitignored runtime dirs and gives a false green), plus the running agent's runtime if it activates there. A handoff to a name that is unresolvable from the target = a dead activation (PR #99 `vendor-assign` dangle: a planned-but-unbuilt name). PR #104's `skill-optimizer` / `auto-skill` dangle is CLOSED: forge names those as methods and invokes a helper only when it is loadable in the running agent. Keep that closure intact; never restore a hard dependency or use an unscoped find as proof.

6. **Two-step registration, always — measure registry-enumerated per-skill fanout before activation.** Live agent skill dirs (Claude or Codex-plugin layout) are gitignored runtime — NOT a PR target. Register in two steps: tracked source (role template or `community/skills/`) via PR → Codex + review → an agent gate; THEN runtime activation (identical file into the live gitignored dir) → in-context trigger-fire smoke → agent heads-up. Before ANY agent-tree activation, `forge-register` requires the tracked population registry, canonical org root, and population name. It reconciles every declared member with `materialization=all`, resolves each member's layout-defined skill home, then reverse-enumerates every same-named runtime skill that reaches the requested real destination. It reports the trees the write reaches and registered forks it misses. Per-skill aliases may reach multiple members and require exact `--fanout-acknowledged`; missing, stale, extra, or duplicate subjects refuse. A skill-home symlink may resolve only within its owning subject and still requires acknowledgement; cross-subject or duplicate-real skill homes are invalid H9 topology and cannot be authorized by an acknowledgement. Never infer membership from enabled state, guess a layout, or hardcode a propagation set.

7. **The forge produces SPECS + change-sets, not auto-merges.** No skill the forge builds is merged or activated without the human/orchestrator gate. The forge surfaces; an agent gates; dev-side ships.

## Plumbing — the mechanical layer behind the steps

These scripts live in the framework repo (`$CTX_FRAMEWORK_ROOT/scripts/`). They are the durable plumbing; the judgment stays in this skill.

**Persist a HIGH candidate (detect, step 2)** — one command dual-persists (run-log append FIRST, then the `forge_candidate` bus event). Refuses candidates with no tied real incident (hard rule 1):

```bash
node "$CTX_FRAMEWORK_ROOT/scripts/forge-candidates.mjs" emit \
  --skill "<target-or-proposed-name>" --verdict <create-new|edit-existing> \
  --slippage "<what actually slipped>" --incident "<meld/PR/date>" \
  --rule "<proposed hard rule>" --confidence high
```

**Read the accumulated queue (build, step 3)** — merges `forge_candidate` events since the last build marker with pending `docs/ephemeral/forge-runs/candidates.md` entries, dedupes by event id, groups by create-vs-edit verdict:

```bash
node "$CTX_FRAMEWORK_ROOT/scripts/forge-candidates.mjs" queue
```

**Gate every built/sharpened skill (step 4)** — the combined load gate: real-YAML parse (never regex; fails loud if no real parser) + discoverable + ship features (model tier, `context: fork`, `$ARGUMENTS`, imperative description, triggers) + referenced skills resolve from the target home via `git ls-files`. Pass `--target-home` as the skill's OWN tracked source home (its role-template `.claude/skills` dir, or `community/skills` for a shareable skill) — NOT the repo root: the reference check resolves names relative to that home, so the repo root would mis-scope the resolution. The trigger-fire smoke remains MANUAL in the target agent's context — the gate prints the exact smoke to run:

```bash
node "$CTX_FRAMEWORK_ROOT/scripts/forge-load-gate.mjs" <skill-dir> --target-home "<the skill's tracked source home, e.g. templates/<role>/.claude/skills or community/skills>"
```

**Two-step registration (step 4, hard rule 6)** — `stage` copies into the tracked home and gates it (PR follows; never commits/merges itself); stage does not inspect or touch runtime trees. `activate` runs only after the merge + orchestrator gate and missing `--gate-approved-by` refuses. Its source must be a lexical non-symlink directory inside its Git worktree, clean against HEAD/index, with every descendant a regular tracked file at exactly stage 0. Assume-unchanged, skip-worktree, index/HEAD drift, or worktree mode/content that differs from the reviewed blob refuses. The source root identity and complete tree hash must remain unchanged across the temp copy, and the temp hash must match, before any runtime swap. Agent-tree activation also requires the population registry itself to be a clean, normal-visibility stage-0 file whose mode/blob exactly matches HEAD; its identity and content must remain stable across reconciliation and fanout measurement before any temp creation. The command then prints the measured impact report. A normal independent runtime needs no fanout acknowledgement. Multi-member or symlink fanout prints the exact current acknowledgement value; inspect the reached and missed trees, then repeat the command with that value only if the fanout is intended:

```bash
node "$CTX_FRAMEWORK_ROOT/scripts/forge-register.mjs" stage --from <built-skill-dir> --home "$CTX_FRAMEWORK_ROOT/community/skills"
node "$CTX_FRAMEWORK_ROOT/scripts/forge-register.mjs" activate --from <tracked-skill-dir> --runtime <layout-resolved-agent-skill-home> --gate-approved-by <name> --registry <fleet-population.json> --root <canonical-org-root> --population <population-name>
# Only after a fanout refusal and human review of its freshly measured set:
node "$CTX_FRAMEWORK_ROOT/scripts/forge-register.mjs" activate --from <tracked-skill-dir> --runtime <layout-resolved-agent-skill-home> --gate-approved-by <name> --registry <fleet-population.json> --root <canonical-org-root> --population <population-name> --fanout-acknowledged "<org/agent,org/agent>"
```

**Close out a build pass (step 5 hand-off)** — archive the consumed queue into `runs/<build-id>.md` and advance the marker so the next detect window starts clean:

```bash
node "$CTX_FRAMEWORK_ROOT/scripts/forge-candidates.mjs" consume --build-id "build-$(date -u +%Y-%m-%d)"
```

**Known limitation (must close before build-mode goes live):** the build read bounds the *event* store by a single authoritative cutoff, but run-log (`candidates.md`) entries are date-only and are NOT cutoff-bounded — a concurrent `emit` in the ~1 ms window between the cutoff capture and the run-log read can cross the build boundary (consumed this cycle instead of next; near-zero in the single-threaded weekly flow, accepted while forge is dormant). The unified-store fix (precise emit ts on run-log entries + the same cutoff bound, or a queue/consume atomicity lock) is **`task_1781104449215_29277678`** — a HARD BLOCKER before forge build-mode/consume is activated live. See `scripts/forge-candidates.mjs` (candidates.md read).

## Invocation example

```
/forge maintenance 2026-06-05
/forge blue
/forge --build
```

The text after the command replaces `$ARGUMENTS`. The caller's session stays on its lean model; this engine runs on Opus in its own fork. In **detect** it returns a HIGH-confidence candidate list (slippage + tied incident + proposed rule + create-vs-edit verdict), or "no candidates" when the cost-guard trips on an empty scope. In **build** it returns a gated change-set of new/sharpened skill specs for dev-side to ship through the two-step registration.
