import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

vi.mock('child_process', () => ({ execFileSync: vi.fn() }));
import { execFileSync } from 'child_process';
import {
  runGit,
  isSubprocessTimeout,
  GIT_READ_TIMEOUT_MS,
  GIT_MUTATE_TIMEOUT_MS,
  GIT_NETWORK_TIMEOUT_MS,
} from '../../../src/daemon/watchdog.js';

describe('watchdog subprocess timeouts', () => {
  let errSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.mocked(execFileSync).mockReset();
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => errSpy.mockRestore());

  // STRUCTURAL — this is the test that fails RED on the pre-fix file.
  // Before the fix, watchdog.ts contained 11 bare execFileSync('git', ...) calls
  // with no timeout. A watchdog that hangs stops watching WITHOUT reporting it,
  // so "every git spawn is bounded" is the property, not "some are".
  it('TC-W1: no bare execFileSync git call escapes runGit', () => {
    const src = readFileSync(
      join(__dirname, '../../../src/daemon/watchdog.ts'),
      'utf-8',
    );
    // Match ANY execFileSync call form, not just execFileSync('git', ...).
    // Two of the original 11 used a multiline `execFileSync(\n  'git',` shape, so a
    // pattern keyed on the single-line form would silently permit a new unbounded
    // call in that style - the test would pass while the property it exists to
    // enforce was false.
    const all = src.match(/execFileSync\s*\(/g) ?? [];
    // Exactly one permitted: the single call inside runGit itself.
    expect(all.length).toBe(1);
    // And it must sit inside runGit, not somewhere else.
    const runGitBody = src.slice(src.indexOf('export function runGit'));
    expect(runGitBody).toContain("execFileSync('git'");
  });

  it('TC-W2: runGit passes the timeout through to the child process', () => {
    vi.mocked(execFileSync).mockReturnValue('abc123\n' as never);
    runGit(['rev-parse', 'HEAD'], { cwd: '/repo', timeoutMs: 15000, capture: true });
    const opts = vi.mocked(execFileSync).mock.calls[0][2] as Record<string, unknown>;
    expect(opts.timeout).toBe(15000);
    expect(opts.cwd).toBe('/repo');
    // A timeout is only ENFORCEABLE with a signal the child cannot ignore. Default
    // SIGTERM can be trapped by a wedged git or credential helper, which would bound
    // the happy case and not the wedge case this fix exists for.
    expect(opts.killSignal).toBe('SIGKILL');
    // And a daemon must never block on a credential prompt no human will answer.
    expect((opts.env as Record<string, string>).GIT_TERMINAL_PROMPT).toBe('0');
  });

  it('TC-W3: a timeout is logged LOUDLY and rethrown, not swallowed', () => {
    const err = Object.assign(new Error('spawn timed out'), { code: 'ETIMEDOUT' });
    vi.mocked(execFileSync).mockImplementation(() => { throw err; });

    expect(() =>
      runGit(['fetch', 'origin', 'main'], { cwd: '/repo', timeoutMs: 60000 }),
    ).toThrow();

    expect(errSpy).toHaveBeenCalledTimes(1);
    const msg = String(errSpy.mock.calls[0][0]);
    expect(msg).toContain('TIMEOUT');
    expect(msg).toContain('60000ms');
    // Names the consequence, and explicitly denies the two readings a bare
    // `catch { return null }` would otherwise leave available.
    expect(msg).toContain('DEGRADED');
    expect(msg).toContain('NOT a missing repository');
  });

  it('TC-W4: a NON-timeout failure does not emit the timeout log', () => {
    const err = Object.assign(new Error('not a git repository'), { status: 128 });
    vi.mocked(execFileSync).mockImplementation(() => { throw err; });

    expect(() => runGit(['rev-parse', 'HEAD'], { cwd: '/x', timeoutMs: 5000 })).toThrow();
    // If this fired on every error the log would be noise and stop being a signal.
    expect(errSpy).not.toHaveBeenCalled();
  });

  it('TC-W5: isSubprocessTimeout keys on ETIMEDOUT only', () => {
    expect(isSubprocessTimeout({ code: 'ETIMEDOUT' })).toBe(true);
    expect(isSubprocessTimeout({ status: 128 })).toBe(false);
    expect(isSubprocessTimeout(null)).toBe(false);
    expect(isSubprocessTimeout(undefined)).toBe(false);
  });

  // A child signalled for an UNRELATED reason must not be reported as a timeout.
  // Keying on signal === 'SIGTERM' would make the loud log fire on ordinary
  // termination, and a loud log that lies is worse than the silence it replaced.
  it('TC-W7: a non-timeout SIGTERM is NOT classified or logged as a timeout', () => {
    expect(isSubprocessTimeout({ signal: 'SIGTERM' })).toBe(false);

    const err = Object.assign(new Error('killed'), { signal: 'SIGTERM' });
    vi.mocked(execFileSync).mockImplementation(() => { throw err; });
    expect(() => runGit(['status'], { cwd: '/r', timeoutMs: 15000 })).toThrow();
    expect(errSpy).not.toHaveBeenCalled();
  });

  it('TC-W6: tiers are ordered read < mutate < network and all finite', () => {
    for (const t of [GIT_READ_TIMEOUT_MS, GIT_MUTATE_TIMEOUT_MS, GIT_NETWORK_TIMEOUT_MS]) {
      expect(Number.isFinite(t)).toBe(true);
      expect(t).toBeGreaterThan(0);
    }
    expect(GIT_READ_TIMEOUT_MS).toBe(15_000);
    expect(GIT_MUTATE_TIMEOUT_MS).toBe(30_000);
    expect(GIT_NETWORK_TIMEOUT_MS).toBe(60_000);
    expect(GIT_READ_TIMEOUT_MS).toBeLessThan(GIT_MUTATE_TIMEOUT_MS);
    expect(GIT_MUTATE_TIMEOUT_MS).toBeLessThan(GIT_NETWORK_TIMEOUT_MS);
  });
});
