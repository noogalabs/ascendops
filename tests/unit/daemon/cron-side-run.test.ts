import { describe, it, expect } from 'vitest';
import {
  resolveSideRunRouting,
  resolveSideRunResolution,
  classifySlot,
  parseSideRunOutput,
  buildSideRunPrompt,
  buildEscalationInjection,
  sha256,
  ELIGIBLE,
  SIDE_RUN_MODEL,
  SIDE_RUN_DEADLINE_MS,
} from '../../../src/daemon/cron-side-run.js';

const VOICE_WATCH = ELIGIBLE.find((e) => e.cronName === 'voice-watch')!;

/**
 * The accept path is driven through a test registry pinned to a prompt we
 * control. Every other test here asserts a REJECTION, and a gate that can never
 * open would pass all of them — so a known-positive is required for any of this
 * to be evidence. The real registry's shape is asserted separately.
 */
const REVIEWED_PROMPT = 'MAINTENANCE LINE WATCH. run the watcher script.';
const TEST_REGISTRY = [
  {
    cronName: 'voice-watch',
    promptSha256: sha256(REVIEWED_PROMPT),
    rationale: 'test fixture: binary clean-or-not by construction, high volume',
  },
] as const;

describe('cron-side-run — eligibility registry', () => {
  it('pins every eligible cron by a full sha256, not by name alone', () => {
    // Name-only pinning would let a prompt edit silently change what the cheap
    // model is asked to do, and a judgment-adding edit looks exactly like a typo fix.
    expect(ELIGIBLE.length).toBeGreaterThan(0);
    for (const entry of ELIGIBLE) {
      expect(entry.promptSha256).toMatch(/^[0-9a-f]{64}$/);
      expect(entry.rationale.length).toBeGreaterThan(20);
    }
  });

  it('does NOT include inbox-sweep, permanently', () => {
    // Its prompt documents the 2026-07-16 misjudgment (a capped 20-message window
    // read as the whole inbox). A prompt carrying a warning about a past
    // misjudgment is by definition not mechanical.
    expect(ELIGIBLE.map((e) => e.cronName)).not.toContain('inbox-sweep');
  });
});

describe('cron-side-run — resolveSideRunRouting fails closed', () => {
  const base = {
    runtime: 'claude-code',
    admissionId: '2026-08-07T13:00:00.000Z',
  };

  // ── KNOWN POSITIVE ──────────────────────────────────────────────────────
  it('ROUTES a reviewed cron whose prompt matches the pin exactly', () => {
    const plan = resolveSideRunRouting({
      ...base,
      cron: { name: 'voice-watch', prompt: REVIEWED_PROMPT },
      registry: TEST_REGISTRY as unknown as typeof ELIGIBLE,
    });
    expect(plan).not.toBeNull();
    expect(plan!.routing.model).toBe(SIDE_RUN_MODEL);
    expect(plan!.routing.reason).toBe('reviewed_mechanical_side_run');
    expect(plan!.routing.promptSha256).toBe(sha256(REVIEWED_PROMPT));
    expect(plan!.admissionId).toBe(base.admissionId);
    expect(plan!.deadlineMs).toBe(SIDE_RUN_DEADLINE_MS);
  });

  it('refuses the SAME cron once one character of its prompt changes', () => {
    // Paired directly with the known-positive above: same registry, same name,
    // one edit. This is what proves the pin is doing the work rather than the name.
    const plan = resolveSideRunRouting({
      ...base,
      cron: { name: 'voice-watch', prompt: `${REVIEWED_PROMPT} ` },
      registry: TEST_REGISTRY as unknown as typeof ELIGIBLE,
    });
    expect(plan).toBeNull();
  });

  it('refuses the real registry entry when handed an edited prompt', () => {
    const plan = resolveSideRunRouting({
      ...base,
      cron: { name: 'voice-watch', prompt: 'MAINTENANCE LINE WATCH. (edited)' },
    });
    expect(plan).toBeNull();
  });

  it('refuses a cron that is not in the registry at all', () => {
    const plan = resolveSideRunRouting({
      ...base,
      cron: { name: 'inbox-sweep', prompt: 'anything' },
    });
    expect(plan).toBeNull();
  });

  it.each([
    ['codex-app-server', 'other runtimes have their own routing path'],
    ['hermes', 'never silently capture a runtime this was not designed for'],
    ['opencode', 'same'],
    [undefined, 'unknown runtime is not claude-code'],
  ])('refuses runtime %s', (runtime) => {
    expect(
      resolveSideRunRouting({ ...base, runtime: runtime as string, cron: { name: 'voice-watch', prompt: 'x' } }),
    ).toBeNull();
  });

  it('refuses when explicitly disabled, without needing a code change', () => {
    expect(
      resolveSideRunRouting({ ...base, enabled: false, cron: { name: 'voice-watch', prompt: 'x' } }),
    ).toBeNull();
  });

  it('refuses an empty admission id — the slot key must exist before anything runs', () => {
    expect(
      resolveSideRunRouting({ ...base, admissionId: '', cron: { name: 'voice-watch', prompt: 'x' } }),
    ).toBeNull();
  });

  it.each([[''], [undefined], [null]])('refuses a missing prompt (%s)', (prompt) => {
    expect(
      resolveSideRunRouting({ ...base, cron: { name: 'voice-watch', prompt: prompt as string } }),
    ).toBeNull();
  });
});

describe('cron-side-run — classifySlot: silence is the alarm', () => {
  const admissionId = 'adm-1';
  const admittedAtMs = 1_000_000;
  const deadlineMs = SIDE_RUN_DEADLINE_MS;
  const within = admittedAtMs + 1_000;
  const after = admittedAtMs + deadlineMs + 1;

  it('waits while a pending slot is inside its deadline', () => {
    const v = classifySlot({
      slot: { admissionId, status: 'pending' }, admissionId, nowMs: within, admittedAtMs, deadlineMs,
    });
    expect(v).toEqual({ action: 'wait' });
  });

  it('FALLS BACK when a pending slot passes its deadline — the case this exists for', () => {
    const v = classifySlot({
      slot: { admissionId, status: 'pending' }, admissionId, nowMs: after, admittedAtMs, deadlineMs,
    });
    // A side-run that died between verdict and delivery must never read as clean.
    expect(v).toEqual({ action: 'fallback', reason: 'deadline_expired' });
  });

  it('completes the fire on a clean slot, with no main-session cost', () => {
    const v = classifySlot({
      slot: { admissionId, status: 'clean' }, admissionId, nowMs: within, admittedAtMs, deadlineMs,
    });
    expect(v).toEqual({ action: 'done', reason: 'clean' });
  });

  it('escalates with the summary when the chore found something', () => {
    const v = classifySlot({
      slot: { admissionId, status: 'escalate', summary: 'new voicemail from 423-555-0100' },
      admissionId, nowMs: within, admittedAtMs, deadlineMs,
    });
    expect(v).toEqual({ action: 'escalate', summary: 'new voicemail from 423-555-0100' });
  });

  it.each([
    ['missing slot after deadline', null, after, 'slot_missing'],
    ['a string instead of an object', 'CLEAN', within, 'slot_unreadable'],
    ['an array', [], within, 'slot_unreadable'],
    ['a status from a future version', { admissionId, status: 'deferred' }, within, 'unknown_status'],
    ['escalate with no summary', { admissionId, status: 'escalate', summary: '  ' }, within, 'escalate_no_summary'],
  ] as const)('falls back on %s', (_label, slot, nowMs, reason) => {
    const v = classifySlot({ slot, admissionId, nowMs, admittedAtMs, deadlineMs });
    expect(v).toEqual({ action: 'fallback', reason });
  });

  it('waits, not falls back, when the slot is merely missing before the deadline', () => {
    const v = classifySlot({ slot: null, admissionId, nowMs: within, admittedAtMs, deadlineMs });
    expect(v).toEqual({ action: 'wait' });
  });

  it('REFUSES a slot belonging to a different admission, even a clean one', () => {
    // Without this, a stale clean result from an earlier fire could close a fire
    // whose chore never ran — a skipped check that looks like a pass.
    const v = classifySlot({
      slot: { admissionId: 'adm-OTHER', status: 'clean' },
      admissionId, nowMs: within, admittedAtMs, deadlineMs,
    });
    expect(v).toEqual({ action: 'fallback', reason: 'identity_mismatch' });
  });

  it('never returns done or escalate for any malformed input', () => {
    const malformed = [null, undefined, 0, '', 'clean', [], { status: 'clean' }, { admissionId }];
    for (const slot of malformed) {
      const v = classifySlot({ slot, admissionId, nowMs: after, admittedAtMs, deadlineMs });
      expect(['fallback', 'wait']).toContain(v.action);
    }
  });
});

describe('cron-side-run — parseSideRunOutput never fabricates a verdict', () => {
  const id = 'adm-2';

  it('reads CLEAN', () => {
    expect(parseSideRunOutput(id, 'CLEAN\n', 5).status).toBe('clean');
  });

  it('reads ESCALATE with its summary', () => {
    const slot = parseSideRunOutput(id, 'ESCALATE: 2 new voicemails\n', 5);
    expect(slot.status).toBe('escalate');
    expect(slot.summary).toBe('2 new voicemails');
  });

  it('uses the LAST line, so a preamble cannot decide the verdict', () => {
    const slot = parseSideRunOutput(id, 'Let me run that check for you.\nCLEAN', 5);
    expect(slot.status).toBe('clean');
  });

  it.each([
    ['prose with no verdict', 'Everything looks fine to me.'],
    ['empty output', ''],
    ['a crash trace', 'Traceback (most recent call last):\n  File "x.py"'],
    ['the word clean buried mid-sentence', 'the log was clean but I could not reach the API'],
  ])('leaves %s PENDING rather than guessing clean', (_label, stdout) => {
    // Unrecognised output routes to the deadline path, which falls back. The one
    // outcome that must never be inferred is "nothing to see here".
    expect(parseSideRunOutput(id, stdout, 5).status).toBe('pending');
  });

  it('keeps an empty ESCALATE as escalate, and classifySlot then falls back', () => {
    const slot = parseSideRunOutput(id, 'ESCALATE:', 5);
    expect(slot.status).toBe('escalate');
    const v = classifySlot({
      slot, admissionId: id, nowMs: 10, admittedAtMs: 0, deadlineMs: 100,
    });
    expect(v).toEqual({ action: 'fallback', reason: 'escalate_no_summary' });
  });
});

describe('cron-side-run — prompt contract', () => {
  it('tells the side-run to escalate when unsure, and says why', () => {
    const p = buildSideRunPrompt('run the watcher');
    expect(p).toContain('run the watcher');
    expect(p).toMatch(/unsure/i);
    // The asymmetry has to be stated, not implied: a wrong CLEAN is invisible,
    // a wrong ESCALATE costs one main-session fire.
    expect(p).toMatch(/nobody ever sees it/i);
  });

  it('forbids the side-run from acting on what it finds', () => {
    const p = buildSideRunPrompt('x');
    expect(p).toMatch(/do not triage|do NOT triage/i);
  });

  it('pins the cheap model and a finite deadline', () => {
    expect(SIDE_RUN_MODEL).toContain('haiku');
    expect(SIDE_RUN_DEADLINE_MS).toBeGreaterThan(0);
    expect(Number.isFinite(SIDE_RUN_DEADLINE_MS)).toBe(true);
  });
});

/* ── heartbeat collection: pinned file + frozen substitute ─────────────── */

import { createHash } from 'crypto';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import {
  HEARTBEAT_COLLECTION_AUTHORITY_BASE64,
  HEARTBEAT_COLLECTION_AUTHORITY_SHA256,
} from '../../../src/daemon/heartbeat-collection-authority.js';

const HB_PROMPT = 'Read and follow .claude/skills/heartbeat/SKILL.md';
const HB_FILE = '.claude/skills/heartbeat/SKILL.md';
const REPO = join(dirname(new URL(import.meta.url).pathname), '..', '..', '..');

/** Build an agent dir whose skill file has the given contents. */
function agentDirWith(contents: Buffer | string): string {
  const dir = mkdtempSync(join(tmpdir(), 'hb-agent-'));
  mkdirSync(join(dir, '.claude', 'skills', 'heartbeat'), { recursive: true });
  writeFileSync(join(dir, HB_FILE), contents);
  return dir;
}

describe('heartbeat collection — the substitute prompt is a frozen artifact', () => {
  it('keeps the reviewed source bytes in exact parity with the bundled authority', () => {
    // Mirrors the codex heartbeat-preflight-authority parity test. Without this,
    // the substitute becomes the one unpinned instruction path in a build whose
    // entire purpose is pinning instruction paths.
    const source = readFileSync(join(REPO, 'config/claude-cron-routing/heartbeat-collection.md'));
    const bundled = Buffer.from(HEARTBEAT_COLLECTION_AUTHORITY_BASE64, 'base64');
    expect(createHash('sha256').update(source).digest('hex')).toBe(HEARTBEAT_COLLECTION_AUTHORITY_SHA256);
    expect(bundled.equals(source)).toBe(true);
  });

  it('forbids the one write that would break the signal it reports on', () => {
    const text = Buffer.from(HEARTBEAT_COLLECTION_AUTHORITY_BASE64, 'base64').toString('utf8');
    // A side-run stamping the heartbeat would make a dead agent read as running:
    // the heartbeat proves the agent SESSION is alive, a side-run proves only the
    // daemon is. This is the reason the boundary is read-only at all.
    expect(text).toMatch(/do \*\*not\*\* run `cortextos bus update-heartbeat`/i);
    expect(text).toMatch(/would make a dead agent look running/i);
    expect(text).toMatch(/HEARTBEAT NOT STAMPED/);
    expect(text).toMatch(/always escalate/i);
  });
});

describe('heartbeat collection — routing requires BOTH hashes', () => {
  const dirs: string[] = [];
  afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

  // SYNTHETIC skill bytes, not the live agent file.
  //
  // These tests originally read your org internal docs
  // heartbeat/SKILL.md. That file exists on a provisioned tree but agent
  // `.claude/` dirs are symlinked runtime and are NOT tracked, so CI failed at
  // load with ENOENT while every local run passed — tracked-vs-gitignored
  // divergence, a test depending on something the repo does not ship.
  //
  // A test may only depend on what ships. The REGISTRY pinning the real file's
  // sha stays correct and untouched: the daemon reads the live tree at runtime.
  // Here the shipped rows are reused verbatim with ONLY the one unshippable
  // value swapped, so everything else under test — agent matching, the prompt
  // pin, the substitute, alwaysEscalate, the continuation — is the real config.
  const REAL = Buffer.from('# Heartbeat\n\nSynthetic stand-in for the pinned skill file.\nSteps 0-13.\n');
  const REAL_SHA = createHash('sha256').update(REAL).digest('hex');
  const TEST_REGISTRY = ELIGIBLE.map((e) => (
    e.cronName === 'heartbeat' ? { ...e, fileSha256: REAL_SHA } : e
  ));

  function resolveFor(agent: string, contents: Buffer | string, prompt = HB_PROMPT) {
    const dir = agentDirWith(contents); dirs.push(dir);
    return resolveSideRunRouting({
      cron: { name: 'heartbeat', prompt },
      runtime: 'claude-code',
      admissionId: '2026-08-07T16:00:00.000Z',
      agent,
      agentDir: dir,
      registry: TEST_REGISTRY,
    });
  }

  // KNOWN POSITIVE — without this every assertion below is satisfied by a gate
  // that can never open.
  it.each(['coordinator', 'worker', 'analyst'])('ROUTES %s heartbeat when prompt AND file match', (agent) => {
    const plan = resolveFor(agent, REAL);
    expect(plan).not.toBeNull();
    expect(plan!.alwaysEscalate).toBe(true);
    expect(plan!.prompt).toContain('HEARTBEAT NOT STAMPED');
    expect(plan!.prompt).not.toBe(HB_PROMPT); // the substitute, not the pointer
  });

  it('the PLAN carries the continuation through to admission', () => {
    // The resolver is where the directive enters the pipeline. Without this the
    // field could stop being returned and only an end-to-end test would notice —
    // and that end-to-end path cannot run in CI, so nothing would.
    const plan = resolveFor('coordinator', REAL);
    expect(plan!.continuationPrompt).toContain('Read HEARTBEAT.md');
    expect(plan!.continuationPrompt).toContain('did NOT update the heartbeat');
  });

  it('refuses an agent with no registry entry, even with a valid file', () => {
    expect(resolveFor('brooks', REAL)).toBeNull();
  });

  it('REFUSES when the referenced skill file has been edited', () => {
    // The whole reason the pin was extended: hashing the pointer proves nothing
    // while the instructions behind it change freely.
    expect(resolveFor('coordinator', Buffer.concat([REAL, Buffer.from('\nUnreviewed step.\n')]))).toBeNull();
  });

  it('REFUSES when the referenced file is missing entirely', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hb-agent-')); dirs.push(dir);
    expect(resolveSideRunRouting({
      cron: { name: 'heartbeat', prompt: HB_PROMPT },
      runtime: 'claude-code', admissionId: 'x', agent: 'coordinator', agentDir: dir,
      // TEST_REGISTRY so the null can ONLY be the missing file. Against the
      // shipped registry this would also be null, for a different reason, and
      // the assertion would pass without testing anything.
      registry: TEST_REGISTRY,
    })).toBeNull();
  });

  it('REFUSES when no agentDir is supplied — cannot verify means do not route', () => {
    expect(resolveSideRunRouting({
      cron: { name: 'heartbeat', prompt: HB_PROMPT },
      runtime: 'claude-code', admissionId: 'x', agent: 'coordinator', registry: TEST_REGISTRY,
    })).toBeNull();
  });

  it('refuses an edited cron prompt even when the file is untouched', () => {
    expect(resolveFor('coordinator', REAL, `${HB_PROMPT} `)).toBeNull();
  });
});

describe('heartbeat collection — parser accepts REAL haiku output', () => {
  it('parses a real side-run response and preserves the multi-line summary', () => {
    // Captured from a live `claude -p` run of the frozen collection prompt on
    // 2026-08-07 (fixture: tests/fixtures/heartbeat-collection-haiku-output.txt).
    //
    // The first parser read only the LAST non-empty line, which is correct for a
    // one-word CLEAN and wrong for every real collection summary: the verdict is
    // on line 1 and detail rows follow, so the last line matched nothing and the
    // slot parsed as `pending`. Every heartbeat preflight would have fallen back
    // forever — routing that looked enabled while nothing was routed.
    const real = readFileSync(join(REPO, 'tests/fixtures/heartbeat-collection-haiku-output.txt'), 'utf8');
    const slot = parseSideRunOutput('adm-real', real, 1000);

    expect(slot.status).toBe('escalate');
    expect(slot.summary).toContain('HEARTBEAT NOT STAMPED');
    expect(slot.summary).toContain('main session owns the stamp');
    // The detail rows must survive: a summary truncated to its first line would
    // hand the main session a banner and no data.
    expect(slot.summary!.split('\n').length).toBeGreaterThan(3);
    expect(slot.summary).toMatch(/GOALS|Inbox|Pending/i);

    const v = classifySlot({
      slot, admissionId: 'adm-real', nowMs: 2000, admittedAtMs: 1000, deadlineMs: SIDE_RUN_DEADLINE_MS,
    });
    expect(v.action).toBe('escalate');
  });
});

describe('buildEscalationInjection', () => {
  it('with NO continuation, produces exactly the pre-continuation bytes', () => {
    // Regression lock for voice-watch and every future anomaly-shaped cron: a
    // mechanism added for the handoff case must not alter the alarm case.
    expect(buildEscalationInjection({ cronName: 'voice-watch', summary: '2 new voicemails' }))
      .toBe('[CRON ESCALATION] voice-watch\n2 new voicemails');
  });

  it('puts the directive between the banner and the collected block', () => {
    const text = buildEscalationInjection({
      cronName: 'heartbeat',
      summary: 'inbox: 0',
      continuationPrompt: 'DO THE THING',
    });
    expect(text.split('\n')[0]).toBe('[CRON ESCALATION] heartbeat');
    expect(text.indexOf('DO THE THING')).toBeLessThan(text.indexOf('[COLLECTED]'));
    expect(text.indexOf('[COLLECTED]')).toBeLessThan(text.indexOf('inbox: 0'));
  });

  it('never drops the collected summary in favour of the directive', () => {
    // The directive is an addition. Losing the counts would trade one incomplete
    // handoff for another.
    const text = buildEscalationInjection({
      cronName: 'heartbeat', summary: 'line one\nline two', continuationPrompt: 'x',
    });
    expect(text).toContain('line one\nline two');
  });
});

describe('heartbeat rows carry a continuation, and the resolver hands it to admission', () => {
  it('every alwaysEscalate row declares one', () => {
    // alwaysEscalate means the escalation IS the handoff. A handoff with no
    // directive is the defect this closes, so the two must travel together.
    const handoffs = ELIGIBLE.filter((e) => e.alwaysEscalate);
    expect(handoffs.length).toBeGreaterThan(0);
    for (const e of handoffs) {
      expect(e.continuationPrompt, `${e.cronName}/${e.agent}`).toBeTruthy();
    }
  });

  it('states the inverse of the codex preflight on the stamp', () => {
    // The codex preflight stamps before handing off; this one deliberately does
    // not. Reusing the codex wording here would assert something false.
    const e = ELIGIBLE.find((x) => x.cronName === 'heartbeat' && x.agent === 'worker');
    expect(e?.continuationPrompt).toContain('did NOT update the heartbeat');
    expect(e?.continuationPrompt).toContain('stamping the heartbeat yourself');
  });

  it('anomaly-shaped rows declare NO continuation', () => {
    expect(ELIGIBLE.find((e) => e.cronName === 'voice-watch')?.continuationPrompt).toBeUndefined();
  });
});

describe('decline reasons — a rejection must be COUNTABLE, not silent', () => {
  const dirs: string[] = [];
  afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

  const SYNTH = Buffer.from('# Heartbeat\n\nSynthetic stand-in for the pinned skill file.\nSteps 0-13.\n');
  const SYNTH_SHA = createHash('sha256').update(SYNTH).digest('hex');
  const REG = ELIGIBLE.map((e) => (e.cronName === 'heartbeat' ? { ...e, fileSha256: SYNTH_SHA } : e));

  function resolveWith(contents: Buffer | string, prompt = HB_PROMPT) {
    const dir = agentDirWith(contents); dirs.push(dir);
    return resolveSideRunResolution({
      cron: { name: 'heartbeat', prompt },
      runtime: 'claude-code', admissionId: 'x', agent: 'coordinator', agentDir: dir, registry: REG,
    });
  }

  it('THE SUNDAY CASE: an edited pinned file declines with referenced_file_hash_mismatch', () => {
    // This is the exact condition that switched routing off fleet-wide on
    // 2026-08-09 and produced no telemetry at all. It must now be countable.
    const r = resolveWith(Buffer.concat([SYNTH, Buffer.from('\nskill-audit edit\n')]));
    expect(r.plan).toBeNull();
    expect(r.reason).toBe('referenced_file_hash_mismatch');
    expect(r.candidate).toBe(true);
  });

  it('reports candidate=TRUE on decline so the caller can tell should-route from ordinary', () => {
    // Without this the event either floods (every cron) or stays silent (none).
    const r = resolveWith(SYNTH, `${HB_PROMPT} `);
    expect(r.plan).toBeNull();
    expect(r.reason).toBe('prompt_hash_mismatch');
    expect(r.candidate).toBe(true);
  });

  it('reports candidate=FALSE for a cron that is not in the registry at all', () => {
    const r = resolveSideRunResolution({
      cron: { name: 'inbox-sweep', prompt: 'sweep' },
      runtime: 'claude-code', admissionId: 'x', agent: 'coordinator', registry: REG,
    });
    expect(r.plan).toBeNull();
    expect(r.reason).toBe('not_in_registry');
    expect(r.candidate).toBe(false);
  });

  it('distinguishes missing file from mismatched file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hb-empty-')); dirs.push(dir);
    const r = resolveSideRunResolution({
      cron: { name: 'heartbeat', prompt: HB_PROMPT },
      runtime: 'claude-code', admissionId: 'x', agent: 'coordinator', agentDir: dir, registry: REG,
    });
    expect(r.reason).toBe('referenced_file_missing');
  });

  it('the ACCEPT path still returns a plan and no reason', () => {
    // Known positive: without it every assertion above is satisfied by a
    // resolver that can only decline.
    const r = resolveWith(SYNTH);
    expect(r.plan).not.toBeNull();
    expect(r.reason).toBeUndefined();
    expect(r.candidate).toBe(true);
  });

  it('resolveSideRunRouting keeps its original contract', () => {
    expect(resolveSideRunRouting({
      cron: { name: 'heartbeat', prompt: HB_PROMPT },
      runtime: 'codex-app-server', admissionId: 'x', agent: 'coordinator', registry: REG,
    })).toBeNull();
  });
});
