import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  slotFileName,
  sideRunDir,
  writePendingSlot,
  writeOutcomeSlot,
  readSlotRaw,
  clearSlot,
  clearObservedSlot,
  sweepSideRuns,
  startSideRun,
  type SideRunPending,
} from '../../../src/daemon/cron-side-run-runner.js';
import { SIDE_RUN_DEADLINE_MS, SIDE_RUN_MODEL } from '../../../src/daemon/cron-side-run.js';

let stateDir: string;
const ADMITTED = 1_000_000;

const pending = (over: Partial<SideRunPending> = {}): SideRunPending => ({
  admissionId: '2026-08-07T14:00:00.000Z',
  cronName: 'voice-watch',
  admittedAtMs: ADMITTED,
  deadlineMs: SIDE_RUN_DEADLINE_MS,
  cronPrompt: 'run the watcher',
  ...over,
});

beforeEach(() => { stateDir = mkdtempSync(join(tmpdir(), 'side-run-')); });
afterEach(() => { rmSync(stateDir, { recursive: true, force: true }); });

describe('slot storage', () => {
  it('hashes the admission id into the filename', () => {
    // Admission ids are ISO strings with colons, and a hash also stops a crafted
    // cron name from escaping the directory.
    const name = slotFileName('2026-08-07T14:00:00.000Z');
    expect(name).toMatch(/^[0-9a-f]{32}\.json$/);
    expect(name).not.toContain(':');
  });

  it('round-trips a pending slot', () => {
    const p = pending();
    writePendingSlot(stateDir, p);
    const raw = readSlotRaw(stateDir, p.admissionId) as Record<string, unknown>;
    expect(raw.status).toBe('pending');
    expect(raw.admissionId).toBe(p.admissionId);
  });

  it('returns null for a slot that was never written', () => {
    expect(readSlotRaw(stateDir, 'nope')).toBeNull();
  });

  it('DISTINGUISHES unreadable from missing', () => {
    // These are different failures and only one means the side-run never started.
    // Collapsing them to null would be absence-is-not-evidence all over again.
    const p = pending();
    mkdirSync(sideRunDir(stateDir), { recursive: true });
    writeFileSync(join(sideRunDir(stateDir), slotFileName(p.admissionId)), '{not json', 'utf8');
    expect(readSlotRaw(stateDir, p.admissionId)).toBe('<unparseable>');
    expect(readSlotRaw(stateDir, 'other-id')).toBeNull();
  });

  it('clears a slot and tolerates clearing one that is already gone', () => {
    const p = pending();
    writePendingSlot(stateDir, p);
    clearSlot(stateDir, p.admissionId);
    expect(readSlotRaw(stateDir, p.admissionId)).toBeNull();
    expect(() => clearSlot(stateDir, p.admissionId)).not.toThrow();
  });

  it('refuses an observed filename that resolves outside the side-run directory', () => {
    const outside = join(stateDir, 'outside.json');
    writeFileSync(outside, 'keep', 'utf8');

    clearObservedSlot(stateDir, '../outside.json');

    expect(existsSync(outside)).toBe(true);
  });
});

describe('sweepSideRuns', () => {
  it('returns nothing when there is no side-run directory at all', () => {
    expect(sweepSideRuns(stateDir, ADMITTED + 1)).toEqual([]);
  });

  it('WAITS on a fresh pending slot — no action, no fallback', () => {
    writePendingSlot(stateDir, pending());
    expect(sweepSideRuns(stateDir, ADMITTED + 1_000)).toEqual([]);
  });

  it('FALLS BACK once the deadline passes with the slot still pending', () => {
    const p = pending();
    writePendingSlot(stateDir, p);
    const actions = sweepSideRuns(stateDir, ADMITTED + SIDE_RUN_DEADLINE_MS + 1);
    expect(actions).toHaveLength(1);
    expect(actions[0].cronName).toBe('voice-watch');
    expect(actions[0].verdict).toEqual({ action: 'fallback', reason: 'deadline_expired' });
  });

  it('reports done on a clean outcome', () => {
    const p = pending();
    writeOutcomeSlot(stateDir, { admissionId: p.admissionId, status: 'clean' }, p);
    const actions = sweepSideRuns(stateDir, ADMITTED + 5);
    expect(actions[0].verdict).toEqual({ action: 'done', reason: 'clean' });
  });

  it('reports escalate with the summary', () => {
    const p = pending();
    writeOutcomeSlot(
      stateDir,
      { admissionId: p.admissionId, status: 'escalate', summary: '1 new voicemail' },
      p,
    );
    const actions = sweepSideRuns(stateDir, ADMITTED + 5);
    expect(actions[0].verdict).toEqual({ action: 'escalate', summary: '1 new voicemail' });
  });

  it('reports a slot with a corrupt pending block as a FALLBACK, never drops it', () => {
    // A dropped slot looks like a completed fire. That is the single outcome
    // this whole design exists to prevent, so a broken slot must still surface.
    mkdirSync(sideRunDir(stateDir), { recursive: true });
    writeFileSync(join(sideRunDir(stateDir), 'aaaa.json'), JSON.stringify({ status: 'clean' }), 'utf8');
    const actions = sweepSideRuns(stateDir, ADMITTED + 5);
    expect(actions).toHaveLength(1);
    expect(actions[0].verdict).toEqual({ action: 'fallback', reason: 'slot_unreadable' });
  });

  it('reports an unparseable slot file as a fallback', () => {
    mkdirSync(sideRunDir(stateDir), { recursive: true });
    writeFileSync(join(sideRunDir(stateDir), 'bbbb.json'), 'not json at all', 'utf8');
    const actions = sweepSideRuns(stateDir, ADMITTED + 5);
    expect(actions[0].verdict.action).toBe('fallback');
  });

  it('handles many outstanding slots independently', () => {
    const a = pending({ admissionId: 'A' });
    const b = pending({ admissionId: 'B' });
    writePendingSlot(stateDir, a);
    writeOutcomeSlot(stateDir, { admissionId: 'B', status: 'clean' }, b);
    const actions = sweepSideRuns(stateDir, ADMITTED + SIDE_RUN_DEADLINE_MS + 1);
    const byId = Object.fromEntries(actions.map((x) => [x.admissionId, x.verdict.action]));
    expect(byId.A).toBe('fallback');
    expect(byId.B).toBe('done');
  });
});

describe('startSideRun — a crashed side-run can never author a verdict', () => {
  function fakeChild(opts: { code: number | null; stdout?: string; throwOnSpawn?: boolean }) {
    const handlers: Record<string, ((...a: unknown[]) => void)[]> = {};
    const child = {
      stdout: { on: (_e: string, cb: (d: string) => void) => { if (opts.stdout !== undefined) cb(opts.stdout); } },
      stderr: { on: () => {} },
      on: (e: string, cb: (...a: unknown[]) => void) => { (handlers[e] ??= []).push(cb); },
    };
    const spawnFn = (() => {
      if (opts.throwOnSpawn) throw new Error('spawn failed');
      return child;
    }) as unknown as typeof import('child_process').spawn;
    return { spawnFn, fire: (e: string, ...a: unknown[]) => (handlers[e] ?? []).forEach((cb) => cb(...a)) };
  }

  it('writes a clean slot when the run exits 0 saying CLEAN', () => {
    const p = pending();
    const { spawnFn, fire } = fakeChild({ code: 0, stdout: 'CLEAN\n' });
    startSideRun(stateDir, stateDir, { admissionId: p.admissionId } as never, p, { spawnFn, now: () => 42 });
    fire('close', 0);
    const raw = readSlotRaw(stateDir, p.admissionId) as Record<string, unknown>;
    expect(raw.status).toBe('clean');
  });

  it('leaves the slot PENDING on a non-zero exit', () => {
    const p = pending();
    writePendingSlot(stateDir, p);
    const { spawnFn, fire } = fakeChild({ code: 1, stdout: 'CLEAN\n' });
    startSideRun(stateDir, stateDir, { admissionId: p.admissionId } as never, p, { spawnFn, now: () => 42 });
    fire('close', 1);
    // Even though stdout said CLEAN, a failed run must not close the fire.
    expect((readSlotRaw(stateDir, p.admissionId) as Record<string, unknown>).status).toBe('pending');
  });

  it('leaves the slot PENDING when the process errors', () => {
    const p = pending();
    writePendingSlot(stateDir, p);
    const { spawnFn, fire } = fakeChild({ code: null });
    startSideRun(stateDir, stateDir, { admissionId: p.admissionId } as never, p, { spawnFn });
    fire('error', new Error('boom'));
    expect((readSlotRaw(stateDir, p.admissionId) as Record<string, unknown>).status).toBe('pending');
  });

  it('never throws when spawn itself fails, and leaves the slot pending', () => {
    const p = pending();
    writePendingSlot(stateDir, p);
    const { spawnFn } = fakeChild({ code: null, throwOnSpawn: true });
    expect(() =>
      startSideRun(stateDir, stateDir, { admissionId: p.admissionId } as never, p, { spawnFn }),
    ).not.toThrow();
    expect((readSlotRaw(stateDir, p.admissionId) as Record<string, unknown>).status).toBe('pending');
  });

  it('passes the cheap model and the check text to the process', () => {
    const p = pending();
    let seen: unknown[] = [];
    const spawnFn = ((_cmd: string, args: unknown[]) => {
      seen = args;
      return { stdout: { on: () => {} }, stderr: { on: () => {} }, on: () => {} };
    }) as unknown as typeof import('child_process').spawn;
    startSideRun(stateDir, stateDir, { admissionId: p.admissionId } as never, p, { spawnFn });
    expect(seen).toContain('--model');
    expect(seen).toContain(SIDE_RUN_MODEL);
    expect(String(seen[1])).toContain('run the watcher');
  });
});

describe('startSideRun — a side-run must not be attributed to an agent', () => {
  it('strips CTX_AGENT_NAME and sets the CTX_SIDE_RUN marker', () => {
    // Observed 2026-08-07: with no env passed, the headless run inherited
    // CTX_AGENT_NAME from whatever spawned it, and hook-crash-alert filed its
    // NORMAL exit as a crash against an unrelated, stopped agent. Attribution
    // was inherited by accident rather than chosen.
    const p = pending();
    let opts: Record<string, unknown> = {};
    const spawnFn = ((_c: string, _a: unknown[], o: Record<string, unknown>) => {
      opts = o;
      return { stdout: { on: () => {} }, stderr: { on: () => {} }, on: () => {} };
    }) as unknown as typeof import('child_process').spawn;

    process.env.CTX_AGENT_NAME = 'some-agent';
    startSideRun(stateDir, stateDir, { admissionId: p.admissionId } as never, p, { spawnFn });
    delete process.env.CTX_AGENT_NAME;

    const env = opts.env as Record<string, string | undefined>;
    expect(env).toBeDefined();
    // Positive marker, not merely an absent name: a consumer keying on "no agent
    // name" cannot tell a side-run from a misconfigured spawn.
    expect(env.CTX_SIDE_RUN).toBe('1');
    expect(env.CTX_AGENT_NAME).toBeUndefined();
  });
});
