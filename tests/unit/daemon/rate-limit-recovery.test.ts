import { describe, it, expect, vi, beforeEach } from 'vitest';

// Capture PTY exit handler so tests can simulate exits at controlled times
let capturedOnExit: ((exitCode: number, signal?: number) => void) | null = null;

// Configurable rate-limit signature flag for this test suite
let mockHasRateLimitSignature = false;

const mockOutputBuffer = {
  hasRateLimitSignature: vi.fn(() => mockHasRateLimitSignature),
  isBootstrapped: vi.fn().mockReturnValue(false),
};

const mockPty = {
  sessionNonce: vi.fn().mockReturnValue(null),
  spawn: vi.fn().mockResolvedValue(undefined),
  kill: vi.fn(),
  write: vi.fn(),
  // process.pid keeps getStatus()'s OS-liveness probe (process.kill(pid, 0))
  // happy in tests; the probe was added to catch silent-PTY-death in prod.
  getPid: vi.fn().mockReturnValue(process.pid),
  isAlive: vi.fn().mockReturnValue(true),
  getOutputBuffer: vi.fn(() => mockOutputBuffer),
  onExit: vi.fn().mockImplementation((cb: (exitCode: number, signal?: number) => void) => {
    capturedOnExit = cb;
  }),
};

vi.mock('../../../src/pty/agent-pty.js', () => ({
  AgentPTY: function AgentPTY() { return mockPty; },
}));

vi.mock('../../../src/pty/inject.js', () => ({
  injectMessage: vi.fn(),
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
  resolvePaths: vi.fn().mockReturnValue({}),
}));

const mockExecFileSync = vi.fn();
vi.mock('child_process', async () => {
  const actual = await vi.importActual<typeof import('child_process')>('child_process');
  return {
    ...actual,
    execFileSync: mockExecFileSync,
  };
});

const mockWriteFileSync = vi.fn();
const mockExistsSync = vi.fn().mockReturnValue(false);
const mockReadFileSync = vi.fn().mockReturnValue('');

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    mkdirSync: vi.fn(),
    existsSync: mockExistsSync,
    readFileSync: mockReadFileSync,
    writeFileSync: mockWriteFileSync,
  };
});

// Watchdog mocks — we verify these are NOT called on rate-limit exits
const mockRecordFailure = vi.fn();
const mockMarkHealthy = vi.fn();
const mockShouldRollback = vi.fn().mockReturnValue(false);
const mockPerformRollback = vi.fn();
const mockIsWatchdogRollbackEnabled = vi.fn().mockReturnValue(false);
const mockWatchdogRollbackMaxResets = vi.fn().mockReturnValue(1);
const mockWatchdogRollbackFloorRef = vi.fn().mockReturnValue(undefined);
const mockReadRecoveryNote = vi.fn().mockReturnValue(null);
const mockDeleteRecoveryNote = vi.fn();
const mockFindGitRoot = vi.fn().mockReturnValue(null);

vi.mock('../../../src/daemon/watchdog.js', () => ({
  recordFailure: mockRecordFailure,
  markHealthy: mockMarkHealthy,
  shouldRollback: mockShouldRollback,
  performRollback: mockPerformRollback,
  isWatchdogRollbackEnabled: mockIsWatchdogRollbackEnabled,
  watchdogRollbackMaxResets: mockWatchdogRollbackMaxResets,
  watchdogRollbackFloorRef: mockWatchdogRollbackFloorRef,
  readRecoveryNote: mockReadRecoveryNote,
  deleteRecoveryNote: mockDeleteRecoveryNote,
  findGitRoot: mockFindGitRoot,
  MIN_HEALTHY_SECONDS: 60,
}));

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
  mockHasRateLimitSignature = false;
  mockPty.spawn.mockClear();
  mockPty.kill.mockClear();
  mockPty.write.mockClear();
  mockPty.isAlive.mockReturnValue(true);
  mockPty.onExit.mockClear();
  mockPty.getOutputBuffer.mockClear();
  mockOutputBuffer.hasRateLimitSignature.mockClear();
  mockWriteFileSync.mockClear();
  mockExecFileSync.mockClear();
  mockExistsSync.mockReturnValue(false);
  mockReadFileSync.mockReturnValue('');
  mockRecordFailure.mockClear();
  mockShouldRollback.mockReturnValue(false);
  mockPerformRollback.mockClear();
  mockIsWatchdogRollbackEnabled.mockReturnValue(false);
  mockWatchdogRollbackMaxResets.mockReturnValue(1);
  mockWatchdogRollbackFloorRef.mockReturnValue(undefined);
  mockReadRecoveryNote.mockReturnValue(null);
  mockDeleteRecoveryNote.mockClear();
  mockFindGitRoot.mockClear();
  mockFindGitRoot.mockReturnValue(null);
});

describe('AgentProcess - rate-limit recovery', () => {
  it('resolves watchdog commits from the framework repo, not the nested agent repo', () => {
    new AgentProcess('alice', mockEnv, {});

    expect(mockFindGitRoot).toHaveBeenCalledOnce();
    expect(mockFindGitRoot).toHaveBeenCalledWith(mockEnv.frameworkRoot);
    expect(mockFindGitRoot).not.toHaveBeenCalledWith(mockEnv.agentDir);
  });

  it('sets status to rate-limited (not crashed) when rate-limit signature detected', async () => {
    mockHasRateLimitSignature = true;
    const ap = new AgentProcess('alice', mockEnv, {});
    await ap.start();
    expect(capturedOnExit).not.toBeNull();
    expect(ap.getStatus().status).toBe('running');

    capturedOnExit!(1, 0);

    expect(ap.getStatus().status).toBe('rate-limited');
  });

  it('does NOT increment crashCount on rate-limit exit', async () => {
    mockHasRateLimitSignature = true;
    const ap = new AgentProcess('alice', mockEnv, { max_crashes_per_day: 2 });
    await ap.start();

    // Fire two rate-limit exits — should not exhaust crash budget
    capturedOnExit!(1, 0);
    expect(ap.getStatus().crashCount).toBe(0);
  });

  it('does NOT call watchdog recordFailure on rate-limit exit', async () => {
    mockHasRateLimitSignature = true;
    const ap = new AgentProcess('alice', mockEnv, {});
    await ap.start();

    capturedOnExit!(1, 0);

    expect(mockRecordFailure).not.toHaveBeenCalled();
  });

  it('writes .rate-limited marker file on rate-limit exit', async () => {
    mockHasRateLimitSignature = true;
    const ap = new AgentProcess('alice', mockEnv, {});
    await ap.start();

    capturedOnExit!(1, 0);

    const writeCall = mockWriteFileSync.mock.calls.find(
      (args) => typeof args[0] === 'string' && (args[0] as string).includes('.rate-limited'),
    );
    expect(writeCall).toBeDefined();
  });

  it('uses default pause of 18000s when rate_limit_pause_seconds is not set', async () => {
    mockHasRateLimitSignature = true;
    vi.useFakeTimers();
    try {
      const ap = new AgentProcess('alice', mockEnv, {});
      await ap.start();
      const startSpy = vi.spyOn(ap, 'start');

      capturedOnExit!(1, 0);
      expect(ap.getStatus().status).toBe('rate-limited');

      // Advance past 18000s — restart should trigger
      await vi.advanceTimersByTimeAsync(18_001 * 1000);
      expect(startSpy).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('respects custom rate_limit_pause_seconds from config', async () => {
    mockHasRateLimitSignature = true;
    vi.useFakeTimers();
    try {
      const ap = new AgentProcess('alice', mockEnv, { rate_limit_pause_seconds: 60 });
      await ap.start();
      const startSpy = vi.spyOn(ap, 'start');

      capturedOnExit!(1, 0);
      expect(ap.getStatus().status).toBe('rate-limited');

      // Should NOT restart before 60s
      await vi.advanceTimersByTimeAsync(59_000);
      expect(startSpy).not.toHaveBeenCalled();

      // Should restart after 60s
      await vi.advanceTimersByTimeAsync(2_000);
      expect(startSpy).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('normal crash path (no rate-limit sig) still increments crashCount', async () => {
    mockHasRateLimitSignature = false;
    const ap = new AgentProcess('alice', mockEnv, {});
    await ap.start();

    capturedOnExit!(1, 0);

    expect(ap.getStatus().crashCount).toBe(1);
    expect(ap.getStatus().status).toBe('crashed');
  });

  it('normal crash path still calls watchdog recordFailure', async () => {
    mockHasRateLimitSignature = false;
    const ap = new AgentProcess('alice', mockEnv, {});
    await ap.start();

    capturedOnExit!(1, 0);

    expect(mockRecordFailure).toHaveBeenCalled();
  });

  it('does not perform rollback by default when threshold trips', async () => {
    mockHasRateLimitSignature = false;
    mockFindGitRoot.mockReturnValue('/tmp/repo');
    mockShouldRollback.mockReturnValue(true);
    mockIsWatchdogRollbackEnabled.mockReturnValue(false);
    const ap = new AgentProcess('alice', mockEnv, {});
    await ap.start();

    capturedOnExit!(1, 0);

    expect(mockRecordFailure).toHaveBeenCalledWith('/tmp/test-ctx/state/alice', '/tmp/repo');
    expect(mockShouldRollback).toHaveBeenCalledWith('/tmp/test-ctx/state/alice', '/tmp/repo');
    expect(mockPerformRollback).not.toHaveBeenCalled();
  });

  it('logs rollback preflight with the crashing agent context when rollback is enabled', async () => {
    mockHasRateLimitSignature = false;
    mockFindGitRoot.mockReturnValue('/tmp/repo');
    mockShouldRollback.mockReturnValue(true);
    mockIsWatchdogRollbackEnabled.mockReturnValue(true);
    mockPerformRollback.mockImplementationOnce(async (_stateDir, _repoRoot, options) => {
      options.logEventBeforeRollback({
        repoRoot: '/tmp/repo',
        stateDir: '/tmp/test-ctx/state/alice',
        branch: 'main',
        failedCommit: 'abc123456789',
        target: 'def123456789',
        resetCount: 0,
        maxResets: 1,
      });
      return { success: false, rolledBackTo: '', stashRef: null, reason: 'test stop' };
    });
    const ap = new AgentProcess('alice', mockEnv, {});
    await ap.start();

    capturedOnExit!(1, 0);
    await Promise.resolve();

    expect(mockExecFileSync).toHaveBeenCalledWith(
      'cortextos',
      ['bus', 'log-event', 'error', 'watchdog_rollback_preflight', 'error', '--meta', expect.any(String)],
      expect.objectContaining({
        cwd: '/tmp/fw/orgs/acme/agents/alice',
        env: expect.objectContaining({
          CTX_AGENT_NAME: 'alice',
          // Positive borrowed-identity marker. The daemon sets CTX_AGENT_NAME
          // to the SUBJECT agent here, so nothing downstream can tell this is
          // an on-behalf write by absence or by comparing subject to actor.
          // Consumed by borrowedIdentityMarker() in src/bus/event.ts to
          // withhold the heartbeat refresh that `bus log-event` opts into
          // unconditionally — this fires from handleExit(), when the agent has
          // just crashed and is provably not running.
          CTX_ON_BEHALF_OF: 'alice',
          CTX_AGENT_DIR: '/tmp/fw/orgs/acme/agents/alice',
          CTX_ORG: 'acme',
          CTX_ROOT: '/tmp/test-ctx',
          CTX_PROJECT_ROOT: '/tmp/fw',
          CTX_FRAMEWORK_ROOT: '/tmp/fw',
        }),
      }),
    );
  });

  it('startup prompt includes RATE-LIMIT RECOVERY when .rate-limited marker exists', async () => {
    // Simulate fresh start with marker present
    mockExistsSync.mockImplementation((p: unknown) => {
      if (typeof p === 'string' && (p as string).includes('.rate-limited')) return true;
      return false;
    });

    const ap = new AgentProcess('alice', mockEnv, {});
    await ap.start();

    const spawnCall = mockPty.spawn.mock.calls[0];
    expect(spawnCall).toBeDefined();
    const prompt: string = spawnCall[1] as string;
    expect(prompt).toContain('RATE-LIMIT RECOVERY');
  });
});
