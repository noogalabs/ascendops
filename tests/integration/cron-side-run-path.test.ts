import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { tmpdir } from 'os';

/**
 * End-to-end for the cron side-run path.
 *
 * The unit suites prove each piece fails closed in isolation. They do NOT prove
 * the pieces are connected, and this project's near-miss was exactly that: a
 * fallback that reported success while injecting nothing, because it consulted
 * mutable scheduler state instead of the immutable admission slot. Every
 * assertion here is about what the MAIN SESSION actually received, never about
 * whether an event fired.
 */

const injected: Array<{ text: string }> = [];

vi.mock('../../src/daemon/agent-process.js', () => ({
  AgentProcess: class {
    name: string;
    dir: string;
    constructor(name: string, dir: string) { this.name = name; this.dir = dir; }
    async start() {}
    async stop() {}
    getStatus() { return { name: this.name, status: 'running' }; }
    onExit() {}
    getAgentDir() { return this.dir; }
    getConfig() { return { runtime: 'claude-code', model: 'claude-opus-5' }; }
    injectMessageDetailed(text: string) {
      injected.push({ text });
      return { ok: true as const, dedupIdentity: undefined };
    }
  },
}));
vi.mock('../../src/daemon/fast-checker.js', () => ({ FastChecker: class { start() {} stop() {} wake() {} } }));
vi.mock('../../src/telegram/api.js', () => ({ TelegramAPI: class { constructor() {} } }));
vi.mock('../../src/telegram/poller.js', () => ({ TelegramPoller: class { start() {} stop() {} } }));
const logEventMock = vi.fn();
vi.mock('../../src/bus/event.js', () => ({ logEvent: logEventMock }));
// A spawn that never answers. Lets the ACCEPT path run for real — resolve, write
// the slot, start the run — without launching a model, so the admission-side
// copy into the slot is exercised rather than reconstructed by the test.
vi.mock('child_process', async (orig) => ({
  ...(await orig<typeof import('child_process')>()),
  spawn: () => ({ stdout: { on: () => {} }, stderr: { on: () => {} }, on: () => {} }),
}));

const { AgentManager } = await import('../../src/daemon/agent-manager.js');
const { AgentProcess } = await import('../../src/daemon/agent-process.js');
const { sideRunDir, writePendingSlot, writeOutcomeSlot, readSlotRaw } = await import('../../src/daemon/cron-side-run-runner.js');
const { resolvePaths } = await import('../../src/utils/paths.js');
const { SIDE_RUN_DEADLINE_MS } = await import('../../src/daemon/cron-side-run.js');

const AGENT = 'coordinator';

function makeManager(root: string) {
  const am = new AgentManager('test-instance', join(root, 'instance'), join(root, 'framework'), 'acme');
  const proc = new (AgentProcess as unknown as new (n: string, d: string) => unknown)(AGENT, join(root, 'agentdir'));
  // Same technique the existing agent-manager unit tests use: drive the private
  // registry directly rather than spawning anything real.
  (am as unknown as { agents: Map<string, unknown> }).agents.set(AGENT, { process: proc });
  return am;
}

/** stateDir the manager will resolve for this agent, so the test writes where it reads. */
function stateDirFor(am: unknown): string {
  const org = (am as { resolveAgentOrg: (a: string) => string }).resolveAgentOrg(AGENT);
  return resolvePaths(AGENT, 'test-instance', org).stateDir;
}

let root: string;
beforeEach(() => {
  injected.length = 0;
  logEventMock.mockClear();
  // stateDirFor() resolves to a REAL path outside the temp root, so slots persist
  // between tests unless cleared. Without this, one test's leftover slot is
  // actioned by the next test's sweep.
  try { rmSync(join(resolvePaths(AGENT, 'test-instance', 'acme').stateDir, 'side-runs'), { recursive: true, force: true }); } catch { /* first run */ }
  root = mkdtempSync(join(tmpdir(), 'side-run-e2e-'));
  mkdirSync(join(root, 'framework'), { recursive: true });
  mkdirSync(join(root, 'agentdir'), { recursive: true });
});
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

describe('side-run path — an INELIGIBLE cron reaches the main session untouched', () => {
  it('injects the original prompt when the prompt hash does not match the pin', () => {
    const am = makeManager(root);
    const prompt = 'MAINTENANCE LINE WATCH. this text does not match the reviewed pin';

    const ok = (am as unknown as {
      injectCronAgent: (a: string, c: unknown, t: string, f: string) => boolean;
    }).injectCronAgent(AGENT, { name: 'voice-watch', prompt }, prompt, '2026-08-07T14:00:00.000Z');

    expect(ok).toBe(true);
    // The whole point: an unreviewed prompt must behave exactly as it does today.
    expect(injected).toHaveLength(1);
    expect(injected[0].text).toBe(prompt);
  });

  it('injects a cron that is not in the registry at all', () => {
    const am = makeManager(root);
    const prompt = 'Inbox sweep (David EA monitoring). CRITICAL: ...';

    (am as unknown as {
      injectCronAgent: (a: string, c: unknown, t: string, f: string) => boolean;
    }).injectCronAgent(AGENT, { name: 'inbox-sweep', prompt }, prompt, '2026-08-07T14:01:00.000Z');

    // inbox-sweep is permanently ineligible; it must never be diverted.
    expect(injected).toHaveLength(1);
    expect(injected[0].text).toBe(prompt);
  });
});

describe('side-run path — the FALLBACK actually injects, it does not just log', () => {
  it('injects the cron prompt into the main session when a slot expires', () => {
    const am = makeManager(root);
    const admissionId = '2026-08-07T14:10:00.000Z';
    const admittedAtMs = Date.parse(admissionId);
    const cronPrompt = 'run the watcher script';

    const stateDir = stateDirFor(am);
    writePendingSlot(stateDir, {
      admissionId, cronName: 'voice-watch', admittedAtMs,
      deadlineMs: SIDE_RUN_DEADLINE_MS, cronPrompt,
    });

    // Before the deadline: nothing happens.
    (am as unknown as { sweepSideRunsForAgent: (a: string, n: number) => void })
      .sweepSideRunsForAgent(AGENT, admittedAtMs + 1_000);
    expect(injected).toHaveLength(0);

    // After the deadline: the main session must RECEIVE the cron prompt.
    (am as unknown as { sweepSideRunsForAgent: (a: string, n: number) => void })
      .sweepSideRunsForAgent(AGENT, admittedAtMs + SIDE_RUN_DEADLINE_MS + 1);

    expect(injected).toHaveLength(1);
    expect(injected[0].text).toBe(cronPrompt);

    // And the fallback event must record the reason AND that it really injected.
    const fallbackEvents = logEventMock.mock.calls.filter((c) => c[4] === 'cron_side_run_fallback');
    expect(fallbackEvents).toHaveLength(1);
    expect(fallbackEvents[0][6]).toMatchObject({ reason: 'deadline_expired', injected: true });

    // Slot cleared, so a later tick cannot re-action the same fire into a loop.
    expect(readSlotRaw(stateDir, admissionId)).toBeNull();
  });

  it('uses the admitted prompt when the current cron definition cannot be found', () => {
    // Deleting the scheduler definition cannot revoke a fire already admitted.
    // The slot is the immutable record of what the main session was owed.
    const am = makeManager(root);
    const admissionId = '2026-08-07T14:20:00.000Z';
    const admittedAtMs = Date.parse(admissionId);
    (am as unknown as { cronSchedulers: Map<string, unknown> })
      .cronSchedulers.set(AGENT, { getCronDefinition: () => null, getNextFireTimes: () => [] });

    const stateDir = stateDirFor(am);
    writePendingSlot(stateDir, {
      admissionId, cronName: 'voice-watch', admittedAtMs,
      deadlineMs: SIDE_RUN_DEADLINE_MS, cronPrompt: 'x',
    });

    (am as unknown as { sweepSideRunsForAgent: (a: string, n: number) => void })
      .sweepSideRunsForAgent(AGENT, admittedAtMs + SIDE_RUN_DEADLINE_MS + 1);

    expect(injected).toEqual([{ text: 'x' }]);
    const ev = logEventMock.mock.calls.filter((c) => c[4] === 'cron_side_run_fallback');
    expect(ev[0][6]).toMatchObject({ injected: true });
  });

  it.each([
    ['edited', 'edited after admission'],
    ['deleted', null],
  ])('reinjects the admission-time prompt when the cron is %s before fallback', (_case, currentPrompt) => {
    const am = makeManager(root);
    const admissionId = `2026-08-07T14:25:0${currentPrompt ? '0' : '1'}.000Z`;
    const admittedAtMs = Date.parse(admissionId);
    const admittedPrompt = 'instructions frozen when this fire was admitted';
    (am as unknown as { cronSchedulers: Map<string, unknown> }).cronSchedulers.set(AGENT, {
      getCronDefinition: () => currentPrompt === null
        ? null
        : { name: 'voice-watch', prompt: currentPrompt, schedule: '*/30 * * * *' },
      getNextFireTimes: () => [],
    });

    const stateDir = stateDirFor(am);
    writePendingSlot(stateDir, {
      admissionId, cronName: 'voice-watch', admittedAtMs,
      deadlineMs: SIDE_RUN_DEADLINE_MS, cronPrompt: admittedPrompt,
    });

    (am as unknown as { sweepSideRunsForAgent: (a: string, n: number) => void })
      .sweepSideRunsForAgent(AGENT, admittedAtMs + SIDE_RUN_DEADLINE_MS + 1);

    expect(injected).toEqual([{ text: admittedPrompt }]);
    const ev = logEventMock.mock.calls.filter((c) => c[4] === 'cron_side_run_fallback');
    expect(ev[0][6]).toMatchObject({ injected: true });
  });

  it('clears the observed unreadable slot file once instead of hashing a synthetic identity', () => {
    const am = makeManager(root);
    const stateDir = stateDirFor(am);
    const observedName = 'unreadable-slot.json';
    mkdirSync(sideRunDir(stateDir), { recursive: true });
    writeFileSync(join(sideRunDir(stateDir), observedName), '{not json', 'utf8');

    const sweep = () => (am as unknown as {
      sweepSideRunsForAgent: (a: string, n: number) => void;
    }).sweepSideRunsForAgent(AGENT, Date.now());
    sweep();

    expect(existsSync(join(sideRunDir(stateDir), observedName))).toBe(false);
    sweep();
    const events = logEventMock.mock.calls.filter((c) => c[4] === 'cron_side_run_fallback');
    expect(events).toHaveLength(1);
  });
});

describe('side-run path — an escalation reaches the main session with its summary', () => {
  it('injects the summary, not the original prompt', () => {
    const am = makeManager(root);
    const admissionId = '2026-08-07T14:30:00.000Z';
    const admittedAtMs = Date.parse(admissionId);
    const stateDir = stateDirFor(am);

    writeOutcomeSlot(
      stateDir,
      { admissionId, status: 'escalate', summary: '2 new voicemails' },
      { admissionId, cronName: 'voice-watch', admittedAtMs, deadlineMs: SIDE_RUN_DEADLINE_MS, cronPrompt: 'p' },
    );

    (am as unknown as { sweepSideRunsForAgent: (a: string, n: number) => void })
      .sweepSideRunsForAgent(AGENT, admittedAtMs + 1_000);

    expect(injected).toHaveLength(1);
    expect(injected[0].text).toContain('2 new voicemails');
    expect(injected[0].text).toContain('voice-watch');
  });
});

/* ── heartbeat preflight, end to end ──────────────────────────────────── */

const { parseSideRunOutput } = await import('../../src/daemon/cron-side-run.js');
const { resolveSideRunRouting, ELIGIBLE } = await import('../../src/daemon/cron-side-run.js');
const { mkdirSync: mkd, writeFileSync: wfs } = await import('fs');
const { createHash } = await import('crypto');

const HB_PROMPT_TXT = 'Read and follow .claude/skills/heartbeat/SKILL.md';
const HB_REL = '.claude/skills/heartbeat/SKILL.md';
const REPO_ROOT = join(dirname(new URL(import.meta.url).pathname), '..', '..');
// SYNTHETIC skill bytes — see the note in tests/unit/daemon/cron-side-run.test.ts.
// Reading the live agent skill file made this suite pass locally and fail at
// load in CI: agent `.claude/` dirs are symlinked runtime and are not tracked.
const REAL_SKILL = Buffer.from('# Heartbeat\n\nSynthetic stand-in for the pinned skill file.\nSteps 0-13.\n');
const REAL_SKILL_SHA = createHash('sha256').update(REAL_SKILL).digest('hex');
/** Shipped rows with ONLY the unshippable file pin swapped. */
const TEST_REGISTRY = ELIGIBLE.map((e) => (
  e.cronName === 'heartbeat' ? { ...e, fileSha256: REAL_SKILL_SHA } : e
));

function agentDirWithSkill(root: string, name: string, contents: Buffer | string): string {
  const d = join(root, name);
  mkd(join(d, '.claude', 'skills', 'heartbeat'), { recursive: true });
  wfs(join(d, HB_REL), contents);
  return d;
}

describe('heartbeat preflight — the DELIVERED summary carries the not-stamped banner', () => {
  it('injects a summary whose first line says the heartbeat was NOT stamped', () => {
    const am = makeManager(root);
    const admissionId = '2026-08-07T16:40:00.000Z';
    const admittedAtMs = Date.parse(admissionId);
    const stateDir = stateDirFor(am);

    // Drive the REAL parser with the shape a side-run actually emits, so the
    // assertion is on what the main session RECEIVES rather than on what the
    // prompt asks for. A prompt-only assertion is a docs promise.
    const stdout = [
      'ESCALATE: HEARTBEAT NOT STAMPED — no writes performed; main session owns the stamp and all writes.',
      'inbox 0; in-progress 1 (2h); pending 499; approvals 2 (65h, 66h); MEMORY.md 21171B',
    ].join('\n');
    const slot = parseSideRunOutput(admissionId, stdout, admittedAtMs);
    writeOutcomeSlot(stateDir, slot, {
      admissionId, cronName: 'heartbeat', admittedAtMs,
      deadlineMs: SIDE_RUN_DEADLINE_MS, cronPrompt: HB_PROMPT_TXT,
    });

    (am as unknown as { sweepSideRunsForAgent: (a: string, n: number) => void })
      .sweepSideRunsForAgent(AGENT, admittedAtMs + 1_000);

    expect(injected).toHaveLength(1);
    expect(injected[0].text).toContain('HEARTBEAT NOT STAMPED');
    expect(injected[0].text).toContain('main session owns the stamp');
    expect(injected[0].text).toContain('heartbeat');
  });

  it('falls back to the FULL heartbeat when the preflight never answers', () => {
    const am = makeManager(root);
    const admissionId = '2026-08-07T16:50:00.000Z';
    const admittedAtMs = Date.parse(admissionId);
    const stateDir = stateDirFor(am);
    writePendingSlot(stateDir, {
      admissionId, cronName: 'heartbeat', admittedAtMs,
      deadlineMs: SIDE_RUN_DEADLINE_MS, cronPrompt: HB_PROMPT_TXT,
      sideRunPrompt: 'the frozen collection prompt',
    });

    (am as unknown as { sweepSideRunsForAgent: (a: string, n: number) => void })
      .sweepSideRunsForAgent(AGENT, admittedAtMs + SIDE_RUN_DEADLINE_MS + 1);

    // The main session must receive the ORIGINAL cron prompt — the full heartbeat —
    // not the collection substitute. A fallback has to reproduce exactly what would
    // have fired without routing.
    expect(injected).toHaveLength(1);
    expect(injected[0].text).toBe(HB_PROMPT_TXT);
    const ev = logEventMock.mock.calls.filter((c) => c[4] === 'cron_side_run_fallback');
    expect(ev[0][6]).toMatchObject({ cron: 'heartbeat', reason: 'deadline_expired', injected: true });
  });
});

describe('heartbeat preflight — isolation lives in the FILE pin, not the prompt hash', () => {
  it('an edited file stops routing for THAT agent only, leaving the other two routed', () => {
    // The cron prompt is byte-identical across coordinator, worker and analyst, so the
    // prompt hash cannot distinguish them. If per-agent isolation is real it must
    // come entirely from the referenced-file pin — this is the test that proves it.
    const dirs = {
      coordinator: agentDirWithSkill(root, 'coordinator-dir', REAL_SKILL),
      worker: agentDirWithSkill(root, 'worker-dir', REAL_SKILL),
      analyst: agentDirWithSkill(root, 'analyst-dir', Buffer.concat([REAL_SKILL, Buffer.from('\nlocal edit\n')])),
    };
    const resolve = (agent: keyof typeof dirs) => resolveSideRunRouting({
      cron: { name: 'heartbeat', prompt: HB_PROMPT_TXT },
      runtime: 'claude-code',
      admissionId: '2026-08-07T17:00:00.000Z',
      agent,
      agentDir: dirs[agent],
      registry: TEST_REGISTRY,
    });

    expect(resolve('coordinator')).not.toBeNull();
    expect(resolve('worker')).not.toBeNull();
    expect(resolve('analyst')).toBeNull(); // edited file -> routes home, alone
  });
});

describe('heartbeat escalation — the DIRECTIVE reaches the main session, not just the counts', () => {
  it('carries the continuation from admission, through the slot, into the injected text', () => {
    // The gap this closes: the escalation delivered a banner and some counts. The
    // instructions saying what the main session still owed lived in the side-run's
    // own prompt, which the main session never sees. Every assertion below is
    // about the text the session RECEIVES.
    const am = makeManager(root);
    const admissionId = '2026-08-07T17:36:00.000Z';
    const stateDir = stateDirFor(am);

    // REAL admission, driven through injectCronAgent, via the manager's registry
    // seam. Constructing the pending slot by hand instead left the copy of
    // plan.continuationPrompt into that slot with no coverage — a mutation
    // deleting it stayed green, which is why the seam exists.
    //
    // TEST_REGISTRY is the SHIPPED rows with only the unshippable file pin
    // swapped, so the directive under assertion is production's own text.
    (am as unknown as { sideRunRegistry: unknown }).sideRunRegistry = TEST_REGISTRY;
    mkd(join(root, 'agentdir', '.claude', 'skills', 'heartbeat'), { recursive: true });
    wfs(join(root, 'agentdir', HB_REL), REAL_SKILL);

    const ok = (am as unknown as {
      injectCronAgent: (a: string, c: unknown, t: string, f: string) => boolean;
    }).injectCronAgent(AGENT, { name: 'heartbeat', prompt: HB_PROMPT_TXT }, HB_PROMPT_TXT, admissionId);

    expect(ok).toBe(true);
    expect(injected).toHaveLength(0); // routed to the side-run, nothing injected yet

    // Admission must have PERSISTED the directive. Resolving it at escalate time
    // instead would let a registry edit change what an in-flight fire says.
    const slot = readSlotRaw(stateDir, admissionId) as { pending: Record<string, unknown> };
    expect(slot.pending.continuationPrompt).toContain('Read HEARTBEAT.md');

    const summary = 'HEARTBEAT NOT STAMPED — no writes performed; main session owns the stamp and all writes.\ninbox: 0 messages';
    writeOutcomeSlot(stateDir, { admissionId, status: 'escalate', summary }, slot.pending as never);

    (am as unknown as { sweepSideRunsForAgent: (a: string, n: number) => void })
      .sweepSideRunsForAgent(AGENT, Date.parse(admissionId) + 1_000);

    expect(injected).toHaveLength(1);
    const text = injected[0].text;
    expect(text).toContain('mid-procedure handoff, not a status report');
    expect(text).toContain('Read HEARTBEAT.md and complete every remaining heartbeat requirement');
    expect(text).toContain('stamping the heartbeat yourself');
    expect(text).toContain('did NOT update the heartbeat');
    // The collected state still arrives in full.
    expect(text).toContain('inbox: 0 messages');
    // And the directive comes FIRST: a reader who stops early hits the
    // instruction rather than the counts.
    expect(text.indexOf('Read HEARTBEAT.md')).toBeLessThan(text.indexOf('inbox: 0 messages'));
  });
});
