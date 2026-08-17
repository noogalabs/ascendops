import { describe, it, expect, vi, beforeEach } from 'vitest';

// Capture the PTY exit handler so tests can simulate exits
let capturedOnExit: ((exitCode: number, signal?: number) => void) | null = null;

const mockPty = {
  spawn: vi.fn().mockResolvedValue(undefined),
  kill: vi.fn(),
  write: vi.fn(),
  getPid: vi.fn().mockReturnValue(12345),
  isAlive: vi.fn().mockReturnValue(true),
  onExit: vi.fn().mockImplementation((cb: (exitCode: number, signal?: number) => void) => {
    capturedOnExit = cb;
  }),
  // CONTRACT-COMPLETE buffer. handleExit() captures the buffer and calls
  // hasRateLimitSignature() on it; a buffer missing that method makes handleExit
  // THROW, so performStart takes its catch branch and the !this.pty early return
  // is never reached. Any test naming that early return then passes for the
  // wrong reason — it observes a TypeError, not preservation.
  getOutputBuffer: vi.fn().mockReturnValue({
    isBootstrapped: vi.fn().mockReturnValue(false),
    hasRateLimitSignature: vi.fn().mockReturnValue(false),
  }),
};

vi.mock('../../../src/pty/agent-pty.js', () => ({
  AgentPTY: function AgentPTY() { return mockPty; },
}));

// hermesDbExists is the key hook — we control it per-test
const mockHermesDbExists = vi.fn().mockReturnValue(false);

vi.mock('../../../src/pty/hermes-pty.js', () => ({
  HermesPTY: function HermesPTY() { return mockPty; },
  hermesDbExists: (...args: unknown[]) => mockHermesDbExists(...args),
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

// Partial mock: resolveHermesHome() now parses the agent .env through the shared
// parseEnvFile so it agrees with AgentPTY about the same file, so the REAL parser
// must stay reachable here. Stubbing it out would make this suite pass against a
// resolver that no longer parses anything.
vi.mock('../../../src/utils/env.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/utils/env.js')>()),
  writeCortextosEnv: vi.fn(),
  resolveEnv: vi.fn().mockReturnValue({ instanceId: 'test', ctxRoot: '/tmp/test' }),
}));

vi.mock('../../../src/bus/reminders.js', () => ({
  getOverdueReminders: vi.fn().mockReturnValue([]),
}));

vi.mock('../../../src/utils/paths.js', () => ({
  resolvePaths: vi.fn().mockReturnValue({}),
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
  agentName: 'hermes-agent',
  agentDir: '/tmp/fw/orgs/acme/agents/hermes-agent',
  org: 'acme',
  projectRoot: '/tmp/fw',
};

beforeEach(() => {
  capturedOnExit = null;
  mockHermesDbExists.mockReset().mockReturnValue(false);
  mockPty.spawn.mockClear();
  mockPty.kill.mockClear();
  mockPty.write.mockClear();
  mockPty.isAlive.mockReset().mockReturnValue(true);
  mockPty.onExit.mockClear();
  mockInjectMessage.mockClear();
  fsMocks.existsSync.mockReset().mockReturnValue(false);
  fsMocks.readFileSync.mockReset();
  fsMocks.writeFileSync.mockReset();
  fsMocks.appendFileSync.mockReset();
  fsMocks.statSync.mockReset();
  fsMocks.unlinkSync.mockReset();
});

describe('AgentProcess - Hermes runtime: shouldContinue', () => {
  it('spawns in fresh mode when Hermes state.db does not exist', async () => {
    mockHermesDbExists.mockReturnValue(false);
    const ap = new AgentProcess('hermes-agent', mockEnv, { runtime: 'hermes' });
    await ap.start();
    expect(mockPty.spawn).toHaveBeenCalledWith('fresh', expect.any(String));
  });

  it('spawns in continue mode when Hermes state.db exists', async () => {
    mockHermesDbExists.mockReturnValue(true);
    const ap = new AgentProcess('hermes-agent', mockEnv, { runtime: 'hermes' });
    await ap.start();
    expect(mockPty.spawn).toHaveBeenCalledWith('continue', expect.any(String));
  });

  it('passes HERMES_HOME env var to hermesDbExists', async () => {
    const originalHermesHome = process.env['HERMES_HOME'];
    process.env['HERMES_HOME'] = '/custom/hermes';
    mockHermesDbExists.mockReturnValue(false);

    const ap = new AgentProcess('hermes-agent', mockEnv, { runtime: 'hermes' });
    await ap.start();

    expect(mockHermesDbExists).toHaveBeenCalledWith('/custom/hermes');
    if (originalHermesHome === undefined) {
      delete process.env['HERMES_HOME'];
    } else {
      process.env['HERMES_HOME'] = originalHermesHome;
    }
  });

  it('honors the .force-fresh marker even when Hermes state.db exists', async () => {
    // Regression: the force-fresh check used to sit BELOW the Hermes
    // early-return in shouldContinue(), so hardRestartSelf() on a Hermes
    // agent never forced a fresh session and the marker leaked forever.
    fsMocks.existsSync.mockImplementation((p: string) => String(p).endsWith('.force-fresh'));
    // The probe stats rather than exists-checks, because the consume must bind
    // to the identity of the file it observed (see probeForceFreshMarker).
    // Mock updated to match the mechanism; the assertions below are unchanged.
    fsMocks.statSync.mockImplementation((p: string) => {
      if (String(p).endsWith('.force-fresh')) return { ino: 7, mtimeMs: 42, size: 8 };
      throw new Error('ENOENT');
    });
    mockHermesDbExists.mockReturnValue(true);

    const ap = new AgentProcess('hermes-agent', mockEnv, { runtime: 'hermes' });
    await ap.start();

    // Fresh mode despite state.db existing — the marker wins...
    expect(mockPty.spawn).toHaveBeenCalledWith('fresh', expect.any(String));
    // ...and the Hermes DB probe is never consulted (marker short-circuits).
    expect(mockHermesDbExists).not.toHaveBeenCalled();
    // ...and the marker is consumed so the NEXT start can continue again.
    const unlinked = fsMocks.unlinkSync.mock.calls.map((c: unknown[]) => String(c[0]));
    expect(unlinked.some((p: string) => p.endsWith('.force-fresh'))).toBe(true);
  });

  it('does NOT consume .force-fresh when pty.spawn() FAILS', async () => {
    // The marker authorizes a fresh boot. Consuming it at the mode decision
    // spent that authorization 74 lines before the spawn, so any failure in
    // between silently downgraded the NEXT start to `--continue` — resuming the
    // exact session the marker existed to escape. That is the hazard the
    // recovery note and .rate-limited are already protected from; this pins the
    // same protection for .force-fresh.
    // FALSE-SECURE BEFORE (reviewer, and it was my own named weakest claim): this
    // mocked existsSync but NOT statSync, so the probe returned null, the launch
    // was CONTINUE, and no marker was ever exercised. The assertion passed
    // because nothing had been consumed — not because preservation worked.
    fsMocks.existsSync.mockImplementation((p: string) => String(p).endsWith('.force-fresh'));
    fsMocks.statSync.mockImplementation((p: string) => {
      if (String(p).endsWith('.force-fresh')) return { ino: 11, mtimeMs: 22, size: 33 };
      throw new Error('ENOENT');
    });
    mockHermesDbExists.mockReturnValue(true);
    mockPty.spawn.mockRejectedValueOnce(new Error('spawn failed'));

    const ap = new AgentProcess('hermes-agent', mockEnv, { runtime: 'hermes' });
    await ap.start().catch(() => { /* start surfaces the failure; not what this pins */ });

    // The marker must actually have SELECTED fresh, or the preservation claim
    // is about a launch the marker never influenced.
    expect(mockPty.spawn).toHaveBeenCalledWith('fresh', expect.any(String));
    const unlinked = fsMocks.unlinkSync.mock.calls.map((c: unknown[]) => String(c[0]));
    expect(
      unlinked.some((p: string) => p.endsWith('.force-fresh')),
      'a failed spawn must leave .force-fresh on disk so the retry still boots fresh',
    ).toBe(false);
  });

  it('does NOT consume .force-fresh when the PTY exits DURING spawn', async () => {
    // The narrower path, and the one most likely to be missed. start() has an
    // early return for "PTY exited during spawn" that lands BEFORE the delete
    // block — deliberately, so the recovery note and rate-limit marker survive
    // for the retry. .force-fresh must survive there too. A fix that only
    // handles the throwing case reproduces the original bug on this path.
    // Same false-secure defect as the case above: existsSync without statSync
    // meant this never observed a marker and never launched fresh.
    fsMocks.existsSync.mockImplementation((p: string) => String(p).endsWith('.force-fresh'));
    fsMocks.statSync.mockImplementation((p: string) => {
      if (String(p).endsWith('.force-fresh')) return { ino: 11, mtimeMs: 22, size: 33 };
      throw new Error('ENOENT');
    });
    mockHermesDbExists.mockReturnValue(true);
    // Resolve normally, but fire the exit handler so handleExit() nulls this.pty
    // before start() reaches the post-spawn block.
    mockPty.spawn.mockImplementationOnce(async () => { capturedOnExit?.(1); });

    const ap = new AgentProcess('hermes-agent', mockEnv, { runtime: 'hermes' });

    // PIN WHICH PATH RAN, via the one difference observable from outside:
    // the !this.pty early return RETURNS, while performStart's catch RE-THROWS
    // (agent-process.ts:321, so startAgent can abort secondary wiring).
    //
    // Before the mock buffer carried hasRateLimitSignature, handleExit threw a
    // TypeError, start() REJECTED, and this case passed anyway — it observed an
    // absence of unlink produced by a crash, not by preservation. Asserting the
    // absence alone says nothing about which path produced it.
    await expect(
      ap.start(),
      'the early return must RESOLVE; a throw in handleExit rejects and reaches the same absence by the catch path',
    ).resolves.toBeUndefined();

    expect(mockPty.spawn).toHaveBeenCalledWith('fresh', expect.any(String));
    const unlinked = fsMocks.unlinkSync.mock.calls.map((c: unknown[]) => String(c[0]));
    expect(
      unlinked.some((p: string) => p.endsWith('.force-fresh')),
      'the exit-during-spawn early return must preserve .force-fresh, as it already does for the other two markers',
    ).toBe(false);
  });

  it('TIMING: does NOT consume a marker that arrived AFTER the mode decision', async () => {
    // reviewer's casualty on 2965894c, wider than the stat/unlink residual I
    // disclosed. The mode-decision probe and the identity-capture probe used to
    // be two independent reads: a marker created between them was invisible to
    // the decision and visible to the capture, so the launch went CONTINUE and
    // the post-spawn delete consumed a request that was never honoured.
    //
    // Identity binding cannot fix it — the marker is UNCHANGED between capture
    // and delete. CONSUME ONLY WHAT YOU HONOURED.
    //
    // THE INTERLEAVING IS DRIVEN BY CALL COUNT, not by a timer. My first
    // attempt used setTimeout and was FALSE-SECURE: reverting to two probes
    // left it green, because the marker never actually landed between them.
    // A stat that reports ENOENT on its FIRST call and success afterwards
    // reproduces the race deterministically, and it is exactly the observation
    // the two-probe version made twice.
    let statCalls = 0;
    fsMocks.existsSync.mockImplementation((p: string) => {
      if (!String(p).endsWith('.force-fresh')) return false;
      return statCalls > 0;
    });
    fsMocks.statSync.mockImplementation((p: string) => {
      if (!String(p).endsWith('.force-fresh')) throw new Error('ENOENT');
      statCalls += 1;
      if (statCalls === 1) throw new Error('ENOENT');   // absent at the decision
      return { ino: 42, mtimeMs: 7, size: 9 };          // present for any later read
    });
    mockHermesDbExists.mockReturnValue(true);

    const ap = new AgentProcess('hermes-agent', mockEnv, { runtime: 'hermes' });
    await ap.start().catch(() => { /* not what this pins */ });

    expect(mockPty.spawn).toHaveBeenCalledWith('continue', expect.any(String));
    const unlinked = fsMocks.unlinkSync.mock.calls.map((c: unknown[]) => String(c[0]));
    expect(
      unlinked.some((p: string) => p.endsWith('.force-fresh')),
      'a marker that never selected fresh mode must NOT be consumed',
    ).toBe(false);
  });

  it('TIMING: does NOT swallow a .force-fresh REPLACED during spawn', async () => {
    // Codex P2 on 6c22479a, and a regression MY OWN FIX introduced. Deferring
    // the consume to after spawn opens a seconds-wide window; .force-fresh has
    // three writers and `bus/system.ts` hard-restart runs in a separate CLI
    // process, so a NEW request can land mid-spawn. An unconditional
    // post-spawn delete cannot tell it apart from the marker observed at mode
    // decision and swallows it — reintroducing the original bug on a narrower
    // window.
    //
    // THIS IS THE TIMING AXIS. The other cases vary WHAT fails; this one
    // varies WHEN the marker is written. My original mutation set held the
    // write fixed and would never have found this.
    const original = { ino: 100, mtimeMs: 1_000, size: 10 };
    const replacement = { ino: 200, mtimeMs: 9_999, size: 42 };
    let current = original;

    fsMocks.existsSync.mockImplementation((p: string) => String(p).endsWith('.force-fresh'));
    fsMocks.statSync.mockImplementation((p: string) => {
      if (String(p).endsWith('.force-fresh')) return current;
      throw new Error('ENOENT');
    });
    mockHermesDbExists.mockReturnValue(true);
    // A concurrent hard-restart replaces the marker WHILE the PTY is starting.
    mockPty.spawn.mockImplementationOnce(async () => { current = replacement; });

    const ap = new AgentProcess('hermes-agent', mockEnv, { runtime: 'hermes' });
    await ap.start().catch(() => { /* not what this pins */ });

    const unlinked = fsMocks.unlinkSync.mock.calls.map((c: unknown[]) => String(c[0]));
    expect(
      unlinked.some((p: string) => p.endsWith('.force-fresh')),
      'a marker replaced mid-spawn is a NEW request and must survive this launch',
    ).toBe(false);
  });

  it('TIMING: still consumes the marker when it is UNCHANGED across spawn', () => {
    // The positive sibling. Without it, the case above passes on an
    // implementation that never consumes anything at all — which is exactly
    // the sticky-forever bug the consume exists to prevent.
    const stable = { ino: 100, mtimeMs: 1_000, size: 10 };
    fsMocks.existsSync.mockImplementation((p: string) => String(p).endsWith('.force-fresh'));
    fsMocks.statSync.mockImplementation((p: string) => {
      if (String(p).endsWith('.force-fresh')) return stable;
      throw new Error('ENOENT');
    });
    mockHermesDbExists.mockReturnValue(true);

    const ap = new AgentProcess('hermes-agent', mockEnv, { runtime: 'hermes' });
    return ap.start().then(() => {
      const unlinked = fsMocks.unlinkSync.mock.calls.map((c: unknown[]) => String(c[0]));
      expect(
        unlinked.some((p: string) => p.endsWith('.force-fresh')),
        'an unchanged marker must still be consumed after a successful spawn',
      ).toBe(true);
    });
  });

  it('resolves HERMES_HOME from the agent .env file (not just the daemon env)', async () => {
    // The agent .env is loaded into the PTY CHILD's environment, not the
    // daemon's process.env — shouldContinue() must read the file itself or
    // the documented per-agent override is silently ignored.
    const agentEnvPath = `${mockEnv.agentDir}/.env`;
    fsMocks.existsSync.mockImplementation((p: string) => String(p) === agentEnvPath);
    fsMocks.readFileSync.mockImplementation((p: string) => {
      if (String(p) === agentEnvPath) {
        return '# agent secrets\nBOT_TOKEN=tg-token\nHERMES_HOME=/srv/hermes-home\n';
      }
      return '';
    });
    mockHermesDbExists.mockReturnValue(true);

    const ap = new AgentProcess('hermes-agent', mockEnv, { runtime: 'hermes' });
    await ap.start();

    expect(mockHermesDbExists).toHaveBeenCalledWith('/srv/hermes-home');
    expect(mockPty.spawn).toHaveBeenCalledWith('continue', expect.any(String));
  });
});

describe('AgentProcess - Hermes runtime: stop uses Ctrl+D', () => {
  it('sends Ctrl+D (not /exit) when stopping a hermes agent', async () => {
    const ap = new AgentProcess('hermes-agent', mockEnv, { runtime: 'hermes' });
    await ap.start();
    expect(capturedOnExit).not.toBeNull();

    const stopPromise = ap.stop();
    await new Promise(r => setTimeout(r, 100));

    // Ctrl+D should have been written, not /exit\r\n
    const writeCalls = mockPty.write.mock.calls.map((c: string[]) => c[0]);
    expect(writeCalls).toContain('\x04');
    expect(writeCalls).not.toContain('/exit\r\n');

    capturedOnExit!(0, 0);
    await stopPromise;
  }, 10000);
});
