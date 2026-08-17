import { describe, it, expect, vi, beforeEach } from 'vitest';

// Capture the PTY exit handler so tests can simulate exits at controlled times
let capturedOnExit: ((exitCode: number, signal?: number) => void) | null = null;

const mockPty = {
  spawn: vi.fn().mockResolvedValue(undefined),
  kill: vi.fn(),
  write: vi.fn(),
  // Use the test runner's own pid as a stand-in for the agent's PTY pid so
  // the daemon's OS-liveness probe in getStatus() (process.kill(pid, 0))
  // succeeds — that probe was added to catch silent-PTY-death state cache
  // divergence. The probe is also gated on this.pty existing, so the
  // shutdown-handler tests that null out this.pty are unaffected.
  getPid: vi.fn().mockReturnValue(process.pid),
  isAlive: vi.fn().mockReturnValue(true),
  // Default: no rate-limit signature in output (safe for all existing tests)
  getOutputBuffer: vi.fn().mockReturnValue({ hasRateLimitSignature: () => false }),
  onExit: vi.fn().mockImplementation((cb: (exitCode: number, signal?: number) => void) => {
    capturedOnExit = cb;
  }),
};

vi.mock('../../../src/pty/agent-pty.js', () => ({
  AgentPTY: function AgentPTY() { return mockPty; },
}));

const mockInjectMessage = vi.fn();
vi.mock('../../../src/pty/inject.js', () => ({
  injectMessage: mockInjectMessage,
  MessageDedup: class { isDuplicate() { return false; } },
}));

vi.mock('../../../src/utils/atomic.js', () => ({
  ensureDir: vi.fn(),
  atomicWriteSync: vi.fn(),
}));

vi.mock('../../../src/utils/env.js', () => ({
  writeCortextosEnv: vi.fn(),
  resolveEnv: vi.fn().mockReturnValue({ instanceId: 'test', ctxRoot: '/tmp/test' }),
}));

vi.mock('../../../src/bus/reminders.js', () => ({
  getOverdueReminders: vi.fn().mockReturnValue([]),
}));

vi.mock('../../../src/utils/paths.js', () => ({
  resolvePaths: vi.fn().mockReturnValue({ stateDir: '/tmp/test-ctx/state/alice' }),
}));

const fsMocks = {
  existsSync: vi.fn().mockReturnValue(false),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  appendFileSync: vi.fn(),
  statSync: vi.fn(),
  unlinkSync: vi.fn(),
};

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  // Getter-based exposure of the fsMocks vi.fn()s. Two consumer patterns
  // need to coexist on this file:
  //   (1) `fsMocks.X.mockReset()` — used by the BUG-040 / restarts.log
  //       tests added by this patch
  //   (2) `vi.mocked(fs.X).mockImplementation(...)` — used by the
  //       verifyCronsAfterIdle tests + BUG-048 reschedule tests
  // For (2) to work, `fs.X` MUST resolve to the same vi.fn() instance as
  // `fsMocks.X`. Naive direct reference (`existsSync: fsMocks.existsSync`)
  // breaks because vi.mock factories are hoisted + executed BEFORE the
  // `const fsMocks = {...}` initializer — so the lookup captures
  // `undefined`. Arrow wrappers (`(...args) => fsMocks.X(...args)`) keep
  // (1) working but break (2) because `fs.X` is no longer a vi.fn — it's
  // a plain arrow function, and `vi.mocked()` does not recognize it as
  // mockable. Getters thread the needle: the lookup is deferred until
  // call time (after fsMocks is initialized), and the value returned IS
  // the underlying vi.fn so `vi.mocked()` recognizes it.
  return {
    ...actual,
    mkdirSync: vi.fn(),
    get existsSync() { return fsMocks.existsSync; },
    get readFileSync() { return fsMocks.readFileSync; },
    get writeFileSync() { return fsMocks.writeFileSync; },
    get appendFileSync() { return fsMocks.appendFileSync; },
    get statSync() { return fsMocks.statSync; },
    get unlinkSync() { return fsMocks.unlinkSync; },
  };
});

const { AgentProcess } = await import('../../../src/daemon/agent-process.js');

const mockEnv = {
  instanceId: 'test',
  ctxRoot: '/tmp/test-ctx',
  frameworkRoot: '/tmp/fw',
  agentName: 'alice',
  agentDir: '/tmp/fw/orgs/acme/agents/alice',
  org: 'acme',
  projectRoot: '/tmp/fw',
};

beforeEach(() => {
  capturedOnExit = null;
  mockPty.spawn.mockClear();
  mockPty.kill.mockClear();
  mockPty.write.mockClear();
  mockPty.isAlive.mockClear();
  mockPty.isAlive.mockReturnValue(true);
  mockPty.getOutputBuffer.mockClear();
  mockPty.getOutputBuffer.mockReturnValue({ hasRateLimitSignature: () => false });
  mockPty.onExit.mockClear();
  mockInjectMessage.mockClear();
  fsMocks.existsSync.mockReset().mockReturnValue(false);
  fsMocks.readFileSync.mockReset();
  fsMocks.writeFileSync.mockReset();
  fsMocks.appendFileSync.mockReset();
  fsMocks.statSync.mockReset();
  fsMocks.unlinkSync.mockReset();
});

describe('AgentProcess disable-resurrection gate (#859)', () => {
  it('does not crash-recover when .user-disable is present', async () => {
    fsMocks.existsSync.mockImplementation((p: unknown) => String(p).endsWith('/state/alice/.user-disable'));
    const ap = new AgentProcess('alice', mockEnv, {});
    await ap.start();
    capturedOnExit!(1, 0);
    expect(ap.getStatus().status).toBe('stopped');
    expect(fsMocks.appendFileSync).not.toHaveBeenCalled();
  });

  it('clears a lingering .user-disable marker on explicit start', async () => {
    const marker = '/tmp/test-ctx/state/alice/.user-disable';
    fsMocks.existsSync.mockImplementation((p: unknown) => String(p) === marker);
    const ap = new AgentProcess('alice', mockEnv, {});
    await ap.start();
    expect(fsMocks.unlinkSync).toHaveBeenCalledWith(marker);
  });
});

describe('AgentProcess - daemon injection timestamp', () => {
  it('updates only after a successful PTY injection', async () => {
    const ap = new AgentProcess('alice', mockEnv, {});
    expect(ap.getLastInjectedAt()).toBe(0);
    expect(ap.injectMessageDetailed('before start').ok).toBe(false);
    expect(ap.getLastInjectedAt()).toBe(0);

    await ap.start();
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-07-16T18:00:00.000Z'));
      expect(ap.injectMessageDetailed('open the turn')).toEqual({ ok: true });
      expect(ap.getLastInjectedAt()).toBe(Date.now());
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('AgentProcess - BUG-011 fix (stop awaits PTY exit)', () => {
  it('stop() awaits the PTY exit handler before resolving', async () => {
    const ap = new AgentProcess('alice', mockEnv, {});
    await ap.start();
    expect(capturedOnExit).not.toBeNull();
    expect(ap.getStatus().status).toBe('running');

    let stopResolved = false;
    const stopPromise = ap.stop().then(() => { stopResolved = true; });

    // Give stop() a moment to enter its kill phase. The 4s of internal sleeps
    // (1s after Ctrl-C + 3s after /exit) plus the awaitExit will keep stop()
    // in flight. After 100ms, it should NOT have resolved.
    await new Promise(r => setTimeout(r, 100));
    expect(stopResolved).toBe(false);

    // Now simulate the PTY exit firing
    capturedOnExit!(0, 0);

    // After the exit fires, stop() should be able to resolve
    // (after its internal sleeps finish — wait long enough)
    await stopPromise;
    expect(stopResolved).toBe(true);
    expect(ap.getStatus().status).toBe('stopped');
  }, 10000);

  it('stop() does NOT trigger crash recovery on intentional stop (the BUG-011 regression)', async () => {
    const ap = new AgentProcess('alice', mockEnv, {});
    await ap.start();

    // Stop and have the exit fire DURING the await window
    const stopPromise = ap.stop();
    await new Promise(r => setTimeout(r, 100));
    capturedOnExit!(0, 0);
    await stopPromise;

    // The agent should be 'stopped', NOT 'crashed'.
    // Before the fix, the exit handler could fire after stopping=false and
    // call into the crash recovery branch, leaving status='crashed'.
    expect(ap.getStatus().status).toBe('stopped');
  }, 10000);

  it('handleExit DOES trigger crash recovery on UNINTENTIONAL exit (regression check)', async () => {
    // Make sure we didn't accidentally break the real crash recovery path
    const ap = new AgentProcess('alice', mockEnv, {});
    await ap.start();
    expect(ap.getStatus().status).toBe('running');

    // Fire the exit handler WITHOUT calling stop() first — simulates a real crash
    capturedOnExit!(1, 0);

    // The agent should be in 'crashed' state (crash recovery scheduled)
    expect(ap.getStatus().status).toBe('crashed');
  });

  it('unexpected PTY exit persists a CRASH line to restarts.log', async () => {
    // Default fs mocks: no .daemon-stop marker, no .crash_count_today file.
    const ap = new AgentProcess('alice', mockEnv, {});
    await ap.start();
    expect(ap.getStatus().status).toBe('running');

    // Fire exit handler WITHOUT calling stop() first — simulates a real crash.
    capturedOnExit!(1, 0);

    expect(ap.getStatus().status).toBe('crashed');
    // restarts.log must have received a CRASH entry with the exit code and
    // crash counter. Before the fix, daemon-classified crashes only wrote
    // to stdout and left restarts.log empty.
    expect(fsMocks.appendFileSync).toHaveBeenCalledTimes(1);
    const [logPath, logLine] = fsMocks.appendFileSync.mock.calls[0];
    expect(String(logPath)).toContain('/logs/alice/restarts.log');
    expect(String(logLine)).toMatch(/\] CRASH: exit_code=1 crash_count=1 backoff_s=5\b/);
    expect(String(logLine).endsWith('\n')).toBe(true);
  });

  it('PTY exit during daemon shutdown is NOT classified as a crash', async () => {
    // Simulate agent-manager.ts:stopAll() having written a fresh .daemon-stop
    // marker moments ago. handleExit should recognize the shutdown-in-progress
    // signal and bail out before touching the crash counter or restarts.log.
    fsMocks.existsSync.mockImplementation((p: any) => {
      const path = String(p);
      return path.endsWith('/state/alice/.daemon-stop');
    });
    fsMocks.statSync.mockImplementation((p: any) => ({ mtimeMs: Date.now() - 2_000 }));

    const ap = new AgentProcess('alice', mockEnv, {});
    await ap.start();
    expect(ap.getStatus().status).toBe('running');

    // PM2 SIGTERM propagated to the PTY's Claude Code child: it exits
    // cleanly with code 0 before its own stopAgent() call has a chance to
    // set stopRequested. Before the fix, this produced a phantom crash
    // and incremented .crash_count_today.
    capturedOnExit!(0, 0);

    // Agent state is 'running' still — handleExit returned early without
    // toggling status. No crash write, no log append, no restart scheduled.
    expect(ap.getStatus().status).toBe('running');
    expect(fsMocks.appendFileSync).not.toHaveBeenCalled();
    expect(fsMocks.writeFileSync).not.toHaveBeenCalledWith(
      expect.stringContaining('.crash_count_today'),
      expect.anything(),
      expect.anything(),
    );
  });

  it('stale .daemon-stop marker (>60s old) does NOT mask a real crash', async () => {
    // Regression guard: if a prior shutdown failed to clean up its marker,
    // we do NOT want it to silently swallow genuine crashes hours later.
    // The 60s window in isDaemonShuttingDown() is the load-bearing check.
    fsMocks.existsSync.mockImplementation((p: any) =>
      String(p).endsWith('/state/alice/.daemon-stop'),
    );
    fsMocks.statSync.mockImplementation((p: any) => ({ mtimeMs: Date.now() - 3_600_000 })); // 1h old

    const ap = new AgentProcess('alice', mockEnv, {});
    await ap.start();
    capturedOnExit!(1, 0);

    expect(ap.getStatus().status).toBe('crashed');
    expect(fsMocks.appendFileSync).toHaveBeenCalledTimes(1);
    expect(String(fsMocks.appendFileSync.mock.calls[0][1])).toMatch(/\] CRASH: /);
  });

  it('sessionRefresh() delegates to stop() then start() (in order)', async () => {
    const ap = new AgentProcess('alice', mockEnv, {});
    await ap.start();

    // Spy on stop and start so we can verify the delegation
    const stopSpy = vi.spyOn(ap, 'stop').mockResolvedValue();
    const startSpy = vi.spyOn(ap, 'start').mockResolvedValue();

    await ap.sessionRefresh();

    expect(stopSpy).toHaveBeenCalled();
    expect(startSpy).toHaveBeenCalled();
    // Verify call order: stop must complete before start
    const stopOrder = stopSpy.mock.invocationCallOrder[0];
    const startOrder = startSpy.mock.invocationCallOrder[0];
    expect(stopOrder).toBeLessThan(startOrder);
  });

  it('sessionRefresh() writes .session-refresh marker before stop (false-crash FP fix)', async () => {
    const ap = new AgentProcess('alice', mockEnv, {});
    await ap.start();

    const stopSpy = vi.spyOn(ap, 'stop').mockResolvedValue();
    vi.spyOn(ap, 'start').mockResolvedValue();
    fsMocks.writeFileSync.mockReset();

    await ap.sessionRefresh();

    const writeIdx = fsMocks.writeFileSync.mock.calls.findIndex(
      (call) => String(call[0]).endsWith('.session-refresh'),
    );
    expect(writeIdx).toBeGreaterThanOrEqual(0);
    expect(String(fsMocks.writeFileSync.mock.calls[writeIdx][0])).toBe('/tmp/test-ctx/state/alice/.session-refresh');
    // The marker must be written BEFORE stop() — a SessionEnd hook firing as
    // the PTY dies must already see the marker, or it classifies a false crash.
    const markerWriteOrder = fsMocks.writeFileSync.mock.invocationCallOrder[writeIdx];
    expect(markerWriteOrder).toBeLessThan(stopSpy.mock.invocationCallOrder[0]);
  });

  it('sessionRefresh() retries a failed start and records the failure in restarts.log', async () => {
    const ap = new AgentProcess('alice', mockEnv, {});
    await ap.start();

    vi.spyOn(ap, 'stop').mockResolvedValue();
    const startSpy = vi.spyOn(ap, 'start')
      .mockRejectedValueOnce(new Error('spawn failed'))
      .mockResolvedValueOnce();
    fsMocks.appendFileSync.mockReset();

    vi.useFakeTimers();
    try {
      const refresh = ap.sessionRefresh();
      await vi.advanceTimersByTimeAsync(1_000);
      await refresh;
    } finally {
      vi.useRealTimers();
    }

    expect(startSpy).toHaveBeenCalledTimes(2);
    const retryLog = fsMocks.appendFileSync.mock.calls.find(
      ([path]) => String(path).endsWith('/logs/alice/restarts.log'),
    );
    expect(retryLog).toBeDefined();
    expect(String(retryLog?.[1])).toMatch(/SESSION_REFRESH_RETRY: attempt=1 backoff_s=1 error="spawn failed"/);
  });

  it('concurrent stop() callers await the same shutdown instead of returning early', async () => {
    const ap = new AgentProcess('alice', mockEnv, {});
    await ap.start();

    let firstResolved = false;
    let secondResolved = false;
    const first = ap.stop().then(() => { firstResolved = true; });
    const second = ap.stop().then(() => { secondResolved = true; });

    await Promise.resolve();
    expect(firstResolved).toBe(false);
    expect(secondResolved).toBe(false);

    capturedOnExit!(0, 0);
    await Promise.all([first, second]);
    expect(firstResolved).toBe(true);
    expect(secondResolved).toBe(true);
    expect(mockPty.kill).toHaveBeenCalledTimes(1);
  }, 10_000);

  it('concurrent start() callers share one PTY spawn', async () => {
    let releaseSpawn!: () => void;
    mockPty.spawn.mockImplementationOnce(() => new Promise<void>((resolve) => {
      releaseSpawn = resolve;
    }));

    const ap = new AgentProcess('alice', mockEnv, {});
    const first = ap.start();
    const second = ap.start();

    await Promise.resolve();
    expect(mockPty.spawn).toHaveBeenCalledTimes(1);

    releaseSpawn();
    await Promise.all([first, second]);
    expect(ap.getStatus().status).toBe('running');
  });

  it('keeps a delayed start visible as one in-flight lifecycle to concurrent callers', async () => {
    vi.useFakeTimers();
    try {
      const ap = new AgentProcess('alice', mockEnv, { startup_delay: 5 });
      const first = ap.start();

      // This is the AgentManager liveness boundary: a mapped delayed start
      // must never look stopped and enter stale-entry eviction.
      expect(ap.getStatus().status).toBe('starting');

      const second = ap.start();
      expect(ap.getStatus().status).toBe('starting');
      expect(mockPty.spawn).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(5_000);
      await Promise.all([first, second]);

      expect(mockPty.spawn).toHaveBeenCalledTimes(1);
      expect(ap.getStatus().status).toBe('running');
    } finally {
      vi.useRealTimers();
    }
  });

  it('sessionRefresh() escalates exhausted retries to a fresh hard restart', async () => {
    const ap = new AgentProcess('alice', mockEnv, {});
    await ap.start();

    vi.spyOn(ap, 'stop').mockResolvedValue();
    vi.spyOn(ap, 'start').mockRejectedValue(new Error('persistent spawn failure'));
    const hardRestartSpy = vi.spyOn(ap, 'hardRestartSelf').mockResolvedValue();
    fsMocks.appendFileSync.mockReset();

    vi.useFakeTimers();
    try {
      const refresh = ap.sessionRefresh();
      await vi.advanceTimersByTimeAsync(6_000);
      await refresh;
    } finally {
      vi.useRealTimers();
    }

    expect(hardRestartSpy).toHaveBeenCalledOnce();
    expect(hardRestartSpy).toHaveBeenCalledWith(expect.stringContaining('session refresh failed after 3 attempts'));
    const lines = fsMocks.appendFileSync.mock.calls.map(([, line]) => String(line));
    expect(lines.filter((line) => line.includes('SESSION_REFRESH_RETRY'))).toHaveLength(3);
    expect(lines.some((line) => line.includes('SESSION_REFRESH_ESCALATION'))).toBe(true);
  });
});

describe('AgentProcess - crashCount NaN-guard (bug-hunt #8)', () => {
  // Helper: point existsSync + readFileSync at a .crash_count_today file with
  // the given raw contents, leave the .daemon-stop marker absent so the exit
  // is classified as a real crash.
  const seedCrashFile = (raw: string) => {
    fsMocks.existsSync.mockImplementation((p: any) =>
      String(p).endsWith('/state/alice/.crash_count_today'),
    );
    fsMocks.readFileSync.mockImplementation((p: any) => {
      if (String(p).endsWith('/state/alice/.crash_count_today')) return raw;
      return '';
    });
  };

  const crashLogLine = (): string => {
    const call = fsMocks.appendFileSync.mock.calls.find(c =>
      String(c[0]).endsWith('/logs/alice/restarts.log'),
    );
    return call ? String(call[1]) : '';
  };

  const crashCountWrite = (): string | undefined => {
    const call = fsMocks.writeFileSync.mock.calls.find(c =>
      String(c[0]).endsWith('/state/alice/.crash_count_today'),
    );
    return call ? String(call[1]) : undefined;
  };

  it('malformed same-day count does NOT bypass the cap — cap still HALTS', async () => {
    // max_crashes_per_day=1 with a garbage stored count. With the NaN bug,
    // parseInt("abc")+1 = NaN, NaN>=1 is false, and the agent would re-enter
    // the crash path forever (cap never fires). The guard coerces the garbage
    // to 0, so this crash counts as #1 and the cap fires immediately.
    const today = new Date().toISOString().split('T')[0];
    seedCrashFile(`${today}:abc`);

    const ap = new AgentProcess('alice', mockEnv, { max_crashes_per_day: 1 });
    await ap.start();
    capturedOnExit!(1, 0);

    expect(ap.getStatus().status).toBe('halted');
    expect(crashLogLine()).toMatch(/\] HALTED: exit_code=1 crash_count=1 max_crashes=1/);
  });

  it('malformed count never yields a NaN backoff (no immediate tight restart loop)', async () => {
    // The scariest symptom: Math.pow(2, NaN-1) → setTimeout(fn, NaN) → fires
    // immediately → tight infinite restart loop. With the guard, a garbage
    // count coerces to 0, crash #1, finite 5s backoff.
    const today = new Date().toISOString().split('T')[0];
    seedCrashFile(`${today}:not-a-number`);

    const ap = new AgentProcess('alice', mockEnv, { max_crashes_per_day: 10 });
    await ap.start();
    capturedOnExit!(1, 0);

    expect(ap.getStatus().status).toBe('crashed');
    const line = crashLogLine();
    expect(line).toMatch(/\] CRASH: exit_code=1 crash_count=1 backoff_s=5\b/);
    expect(line).not.toMatch(/NaN/);
    // Persisted count is a real number, not the self-propagating `:NaN`.
    expect(crashCountWrite()).toBe(`${today}:1`);
    expect(crashCountWrite()).not.toMatch(/NaN/);
  });

  it('missing count field (no colon) coerces to a safe finite value', async () => {
    // File content like a bare date with no `:count` → split yields
    // count=undefined → parseInt(undefined) = NaN under the bug.
    const today = new Date().toISOString().split('T')[0];
    seedCrashFile(today); // no ":count"

    const ap = new AgentProcess('alice', mockEnv, { max_crashes_per_day: 10 });
    await ap.start();
    capturedOnExit!(1, 0);

    expect(ap.getStatus().status).toBe('crashed');
    expect(crashLogLine()).toMatch(/crash_count=1 backoff_s=5\b/);
    expect(crashCountWrite()).toBe(`${today}:1`);
  });

  it('same-day increments still ACCUMULATE (++/reset interplay preserved)', async () => {
    // A valid same-day count of 3 must become 4 — the guard must not change
    // the existing increment behavior, only harden the parse.
    const today = new Date().toISOString().split('T')[0];
    seedCrashFile(`${today}:3`);

    const ap = new AgentProcess('alice', mockEnv, { max_crashes_per_day: 10 });
    await ap.start();
    capturedOnExit!(1, 0);

    expect(ap.getStatus().status).toBe('crashed');
    expect(crashLogLine()).toMatch(/crash_count=4 backoff_s=40\b/);
    expect(crashCountWrite()).toBe(`${today}:4`);
  });

  it('daily reset still ZEROES on a new day (interplay preserved)', async () => {
    // A valid count from a prior date must reset to 1 today, not accumulate.
    seedCrashFile('2026-01-01:9');

    const ap = new AgentProcess('alice', mockEnv, { max_crashes_per_day: 10 });
    await ap.start();
    capturedOnExit!(1, 0);

    const today = new Date().toISOString().split('T')[0];
    expect(ap.getStatus().status).toBe('crashed');
    expect(crashLogLine()).toMatch(/crash_count=1 backoff_s=5\b/);
    expect(crashCountWrite()).toBe(`${today}:1`);
  });
});

describe('AgentProcess onboarding fallback', () => {
  it('keeps the fresh-start back-online instruction for a lone Telegram-enabled start', () => {
    const ap = new AgentProcess('alice', mockEnv, {});
    ap.setTelegramHandle({ sendChatAction: vi.fn(), sendMessage: vi.fn().mockResolvedValue(undefined) } as any, '12345');
    const prompt = (ap as any).buildStartupPrompt(null) as string;

    expect(prompt).toContain('Send a Telegram message to the user saying you are back online.');
  });

  it('omits the fresh-start back-online instruction during a fleet start batch', () => {
    const ap = new AgentProcess('alice', mockEnv, {});
    const prompt = (ap as any).buildStartupPrompt(null, { partOfFleetStart: true }) as string;

    expect(prompt).not.toContain('Send a Telegram message to the user saying you are back online.');
  });

  it('retro-writes .onboarded when bootstrap files have real content', () => {
    fsMocks.existsSync.mockImplementation((p: any) => {
      const path = String(p);
      if (path.endsWith('/state/alice/.onboarded')) return false;
      if (path.endsWith('/state/alice/heartbeat.json')) return false;
      if (path.endsWith('/orgs/acme/agents/alice/ONBOARDING.md')) return true;
      if (path.endsWith('/orgs/acme/agents/alice/IDENTITY.md')) return true;
      if (path.endsWith('/orgs/acme/agents/alice/MEMORY.md')) return true;
      return false;
    });
    fsMocks.readFileSync.mockImplementation((p: any) => {
      const path = String(p);
      if (path.endsWith('/orgs/acme/agents/alice/IDENTITY.md')) {
        return `# Agent Identity

## Name
alice

## Role
Research specialist for the team.
`;
      }
      if (path.endsWith('/orgs/acme/agents/alice/MEMORY.md')) {
        return '# Long-Term Memory\n\nThis agent has already been configured with substantial operating context and learned patterns that go well beyond the shipped template.\n';
      }
      return '';
    });

    const ap = new AgentProcess('alice', mockEnv, {});
    const prompt = (ap as any).buildStartupPrompt(null) as string;

    expect(fsMocks.writeFileSync).toHaveBeenCalledWith(
      '/tmp/test-ctx/state/alice/.onboarded',
      '',
      'utf-8',
    );
    expect(prompt).not.toContain('IMPORTANT: This is your FIRST BOOT');
  });

  it('keeps first-boot onboarding when bootstrap files still look templated', () => {
    fsMocks.existsSync.mockImplementation((p: any) => {
      const path = String(p);
      if (path.endsWith('/state/alice/.onboarded')) return false;
      if (path.endsWith('/state/alice/heartbeat.json')) return false;
      if (path.endsWith('/orgs/acme/agents/alice/ONBOARDING.md')) return true;
      if (path.endsWith('/orgs/acme/agents/alice/IDENTITY.md')) return true;
      if (path.endsWith('/orgs/acme/agents/alice/MEMORY.md')) return true;
      return false;
    });
    fsMocks.readFileSync.mockImplementation((p: any) => {
      const path = String(p);
      if (path.endsWith('/orgs/acme/agents/alice/IDENTITY.md')) {
        return `# Agent Identity

## Name
<!-- Agent name (set during onboarding) -->

## Role
<!-- What this agent does -->
`;
      }
      if (path.endsWith('/orgs/acme/agents/alice/MEMORY.md')) {
        return '# Long-Term Memory\n\n<!-- Patterns, learnings, successful approaches, and failures discovered over time. -->\n';
      }
      return '';
    });

    const ap = new AgentProcess('alice', mockEnv, {});
    const prompt = (ap as any).buildStartupPrompt(null) as string;

    expect(fsMocks.writeFileSync).not.toHaveBeenCalledWith(
      '/tmp/test-ctx/state/alice/.onboarded',
      '',
      'utf-8',
    );
    expect(prompt).toContain('IMPORTANT: This is your FIRST BOOT');
  });
});

describe('AgentProcess - BUG-048 fix (session timer re-reads config)', () => {
  it('fires sessionRefresh when config on disk still matches original short duration', async () => {
    const refreshSpy = vi.fn().mockResolvedValue(undefined);

    vi.useFakeTimers();
    try {
      const ap = new AgentProcess('alice', mockEnv, { max_session_seconds: 1 });
      vi.spyOn(ap, 'sessionRefresh').mockImplementation(refreshSpy);
      await ap.start();
      await vi.advanceTimersByTimeAsync(2000);
    } finally {
      vi.useRealTimers();
    }

    expect(refreshSpy).toHaveBeenCalledOnce();
  });

  it('reschedules when config.json on disk has a longer max_session_seconds', async () => {
    const fs = await import('fs');
    const mockExistsSync = vi.mocked(fs.existsSync);
    const mockReadFileSync = vi.mocked(fs.readFileSync);

    const refreshSpy = vi.fn().mockResolvedValue(undefined);

    // Config on disk says 1 hour — much longer than initial 1s
    mockExistsSync.mockImplementation((p: unknown) =>
      typeof p === 'string' && p.endsWith('config.json'),
    );
    mockReadFileSync.mockImplementation((p: unknown) => {
      if (typeof p === 'string' && p.endsWith('config.json')) {
        return JSON.stringify({ max_session_seconds: 3600 });
      }
      return '';
    });

    vi.useFakeTimers();
    try {
      const ap = new AgentProcess('alice', mockEnv, { max_session_seconds: 1 });
      vi.spyOn(ap, 'sessionRefresh').mockImplementation(refreshSpy);
      await ap.start();
      // Advance past the initial 1s timer — should reschedule, not fire refresh
      await vi.advanceTimersByTimeAsync(2000);
    } finally {
      vi.useRealTimers();
      mockExistsSync.mockReturnValue(false);
      mockReadFileSync.mockReset();
    }

    // sessionRefresh must NOT have been called — config said 1h, not 1s
    expect(refreshSpy).not.toHaveBeenCalled();
  });

  it('does not loop when max_session_seconds overflows int32 setTimeout (regression)', async () => {
    // Without the clamp, max_session_seconds: 3600000 (1000h = 3.6T ms) would
    // exceed Node's int32 setTimeout max (~2.147B ms), get coerced to 1ms,
    // fire immediately, re-read the same overflow value, reschedule, and loop
    // tightly — locking the daemon. Clamp at the call site prevents this.
    const fs = await import('fs');
    const mockExistsSync = vi.mocked(fs.existsSync);
    const mockReadFileSync = vi.mocked(fs.readFileSync);

    const refreshSpy = vi.fn().mockResolvedValue(undefined);
    const logSpy = vi.fn();

    mockExistsSync.mockImplementation((p: unknown) =>
      typeof p === 'string' && p.endsWith('config.json'),
    );
    mockReadFileSync.mockImplementation((p: unknown) => {
      if (typeof p === 'string' && p.endsWith('config.json')) {
        return JSON.stringify({ max_session_seconds: 3_600_000 });
      }
      return '';
    });

    vi.useFakeTimers();
    try {
      const ap = new AgentProcess('alice', mockEnv, { max_session_seconds: 3_600_000 });
      vi.spyOn(ap, 'sessionRefresh').mockImplementation(refreshSpy);
      vi.spyOn(ap as unknown as { log: (m: string) => void }, 'log').mockImplementation(logSpy);
      await ap.start();
      // Advance past the int32 setTimeout cap. Without clamp this would log
      // thousands of "rescheduling" lines as the 1ms-coerced timer keeps firing.
      await vi.advanceTimersByTimeAsync(5000);
    } finally {
      vi.useRealTimers();
      mockExistsSync.mockReturnValue(false);
      mockReadFileSync.mockReset();
    }

    const rescheduleCount = logSpy.mock.calls.filter(
      ([msg]) => typeof msg === 'string' && msg.includes('rescheduling'),
    ).length;
    expect(rescheduleCount).toBeLessThan(5);
    expect(refreshSpy).not.toHaveBeenCalled();
  });
});

describe('AgentProcess — CrashLoopPauser (instar-inspired sliding window)', () => {
  it('triggers CRASH_LOOP halt when crash_window fills', async () => {
    const ap = new AgentProcess('alice', mockEnv, {
      crash_window: { seconds: 60, max_crashes: 3 },
    });
    await ap.start();

    // Fire 3 crashes in rapid succession (well within the 60s window).
    capturedOnExit!(1, 0);
    expect(ap.getStatus().status).toBe('crashed'); // first crash — normal recovery

    // Reset mocks and simulate the restart + second crash
    mockPty.spawn.mockClear();
    mockPty.onExit.mockClear();
    capturedOnExit = null;
    await ap.start();
    capturedOnExit!(1, 0);
    expect(ap.getStatus().status).toBe('crashed'); // second crash — still normal

    mockPty.spawn.mockClear();
    mockPty.onExit.mockClear();
    capturedOnExit = null;
    await ap.start();
    capturedOnExit!(1, 0);
    // Third crash in window → CRASH_LOOP → halted
    expect(ap.getStatus().status).toBe('halted');
  });

  it('does not trigger CRASH_LOOP when no crash_window is configured (backward compat)', async () => {
    const ap = new AgentProcess('alice', mockEnv, {
      max_crashes_per_day: 5,
    });
    await ap.start();

    // 3 crashes — without crash_window, these are just normal crash recovery
    for (let i = 0; i < 3; i++) {
      capturedOnExit!(1, 0);
      if (ap.getStatus().status !== 'halted') {
        mockPty.spawn.mockClear();
        mockPty.onExit.mockClear();
        capturedOnExit = null;
        await ap.start();
      }
    }
    // Should be 'crashed' (recovering), NOT 'halted', because daily max is 5
    expect(ap.getStatus().status).not.toBe('halted');
  });
});

describe('AgentProcess - onboarding marker (do not auto-write .onboarded on heartbeat)', () => {
  // Regression: buildStartupPrompt used to auto-write the .onboarded marker
  // whenever a heartbeat.json existed, on the assumption the agent had
  // onboarded and just forgot the marker. That silently suppressed FIRST BOOT
  // for agents that were manually scaffolded (heartbeat present) but never
  // actually ran onboarding. The marker must be explicit: a heartbeat alone
  // must NOT mark an agent onboarded. This is general daemon behavior (it was
  // surfaced via a manually-scaffolded opencode agent, but applies to any
  // runtime).
  it('does not auto-mark a heartbeat-only agent as onboarded (still routes to FIRST BOOT)', async () => {
    fsMocks.existsSync.mockImplementation((path: string) => {
      if (path.endsWith('/.force-fresh')) return false;
      if (path.endsWith('/.onboarded')) return false;
      if (path.endsWith('/heartbeat.json')) return true;
      if (path.endsWith('/ONBOARDING.md')) return true;
      return false;
    });

    const ap = new AgentProcess('alice', mockEnv, {});
    await ap.start();

    const prompt = mockPty.spawn.mock.calls[0]?.[1] ?? '';
    expect(prompt).toContain('FIRST BOOT');
    expect(prompt).toContain('read ONBOARDING.md and complete the onboarding protocol');
    // The buggy auto-write must be gone: no .onboarded written from heartbeat presence.
    expect(fsMocks.writeFileSync).not.toHaveBeenCalledWith(
      expect.stringContaining('/.onboarded'),
      expect.anything(),
      expect.anything(),
    );
  });

  it('respects an existing .onboarded marker (suppresses FIRST BOOT)', async () => {
    fsMocks.existsSync.mockImplementation((path: string) => {
      if (path.endsWith('/.force-fresh')) return false;
      if (path.endsWith('/.onboarded')) return true;
      if (path.endsWith('/heartbeat.json')) return true;
      if (path.endsWith('/ONBOARDING.md')) return true;
      return false;
    });

    const ap = new AgentProcess('alice', mockEnv, {});
    await ap.start();

    const prompt = mockPty.spawn.mock.calls[0]?.[1] ?? '';
    expect(prompt).not.toContain('FIRST BOOT');
    expect(prompt).not.toContain('complete the onboarding protocol');
  });

  // OURS-PATH (reconcile follow-on): our 2d129a68 bootstrap-content arm survives.
  // No .onboarded marker, no heartbeat — but IDENTITY.md + MEMORY.md have real
  // non-template content. The daemon MUST retro-write .onboarded and suppress
  // FIRST BOOT (heartbeat alone is no longer sufficient post-#667 reconcile).
  it('retro-writes .onboarded and suppresses FIRST BOOT when IDENTITY/MEMORY have non-template content (our bootstrap-content arm survives reconcile)', async () => {
    fsMocks.existsSync.mockImplementation((path: string) => {
      if (path.endsWith('/.force-fresh')) return false;
      if (path.endsWith('/.onboarded')) return false;
      if (path.endsWith('/heartbeat.json')) return false;     // no heartbeat — arm must not be needed
      if (path.endsWith('/ONBOARDING.md')) return true;       // present so FIRST BOOT would fire without retro-write
      if (path.endsWith('/IDENTITY.md')) return true;
      if (path.endsWith('/MEMORY.md')) return true;
      return false;
    });

    fsMocks.readFileSync.mockImplementation((p: unknown) => {
      const path = String(p);
      if (path.endsWith('/IDENTITY.md')) {
        return `# Agent Identity\n\n## Name\nalice\n\n## Role\nResearch specialist for the team.\n`;
      }
      if (path.endsWith('/MEMORY.md')) {
        return '# Long-Term Memory\n\nThis agent has been configured with substantial operating context and learned patterns that go well beyond the shipped template placeholder text.\n';
      }
      return '';
    });

    const ap = new AgentProcess('alice', mockEnv, {});
    await ap.start();

    // Bootstrap-content arm retro-writes the marker.
    expect(fsMocks.writeFileSync).toHaveBeenCalledWith(
      expect.stringContaining('/.onboarded'),
      '',
      'utf-8',
    );
    // With .onboarded now set, FIRST BOOT must be suppressed.
    const prompt = mockPty.spawn.mock.calls[0]?.[1] ?? '';
    expect(prompt).not.toContain('FIRST BOOT');
    expect(prompt).not.toContain('complete the onboarding protocol');
  });
});
