import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const execFileMock = vi.fn();
vi.mock('child_process', () => ({
  execFile: (...args: unknown[]) => execFileMock(...args),
}));

import { readMaxCrashesPerDay, notifyAgents, safeCrashCount, classifyFromMarkers, readCrashCountToday } from '../../../src/hooks/hook-crash-alert';
import { clearEndMarkers } from '../../../src/bus/heartbeat';

describe('safeCrashCount NaN-guard (bug-hunt #8)', () => {
  // Mirrors AgentProcess.safeCrashCount. All four hook crash-count sites route
  // through this helper (same-day increment :212, read-only :224, cap compare
  // :263, display :319), so guaranteeing finite coercion here guarantees no
  // NaN reaches the writeback or the `crashCount < maxCrashes` cap comparison.

  it('valid numeric token parses unchanged', () => {
    expect(safeCrashCount('0')).toBe(0);
    expect(safeCrashCount('3')).toBe(3);
    expect(safeCrashCount('10')).toBe(10);
  });

  it('non-numeric token coerces to safe 0 (not NaN)', () => {
    expect(safeCrashCount('abc')).toBe(0);
    expect(Number.isFinite(safeCrashCount('abc'))).toBe(true);
  });

  it('undefined token (no colon in file) coerces to safe 0', () => {
    expect(safeCrashCount(undefined)).toBe(0);
    expect(Number.isFinite(safeCrashCount(undefined))).toBe(true);
  });

  it('empty string coerces to safe 0', () => {
    expect(safeCrashCount('')).toBe(0);
  });

  it('literal "NaN" token coerces to safe 0 (kills self-propagation)', () => {
    // The bug self-propagates by writing back `${today}:NaN`; on next read
    // parseInt("NaN") is NaN again. The guard breaks the cycle.
    expect(safeCrashCount('NaN')).toBe(0);
  });

  it('negative token coerces to safe 0', () => {
    expect(safeCrashCount('-5')).toBe(0);
  });

  it('same-day increment still accumulates for valid counts (interplay preserved)', () => {
    // Hook crash path is `safeCrashCount(count) + 1` when date === today.
    expect(safeCrashCount('3') + 1).toBe(4);
  });

  it('same-day increment of a garbage count is cap-safe first crash, not NaN', () => {
    // Garbage → 0 → 0 + 1 = 1, so the cap comparison stays meaningful and
    // counting resumes from a real number instead of writing back `:NaN`.
    expect(safeCrashCount('abc') + 1).toBe(1);
    expect(safeCrashCount(undefined) + 1).toBe(1);
  });
});


describe('readMaxCrashesPerDay', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'crashalert-'));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('returns null when agentDir is undefined', () => {
    expect(readMaxCrashesPerDay(undefined)).toBeNull();
  });

  it('returns null when config.json is missing', () => {
    expect(readMaxCrashesPerDay(tmp)).toBeNull();
  });

  it('returns null when config.json is malformed', () => {
    writeFileSync(join(tmp, 'config.json'), '{ not valid json', 'utf-8');
    expect(readMaxCrashesPerDay(tmp)).toBeNull();
  });

  it('returns null when max_crashes_per_day is missing', () => {
    writeFileSync(join(tmp, 'config.json'), JSON.stringify({ agent_name: 'x' }), 'utf-8');
    expect(readMaxCrashesPerDay(tmp)).toBeNull();
  });

  it('returns the configured number when present', () => {
    writeFileSync(join(tmp, 'config.json'), JSON.stringify({ max_crashes_per_day: 10 }), 'utf-8');
    expect(readMaxCrashesPerDay(tmp)).toBe(10);
  });

  it('returns null when max_crashes_per_day is not a number', () => {
    writeFileSync(join(tmp, 'config.json'), JSON.stringify({ max_crashes_per_day: 'ten' }), 'utf-8');
    expect(readMaxCrashesPerDay(tmp)).toBeNull();
  });
});

describe('notifyAgents', () => {
  const originalFrameworkRoot = process.env.CTX_FRAMEWORK_ROOT;

  beforeEach(() => {
    execFileMock.mockReset();
    delete process.env.CTX_FRAMEWORK_ROOT;
  });

  afterEach(() => {
    if (originalFrameworkRoot === undefined) delete process.env.CTX_FRAMEWORK_ROOT;
    else process.env.CTX_FRAMEWORK_ROOT = originalFrameworkRoot;
  });

  it('sends one bus send-message per recipient', () => {
    notifyAgents({
      agentName: 'dev',
      endType: 'crash',
      reason: 'uncaught exception',
      lastTask: 'building hooks',
      crashCount: 2,
      restartAttempted: true,
      recipients: ['chief', 'analyst'],
    });
    expect(execFileMock).toHaveBeenCalledTimes(2);
  });

  it('uses cortextos bus send-message with priority high', () => {
    notifyAgents({
      agentName: 'dev',
      endType: 'crash',
      reason: 'r',
      lastTask: 't',
      crashCount: 1,
      restartAttempted: true,
      recipients: ['chief'],
    });
    const [cmd, args] = execFileMock.mock.calls[0];
    expect(cmd).toBe('cortextos');
    expect(args.slice(0, 4)).toEqual(['bus', 'send-message', 'chief', 'high']);
  });

  it('uses the framework CLI through the current Node executable when CTX_FRAMEWORK_ROOT is set', () => {
    process.env.CTX_FRAMEWORK_ROOT = '/opt/cortextos';
    notifyAgents({
      agentName: 'dev',
      endType: 'crash',
      reason: 'r',
      lastTask: 't',
      crashCount: 1,
      restartAttempted: true,
      recipients: ['chief'],
    });

    const [cmd, args] = execFileMock.mock.calls[0];
    expect(cmd).toBe(process.execPath);
    expect(args.slice(0, 5)).toEqual([
      join('/opt/cortextos', 'dist', 'cli.js'),
      'bus',
      'send-message',
      'chief',
      'high',
    ]);
  });

  it('body includes all required fields', () => {
    notifyAgents({
      agentName: 'dev',
      endType: 'daemon-crashed',
      reason: 'PTY null write',
      lastTask: 'idle',
      crashCount: 3,
      restartAttempted: false,
      recipients: ['analyst'],
    });
    const body: string = execFileMock.mock.calls[0][1][4];
    expect(body).toContain('agent=dev');
    expect(body).toContain('type=daemon-crashed');
    expect(body).toContain('reason: PTY null write');
    expect(body).toContain('last status: idle');
    expect(body).toContain('crashes today: 3');
    expect(body).toContain('restart attempted: no');
  });

  it('marks restart attempted yes when crashCount under limit', () => {
    notifyAgents({
      agentName: 'dev',
      endType: 'crash',
      reason: '',
      lastTask: '',
      crashCount: 1,
      restartAttempted: true,
      recipients: ['chief'],
    });
    expect(execFileMock.mock.calls[0][1][4]).toContain('restart attempted: yes');
  });

  it('uses fallback strings when reason and lastTask are empty', () => {
    notifyAgents({
      agentName: 'dev',
      endType: 'crash',
      reason: '',
      lastTask: '',
      crashCount: 1,
      restartAttempted: true,
      recipients: ['chief'],
    });
    const body: string = execFileMock.mock.calls[0][1][4];
    expect(body).toContain('reason: none');
    expect(body).toContain('last status: unknown');
  });

  it('does not throw when execFile throws synchronously', () => {
    execFileMock.mockImplementationOnce(() => { throw new Error('exec failed'); });
    expect(() => notifyAgents({
      agentName: 'dev',
      endType: 'crash',
      reason: '',
      lastTask: '',
      crashCount: 1,
      restartAttempted: true,
      recipients: ['chief', 'analyst'],
    })).not.toThrow();
    // Second recipient still attempted
    expect(execFileMock).toHaveBeenCalledTimes(2);
  });
});

describe('classifyFromMarkers', () => {
  let tmp: string;
  const MARKERS = [
    { file: '.restart-planned', type: 'planned-restart' },
    { file: '.session-refresh', type: 'session-refresh' },
    { file: '.user-restart', type: 'user-restart' },
    { file: '.user-stop', type: 'user-stop' },
  ];

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'crashalert-markers-'));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('no marker present → endType crash', () => {
    expect(classifyFromMarkers(tmp, MARKERS).endType).toBe('crash');
  });

  it('fresh marker → classified by type, with its reason', () => {
    writeFileSync(join(tmp, '.restart-planned'), 'planned reboot', 'utf-8');
    const r = classifyFromMarkers(tmp, MARKERS);
    expect(r.endType).toBe('planned-restart');
    expect(r.reason).toBe('planned reboot');
  });

  it('does NOT consume the marker — both firings of a restart see it', () => {
    writeFileSync(join(tmp, '.session-refresh'), 'rollover', 'utf-8');
    // Firing #1 — the dying PTY's SessionEnd.
    expect(classifyFromMarkers(tmp, MARKERS).endType).toBe('session-refresh');
    // Firing #2 — the next PTY's fresh-launch cleanup. Marker must still be
    // there: this is the FP that the old unlink-on-read code produced.
    expect(classifyFromMarkers(tmp, MARKERS).endType).toBe('session-refresh');
    expect(existsSync(join(tmp, '.session-refresh'))).toBe(true);
  });

  it('two firings with a .restart-planned marker classify as restart BOTH times (no false crash on #2)', () => {
    writeFileSync(join(tmp, '.restart-planned'), 'planned reboot', 'utf-8');
    expect(classifyFromMarkers(tmp, MARKERS).endType).toBe('planned-restart'); // firing #1
    expect(classifyFromMarkers(tmp, MARKERS).endType).toBe('planned-restart'); // firing #2
    expect(existsSync(join(tmp, '.restart-planned'))).toBe(true);
  });

  it('marker older than the TTL → treated as stale: ignored AND lazy-unlinked', () => {
    const markerPath = join(tmp, '.restart-planned');
    writeFileSync(markerPath, 'stale planned restart', 'utf-8');
    // Simulate a marker whose first-heartbeat clear never fired (failed
    // start): classify with a "now" well past the 5-minute TTL.
    const farFuture = Date.now() + 10 * 60 * 1000;
    const r = classifyFromMarkers(tmp, MARKERS, farFuture);
    expect(r.endType).toBe('crash'); // stale marker must NOT mask a real crash
    expect(existsSync(markerPath)).toBe(false); // lazy-unlinked
  });

  it('first matching marker wins (precedence order preserved)', () => {
    writeFileSync(join(tmp, '.restart-planned'), 'planned', 'utf-8');
    writeFileSync(join(tmp, '.user-stop'), 'stopped', 'utf-8');
    expect(classifyFromMarkers(tmp, MARKERS).endType).toBe('planned-restart');
  });
});

describe('readCrashCountToday (read-only — daemon owns the counter)', () => {
  let tmp: string;
  const today = new Date().toISOString().split('T')[0];

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'crashalert-count-'));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("reads today's count", () => {
    const f = join(tmp, '.crash_count_today');
    writeFileSync(f, `${today}:3`, 'utf-8');
    expect(readCrashCountToday(f, today)).toBe(3);
  });

  it('returns 0 for a stale (different-day) count', () => {
    const f = join(tmp, '.crash_count_today');
    writeFileSync(f, '2020-01-01:9', 'utf-8');
    expect(readCrashCountToday(f, today)).toBe(0);
  });

  it('returns 0 when the file is missing', () => {
    expect(readCrashCountToday(join(tmp, '.crash_count_today'), today)).toBe(0);
  });

  it('coerces a torn/garbage count to a safe 0', () => {
    const f = join(tmp, '.crash_count_today');
    writeFileSync(f, `${today}:NaN`, 'utf-8');
    expect(readCrashCountToday(f, today)).toBe(0);
  });

  it('NEVER writes — does not create a missing file (Item-1 no-op proof)', () => {
    const f = join(tmp, '.crash_count_today');
    readCrashCountToday(f, today);
    expect(existsSync(f)).toBe(false);
  });

  it('NEVER mutates — leaves an existing count byte-for-byte unchanged', () => {
    const f = join(tmp, '.crash_count_today');
    writeFileSync(f, `${today}:2`, 'utf-8');
    readCrashCountToday(f, today);
    readCrashCountToday(f, today); // repeated reads must not increment
    expect(readFileSync(f, 'utf-8')).toBe(`${today}:2`);
  });
});

describe('clearEndMarkers (via heartbeat)', () => {
  let tmp: string;
  const ALL = ['.restart-planned', '.session-refresh', '.user-restart', '.user-stop', '.daemon-stop'];

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'crashalert-clear-'));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('a post-grace heartbeat removes every pending end-type marker', () => {
    for (const f of ALL) writeFileSync(join(tmp, f), 'x', 'utf-8');
    // nowMs well past the grace window — the markers are no longer in-flight.
    clearEndMarkers(tmp, Date.now() + 10 * 60 * 1000);
    for (const f of ALL) expect(existsSync(join(tmp, f))).toBe(false);
  });

  it('leaves a fresh (within-grace) marker in place — an in-flight restart', () => {
    for (const f of ALL) writeFileSync(join(tmp, f), 'x', 'utf-8');
    // nowMs ≈ marker mtime → every marker is within the grace window.
    clearEndMarkers(tmp);
    for (const f of ALL) expect(existsSync(join(tmp, f))).toBe(true);
  });

  it('is a no-op when no markers are present', () => {
    expect(() => clearEndMarkers(tmp)).not.toThrow();
  });
});

describe('marker lifecycle (classify → clearEndMarkers → classify)', () => {
  let tmp: string;
  const MARKERS = [
    { file: '.restart-planned', type: 'planned-restart' },
    { file: '.session-refresh', type: 'session-refresh' },
    { file: '.user-restart', type: 'user-restart' },
    { file: '.user-stop', type: 'user-stop' },
  ];

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'crashalert-lifecycle-'));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('both restart firings classify, a post-grace heartbeat clears, then a real crash classifies as crash', () => {
    writeFileSync(join(tmp, '.restart-planned'), 'planned reboot', 'utf-8');
    // Firing #1 and #2 of the dying restart — both must see the marker.
    expect(classifyFromMarkers(tmp, MARKERS).endType).toBe('planned-restart');
    expect(classifyFromMarkers(tmp, MARKERS).endType).toBe('planned-restart');
    // Post-restart session heartbeats past the grace window → marker cleared.
    clearEndMarkers(tmp, Date.now() + 10 * 60 * 1000);
    expect(existsSync(join(tmp, '.restart-planned'))).toBe(false);
    // A genuine crash AFTER the clear must classify as crash — not be masked.
    expect(classifyFromMarkers(tmp, MARKERS).endType).toBe('crash');
  });

  it('a heartbeat DURING the in-flight restart (within grace) does NOT wipe the marker — firing#2 still classifies', () => {
    // This is the Finding-1 race: a fast-booting successor heartbeats before
    // the dying restart's second SessionEnd firing lands.
    writeFileSync(join(tmp, '.session-refresh'), 'rollover', 'utf-8');
    expect(classifyFromMarkers(tmp, MARKERS).endType).toBe('session-refresh'); // firing #1
    clearEndMarkers(tmp); // successor's first heartbeat — marker still within grace
    expect(existsSync(join(tmp, '.session-refresh'))).toBe(true);
    expect(classifyFromMarkers(tmp, MARKERS).endType).toBe('session-refresh'); // firing #2 — no false crash
  });
});
