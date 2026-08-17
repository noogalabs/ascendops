/**
 * ══════════════════════════════════════════════════════════════════════════
 *  PROOF CONTRACT — THE ONLY PLACE IN THIS FILE THAT STATES WHAT IS PROVEN.
 * ══════════════════════════════════════════════════════════════════════════
 *
 *  PROVEN:
 *    P1. `cortextos restart` WRITES `.user-stop` for the named agent, and the
 *        file's contents CONTAIN the reason substring "cortextos restart".
 *        A single control agent ("bob") has no marker afterwards.
 *
 *        Deliberately NOT "the reason text intact" (the assertion is a substring
 *        check, not an equality) and NOT "writes it for no other agent" (one
 *        control agent is not a universal). Both were in the first draft of this
 *        contract — concentrating the claims made them checkable, and the first
 *        self-audit against the actual expect() calls caught them.
 *    P2. The marker is PRESENT AT EVERY SAMPLED OBSERVATION from command return
 *        through OBSERVATION_MS (125s), at a cadence whose worst observed gap is
 *        asserted AT OR BELOW MAX_ALLOWED_GAP_MS — the assertion is
 *        toBeLessThanOrEqual, so "below" was one operator too strong.
 *        Sampled presence, measured cadence.
 *    P3. Nothing is left pending ON THE FAKE CLOCK that test binds, and the
 *        marker survives 130s of that clock.
 *
 *  NOT PROVEN — each an ACCEPTED residual with its owner, not a harmless case:
 *    N1. Sub-cadence intervals. A delete with an identical restore inside one
 *        cadence gap is invisible. Hook reads happen at times nothing here
 *        controls, so such a gap CAN coincide with one — an ACCEPTED residual,
 *        not a harmless case.
 *        ITS DURATION IS BOUNDED (reviewer, 6b2d021c). Two separate facts, stated
 *        separately: per-run, every inter-sample gap was measured and the worst
 *        asserted <= MAX_ALLOWED_GAP_MS, so an undetected delete+restore fits
 *        inside that measured ceiling; standing, the bound IS that cadence
 *        assertion. "Unbounded in principle" was wrong.
 *        Owner: accepted, as heartbeat.ts:37-42 accepts its own.
 *    N2. Deferred work on NON-GLOBAL schedulers. sinon replaces globals, not
 *        `node:timers` exports, so P3's counter reads zero while such a
 *        scheduler holds real work. Owner: the wall-clock case, which observes
 *        outcomes rather than schedulers.
 *    N3. Survival to SessionEnd firing #1, which is UNBOUNDED BY DESIGN
 *        (agent-process.ts:894-901). No finite window can establish it. The
 *        documented ~13-22s is the SEPARATION BETWEEN the two firings, never a
 *        delay from stop. Owner: MARKER_TTL_MS + the grace machinery.
 *    N4. Owner exclusivity / "never deletes". Rests on source inspection — the
 *        P1 fix removed the only deleter in RESTART'S path — not on this file.
 *        Two legitimate deleters remain elsewhere: clearEndMarkers() (primary)
 *        and classifyFromMarkers()'s MARKER_TTL_MS lazy-unlink (failed-start
 *        backstop). "Only deleter" is true of this path, not of the system.
 *    N5. Unexecuted branches. Both instruments are behavioural, exercised for a
 *        single agent. Owner: the AST-allowlist follow-up, built to its own bar.
 *
 *  EVERY OTHER COMMENT, TITLE AND MESSAGE IN THIS FILE IS DESCRIPTIVE ONLY.
 *  Titles say what a test DOES. Failure messages say what was OBSERVED. None of
 *  them restate what is PROVEN — restating it is how six overclaims survived
 *  fourteen review rounds, each restatement an independent chance to overreach.
 *  If you need to state the guarantee, EDIT THIS BLOCK; do not re-say it below.
 *
 * WHY THIS FILE EXISTS (reviewer RED + Codex P2 on b9273b5f, 2026-08-14):
 *   The previous assertion pinned the absence of an eager clear by checking that
 *   `clearStopMarker` was not among a mocked module's property names. A guarded
 *   mutation that inlined `existsSync`/`unlinkSync` — no helper involved — left the
 *   suite GREEN 7/7 while the marker was in fact deleted. It observed the shape of
 *   a mock, not the lifetime of a file.
 *
 * THREE SANDBOX PROPERTIES, each learned from a mutation that defeated the
 * previous version of this test:
 *
 *   1. NOT `vi.mock('os')`. A module mock intercepts only the import style the file
 *      under test happens to use; a deletion written with `require('os')` resolved
 *      to the REAL homedir and left an os-mocked test green. `$HOME` makes
 *      `os.homedir()` itself return the sandbox, so every import style lands there.
 *
 *   2. `$HOME` IS SET BEFORE THE COMMAND IS IMPORTED (Codex P2). If a cleanup path
 *      caches `homedir()` during module evaluation, an import that runs before the
 *      sandbox exists captures the real home — the writer would then write into the
 *      sandbox while the cached cleanup deleted elsewhere, and every assertion here
 *      would pass. Module-scope and call-time resolution must agree.
 *
 *   3. PRESENCE IS SAMPLED WELL BEYOND COMMAND RETURN (Codex P2). Checking only at
 *      command return lets a DEFERRED cleanup pass — a timer unlinking a second
 *      later satisfies existence, contents and the control, then destroys the
 *      marker before a POSSIBLE later hook observation — N3 allows firing #1 to
 *      be delayed without a finite bound, so an ordering that assumes the read
 *      happens is one step too strong. Timing is N3's to state; no numbers here.
 *
 * COVERAGE, AND SIX ABANDONED ATTEMPTS. Every guard that asked HOW a deferral was
 * scheduled was beaten by naming a mechanism it did not own:
 *
 *   fake clock installed in-test     → module-scope scheduler capture
 *   fake clock bound before import   → `node:timers` (sinon replaces globals, not
 *                                      module exports)
 *   vi.getTimerCount() === 0         → any non-global scheduler
 *   bounded 1.5s real observation    → unref'd unlink at 2s
 *   regex source scan                → `//` inside a string erased the rest of the
 *                                      line, hiding a real setTimeout
 *   tokenised (AST) source scan      → `AbortSignal.timeout(18_000)` — a standard
 *                                      scheduling API containing none of the
 *                                      banned names
 *
 * The last two are the instructive ones: making the scan *lexically* sound fixed
 * nothing, because the flaw was never lexical. Any name-based check is a DENYLIST,
 * and a denylist of scheduler surfaces cannot be completed — the platform keeps
 * adding members. Three losses to one category is the signal to stop enumerating
 * it, so the source scan and its "no scheduler at all, including unexecuted
 * branches" claim were REMOVED rather than hardened a third time.
 *
 * WHAT SHIPS: two instruments — a fake-clock case and a real wall-clock sampling
 * case. What each establishes, and what it does not, is stated ONCE in the PROOF
 * CONTRACT above. Deliberately not restated here: the previous version of this
 * section re-stated the guarantees and drifted from them three separate times.
 *
 * WHAT IT PROTECTS: `restart-agent` dispatches without awaiting and returns
 * immediately, while `performStop` runs a runtime-dependent graceful branch then
 * races a 15s exit timeout — a timeout that bounds how long stop() WAITS, not when
 * the PTY dies. One restart fires SessionEnd TWICE (separation per N3) and `hook-crash-alert`
 * classifies WITHOUT consuming the marker so both firings classify correctly.
 * Clearing it reintroduces the `type=crash reason=none` false-positive pairs.
 * Which mechanisms may legitimately delete the marker, and on what terms, is
 * N4's to state. Not restated here — the previous version of this line fixed a
 * wrong ownership claim by ADDING a restatement, which is the same structural
 * violation in a friendlier form.
 */
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// Only the IPC boundary is mocked. Everything else — marker writer, fs, path
// resolution — is real, because the defect being pinned is a real file
// disappearing from a real directory.
vi.mock('../../../src/daemon/ipc-server.js', () => ({
  IPCClient: class {
    async isDaemonRunning() { return true; }
    async send(request: Record<string, unknown>) { return { success: true, data: `ok:${request.type}` }; }
  },
}));

// ORDER IS LOAD-BEARING: the sandbox is established at module scope, BEFORE the
// command is imported below, so a homedir cached during module evaluation resolves
// to the same place a call-time lookup does. One stable root for the file (rather
// than a fresh one per test) is what makes that possible.
const SANDBOX = mkdtempSync(join(tmpdir(), 'restart-marker-'));
const REAL_HOME = process.env.HOME;
process.env.HOME = SANDBOX;

const { restartCommand } = await import('../../../src/cli/restart.js');

afterAll(() => {
  if (REAL_HOME === undefined) delete process.env.HOME; else process.env.HOME = REAL_HOME;
  rmSync(SANDBOX, { recursive: true, force: true });
});

const markerPath = (agent: string) =>
  join(SANDBOX, '.cortextos', 'default', 'state', agent, '.user-stop');

// SLOW LANE (coordinator's ruling, 2026-08-14). The grace-window case costs ~125s, which
// is right for a PR gate and wrong for a rapid local edit-test cycle. So it runs
// in CI (which sets CI=true) and on explicit opt-in, and is skipped otherwise.
//
// THE OBVIOUS HAZARD, and why this is not the unfalsifiable-gate mistake from
// earlier today: a default-skip can silently make a gate vacuous. Two things stop
// that. The condition keys on CI, which GitHub Actions sets for every run, so the
// PR gate always executes it; and vitest reports skipped tests by name, so a local
// run states out loud that it did not carry this proof rather than implying green.
// Verified by test count, not by trusting the flag: CI=true gives 5 passed in
// 125.13s; without CI it gives 4 passed / 1 skipped in 567ms.
const SLOW_LANE = Boolean(process.env.CI) || process.env.SLOW === '1';

describe('cortextos restart: .user-stop must survive the command (black box)', () => {
  beforeEach(() => {
    // Clear state between tests without disturbing the sandbox root, which must
    // stay stable because the command module already resolved against it.
    rmSync(join(SANDBOX, '.cortextos'), { recursive: true, force: true });
    vi.useRealTimers();
  });

  it('checks the marker file exists after the restart IPC is accepted', async () => {
    await restartCommand.parseAsync(['alice'], { from: 'user' });
    // The load-bearing assertion: the file itself, not a mock's shape.
    expect(existsSync(markerPath('alice'))).toBe(true);
  });

  it('reads the marker contents back after the restart IPC is accepted', async () => {
    await restartCommand.parseAsync(['alice'], { from: 'user' });
    // A truncate-instead-of-unlink would satisfy an existence-only check while
    // still destroying the reason the crash-alert hook classifies on.
    expect(readFileSync(markerPath('alice'), 'utf-8')).toContain('cortextos restart');
  });

  it('control: checks no marker exists for an agent that was never restarted', async () => {
    await restartCommand.parseAsync(['alice'], { from: 'user' });
    // Without this, a path-resolution bug pointing every agent at one file — or a
    // writer that marks everything — would satisfy the two assertions above.
    expect(existsSync(markerPath('bob'))).toBe(false);
  });

  it('binds a fake clock before import, then advances it 130s and checks the marker', async () => {
    // Mechanics only. What the firing timing licenses is stated once in PROOF
    // CONTRACT N3; no numbers restated here. A cleanup deferred by a timer passes
    // every assertion above and still removes the marker afterwards.
    //
    // ORDER IS LOAD-BEARING AGAIN, for the same reason as the $HOME sandbox and on
    // a different axis (reviewer casualty, 3314fb75). Installing the fake clock
    // inside the test is too late: a module that captured a scheduler at import
    // time — `import { setTimeout } from 'node:timers'` — holds a reference the
    // fake never replaces, so an unref'd 1s unlink through that reference deletes
    // the marker for real while this suite reports green. Demonstrated with a real-time
    // control: marker present at return, gone at 1.1s, suite GREEN 5/5.
    //
    // So: fake the clock, THEN reset and re-import. That binds a module-scope
    // capture of a GLOBAL scheduler — the surface this instrument covers.
    // `node:timers` and other non-global captures are NOT bound: see N2.
    vi.useFakeTimers();
    try {
      vi.resetModules();
      const fresh = await import('../../../src/cli/restart.js');
      await fresh.restartCommand.parseAsync(['alice'], { from: 'user' });

      expect(existsSync(markerPath('alice'))).toBe(true);
      // Counts timers pending on the clock this test bound. Scope: P3. Blind
      // spot: N2 — a non-global scheduler leaves this at zero while holding work.
      expect(vi.getTimerCount()).toBe(0);

      // Advance this clock by 130s. Mechanics only; see N3.
      await vi.advanceTimersByTimeAsync(130_000);

      expect(existsSync(markerPath('alice'))).toBe(true);
      expect(readFileSync(markerPath('alice'), 'utf-8')).toContain('cortextos restart');
    } finally {
      vi.useRealTimers();
      vi.resetModules();
    }
  });

  it.skipIf(!SLOW_LANE)(
    'samples the marker every ~100ms for 125s and records any absence [SLOW: CI or SLOW=1]',
    async () => {
      // THIS TEST IS DELIBERATELY SLOW. It costs ~125s of wall clock per run, and
      // that price is what buys PROOF CONTRACT P2. Every cheaper formulation was
      // tried and each was defeated by a real mutation:
      //   - fake clock installed in-test      -> beaten by module-scope capture
      //   - fake clock bound before import    -> beaten by `node:timers` (sinon
      //                                          replaces globals, not module
      //                                          exports)
      //   - vi.getTimerCount() === 0          -> blind to non-global schedulers
      //   - bounded 1.5s real observation     -> beaten by an unref'd unlink at 2s
      //
      // The pattern is that every mechanism-based guard is a denylist of scheduler
      // surfaces, and each one was beaten by naming a surface it did not own. So
      // this gives up mechanism entirely: no clock control, no interception, no
      // source inspection. It watches the real file across the real window, and is
      // MECHANISM-INDEPENDENT AT THE OBSERVED SAMPLES — it never asks which
      // scheduler was used. That is NOT immunity to schedulers: any source can
      // delete and restore inside one sampling gap. Scope P2, blind spot N1.
      //
      // THERE IS NO WORST-CASE FIRING DEADLINE. This is the third and final
      // correction to this bound, and it invalidates the framing rather than the
      // number (Codex, 0eca2821).
      //
      // agent-process.ts:399-406 — "The functional correctness no longer depends
      // on this timeout (stopRequested handles late exits), but a generous timeout
      // reduces log noise." The 15s is LOG-NOISE REDUCTION, not a deadline. It is
      // the point where performStop() stops AWAITING, not where the PTY dies.
      //
      // agent-process.ts:894-901 — "This guarantees that the FIRST exit after a
      // stop() call is treated as intentional, NO MATTER HOW DELAYED IT IS."
      //
      // So SessionEnd firing #1 is UNBOUNDED BY DESIGN, and every "worst case"
      // computed from stop timings — my 46s, then my 43s — was fiction. A deferred
      // unlink at 50s passed the 48s window while a late hook still needed the
      // marker. No finite observation can prove "survives until firing #2".
      //
      // WHY THIS WINDOW (reviewer, 2c1aa300). MARKER_CLEAR_GRACE_MS is a grace
      // FLOOR, not a handoff instant — the marker is cleared only when a
      // heartbeat actually runs clearEndMarkers() on a marker AT OR OLDER THAN
      // that: heartbeat.ts:56 skips on strictly `<`, so age == grace IS deleted.
      // Ownership itself is N4's to state, not this comment's.
      //
      // Mechanically: an unlink by restart.ts at 126s WOULD PASS this test, and may
      // still precede both the real heartbeat and a possible later hook observation.
      // Whether that makes it the wrong owner is N4's to say, not this comment's.
      //
      // What this establishes and what it does not: see PROOF CONTRACT at the
      // top of this file. Deliberately not restated here.
      //
      // The architectural argument behind N4 is stated in N4, not restated here.
      //
      // WHY 125s, STATED WITHOUT THE OVERREACH IT HAD (reviewer, 92336bb7). I had
      // called it "the last point at which an absent marker is unambiguously this
      // command's fault". That is wrong in system terms: 125s is BEYOND the 120s
      // grace floor, so in production a heartbeat may have run clearEndMarkers() by
      // then. Whether such a removal is legitimate is N4's to state, not this
      // comment's; either way 125s is not a system ownership boundary.
      //
      // What makes it valid HERE is narrower and harness-specific: this test runs
      // no heartbeat, so no cleanup mechanism executes in this process during the
      // window. 125s spans the whole grace floor; entitlement and ownership are N4's
      // to state.
      //
      // ── REFUTED, kept only as history ────────────────────────────────────
      // Three superseded bounds, each believed source-derived at the time:
      //   23s — read "13–22s apart" as elapsed-from-command. It is the SEPARATION
      //         between the two firings. (Codex, e946d20d)
      //   46s — summed performStop's graceful sleeps as 9s unconditional. They are
      //         MUTUALLY EXCLUSIVE runtime branches: hermes 3s, codex-app-server
      //         0s, opencode 1s, Claude 1s+5s=6s max. (self-caught; reviewer
      //         independently)
      //   43s — 6s + 15s race = "21s worst case to firing #1". REFUTED: the race
      //         bounds how long stop() WAITS, not when the PTY dies.
      //         (Codex, 0eca2821)
      // Two were arithmetic errors; the third was a category error — treating a
      // wait-timeout as a deadline. None of these numbers is live. Do not restore
      // one because it looks cheaper.
      // ──────────────────────────────────────────────────────────────────────
      //
      // MARKER_CLEAR_GRACE_MS, heartbeat.ts:44 — the floor BELOW which
      // clearEndMarkers() will not touch a marker. Not a handoff instant: cleanup
      // happens only when a heartbeat runs on a marker AT OR OLDER THAN this
      // (heartbeat.ts:56 skips on strictly `<`, so age == grace IS deleted).
      // Read from source, not remembered.
      const GRACE_WINDOW_MS = 120_000;
      const MARGIN_MS = 5_000;
      const OBSERVATION_MS = GRACE_WINDOW_MS + MARGIN_MS;   // 125s
      //
      // The bounded 1.5s version was REMOVED rather than kept alongside. It is
      // fully subsumed, and a redundant assertion that reads like a guard is the
      // trap already hit once on this PR.

      // SAMPLED OBSERVATION, NOT ENDPOINT SAMPLING (reviewer casualty, 92336bb7) —
      // and NOT continuity, which sampling cannot establish at all (reviewer again,
      // 0507b1ed: a delete at 25ms with an identical restore at 75ms sits entirely
      // inside the first interval and is invisible here). The title, the failure
      // text and this comment all now say the same bounded thing, because the
      // previous version had an honest comment sitting above an overclaiming test
      // NAME — and the name is what a reader believes.
      // Checking only at return and at the end says nothing about the interval
      // between them. Their mutation unlinked the marker at 60s and rewrote an
      // identical file at 124s: absent for 64s inside the observation window, and both
      // endpoint assertions still passed. Two points cannot establish an interval
      // property, and the marker's whole job is to EXIST when a hook reads it —
      // which happens at a time this test does not control.
      const SAMPLE_INTERVAL_MS = 100;
      // Ceiling on the gap between consecutive OBSERVATIONS. Generous versus the
      // 100ms cadence because CI is shared and jittery; the point is that a
      // machine too loaded to hold the cadence FAILS here instead of silently
      // weakening the resolution claim below.
      const MAX_ALLOWED_GAP_MS = 2_000;

      await restartCommand.parseAsync(['alice'], { from: 'user' });

      // The gap denominator includes BOTH ENDS (reviewer, 92336bb7). Presence at
      // return is the LEFT ENDPOINT of the first interval, not observation of it —
      // the return-to-first-sample window is unobserved exactly like every other
      // inter-sample window, and bounded only by the first sample arriving.
      // Excluding the return and terminal timestamps would put the first and last
      // intervals outside the reported maximum, which is the endpoint-sampling
      // defect reintroduced one level down, in the instrumentation instead of the
      // assertions.
      const observedAt: number[] = [];
      const absentAt: number[] = [];

      const observe = (t: number) => {
        observedAt.push(t);
        if (!existsSync(markerPath('alice'))) absentAt.push(t - observedAt[0]);
      };

      observe(Date.now());                       // left endpoint
      const startedAt = observedAt[0];
      while (Date.now() - startedAt < OBSERVATION_MS) {
        await new Promise(resolve => globalThis.setTimeout(resolve, SAMPLE_INTERVAL_MS));
        observe(Date.now());
      }
      observe(Date.now());                       // terminal endpoint

      const maxGapMs = observedAt
        .slice(1)
        .reduce((worst, t, i) => Math.max(worst, t - observedAt[i]), 0);

      // Compact, because the first version printed all 623 absent timestamps and
      // was unreadable in CI. Span + count + cadence is what diagnoses it.
      const span = absentAt.length
        ? `absent from t+${absentAt[0]}ms to t+${absentAt[absentAt.length - 1]}ms `
          + `(${absentAt.length} samples over ${absentAt[absentAt.length - 1] - absentAt[0]}ms)`
        : 'no absence observed';

      expect(
        absentAt.length,
        `.user-stop was absent at ${absentAt.length} sample(s). Observed: ${span}. Samples taken: ${observedAt.length}, worst gap ${maxGapMs}ms. Scope of this observation: PROOF CONTRACT P2 / N1 at the top of this file.`,
      ).toBe(0);

      // Resolution is now EVIDENCE from this run, not an assumption about the
      // scheduler. Without it, a loaded machine could stretch the cadence to
      // seconds while the test passed and still advertised 100ms resolution.
      expect(
        maxGapMs,
        `observed cadence degraded to ${maxGapMs}ms across ${observedAt.length} samples (ceiling ${MAX_ALLOWED_GAP_MS}ms); see PROOF CONTRACT P2`,
      ).toBeLessThanOrEqual(MAX_ALLOWED_GAP_MS);

      expect(readFileSync(markerPath('alice'), 'utf-8')).toContain('cortextos restart');
    },
    150_000,
  );
});
