import { describe, it, expect, vi, beforeEach } from 'vitest';

let capturedOnExit: ((exitCode: number, signal?: number) => void) | null = null;

const mockCodexAppServerPty = {
  spawn: vi.fn().mockResolvedValue(undefined),
  kill: vi.fn(),
  write: vi.fn(),
  getPid: vi.fn().mockReturnValue(24680),
  isAlive: vi.fn().mockReturnValue(true),
  onExit: vi.fn().mockImplementation((cb: (exitCode: number, signal?: number) => void) => {
    capturedOnExit = cb;
  }),
  getOutputBuffer: vi.fn().mockReturnValue({ isBootstrapped: vi.fn().mockReturnValue(true) }),
  setTelegramHandle: vi.fn(),
};

const mockAgentPty = {
  ...mockCodexAppServerPty,
  setTelegramHandle: undefined,
};

vi.mock('../../../src/pty/agent-pty.js', () => ({
  AgentPTY: function AgentPTY() { return mockAgentPty; },
}));

vi.mock('../../../src/pty/codex-app-server-pty.js', () => ({
  CodexAppServerPTY: function CodexAppServerPTY() { return mockCodexAppServerPty; },
}));

vi.mock('../../../src/pty/hermes-pty.js', () => ({
  HermesPTY: function HermesPTY() { return mockAgentPty; },
  hermesDbExists: vi.fn().mockReturnValue(false),
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
    get unlinkSync() { return fsMocks.unlinkSync; },
    get existsSync() { return fsMocks.existsSync; },
    get readFileSync() { return fsMocks.readFileSync; },
    get writeFileSync() { return fsMocks.writeFileSync; },
    get appendFileSync() { return fsMocks.appendFileSync; },
    get statSync() { return fsMocks.statSync; },
  };
});

const { AgentProcess } = await import('../../../src/daemon/agent-process.js');

const mockEnv = {
  instanceId: 'test',
  ctxRoot: '/tmp/test-ctx',
  frameworkRoot: '/tmp/fw',
  agentName: 'codex-app-agent',
  agentDir: '/tmp/fw/orgs/acme/agents/codex-app-agent',
  org: 'acme',
  projectRoot: '/tmp/fw',
};

beforeEach(() => {
  capturedOnExit = null;
  for (const pty of [mockCodexAppServerPty, mockAgentPty]) {
    pty.spawn.mockClear();
    pty.kill.mockClear();
    pty.write.mockClear();
    pty.getPid.mockClear();
    pty.isAlive.mockReset().mockReturnValue(true);
    pty.onExit.mockClear();
    pty.getOutputBuffer.mockClear();
  }
  mockCodexAppServerPty.setTelegramHandle.mockClear();
  mockInjectMessage.mockClear();
  fsMocks.existsSync.mockReset().mockReturnValue(false);
  fsMocks.readFileSync.mockReset();
  fsMocks.writeFileSync.mockReset();
  fsMocks.appendFileSync.mockReset();
  fsMocks.statSync.mockReset();
  fsMocks.unlinkSync.mockClear();
});

describe('AgentProcess codex-app-server runtime', () => {
  it('selects CodexAppServerPTY for runtime codex-app-server', async () => {
    const ap = new AgentProcess('codex-app-agent', mockEnv, { runtime: 'codex-app-server' });
    await ap.start();

    expect(mockCodexAppServerPty.spawn).toHaveBeenCalledWith('fresh', expect.any(String));
    expect(ap.getStatus().pid).toBe(24680);
  });

  it('wires Telegram handle to CodexAppServerPTY before start', async () => {
    const ap = new AgentProcess('codex-app-agent', mockEnv, { runtime: 'codex-app-server' });
    const api = { sendChatAction: vi.fn().mockResolvedValue(undefined) };

    ap.setTelegramHandle(api as any, '12345');
    await ap.start();

    expect(mockCodexAppServerPty.setTelegramHandle).toHaveBeenCalledWith(api, '12345');
  });

  it('sends one direct back-online Telegram notification for a lone codex-app-server start', async () => {
    const log = vi.fn();
    const ap = new AgentProcess('codex-app-agent', mockEnv, { runtime: 'codex-app-server' }, log);
    const api = {
      sendChatAction: vi.fn().mockResolvedValue(undefined),
      sendMessage: vi.fn().mockResolvedValue({ ok: true }),
    };

    ap.setTelegramHandle(api as any, '12345');
    await ap.start();

    expect(api.sendMessage).toHaveBeenCalledTimes(1);
    expect(api.sendMessage).toHaveBeenCalledWith('12345', 'Agent codex-app-agent is back online');
    expect(log).toHaveBeenCalledWith('Telegram back-online notification sent for codex-app-agent');
  });

  it('sends planned-restart msg1 but skips generic back-online Telegram on handoff restart', async () => {
    // Simulate handoff doc marker present at .handoff-doc-path so
    // consumeHandoffBlock() returns a non-empty fragment, marking the spawn
    // as a handoff restart that should suppress the daemon-direct ping.
    // existsSync must return true for BOTH the marker file and the doc path
    // it points at — consumeHandoffBlock checks both.
    const handoffDocPath = '/tmp/handoff-doc.md';
    fsMocks.existsSync.mockImplementation((path: string) =>
      typeof path === 'string'
      && (path.endsWith('.handoff-doc-path') || path === handoffDocPath),
    );
    fsMocks.readFileSync.mockReturnValue(handoffDocPath);

    const ap = new AgentProcess('codex-app-agent', mockEnv, { runtime: 'codex-app-server' });
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    const api = { sendChatAction: vi.fn().mockResolvedValue(undefined), sendMessage };

    ap.setTelegramHandle(api as any, '12345');
    await ap.start();

    const prompt = mockCodexAppServerPty.spawn.mock.calls[0]?.[1] ?? '';
    expect(prompt).toContain('CONTEXT HANDOFF');
    expect(sendMessage).toHaveBeenCalledWith('12345', '🔄 codex-app-agent restarted (planned): no reason given');
    expect(sendMessage).not.toHaveBeenCalledWith('12345', 'Agent codex-app-agent is back online');
    expect(sendMessage).not.toHaveBeenCalledWith('12345', 'Agent codex-app-agent is back online (context handoff)');
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it('does not send daemon-direct back-online Telegram for claude-code runtime (issue #392)', async () => {
    // claude-code already executes the inline "Send a Telegram message..."
    // bootstrap instruction itself, so the daemon must not double up.
    const ap = new AgentProcess('claude-agent', mockEnv, { runtime: 'claude-code' });
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    const api = { sendChatAction: vi.fn().mockResolvedValue(undefined), sendMessage };

    ap.setTelegramHandle(api as any, '12345');
    await ap.start();

    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('suppresses the direct codex-app-server back-online notification during a fleet start batch', async () => {
    const ap = new AgentProcess('codex-app-agent', mockEnv, { runtime: 'codex-app-server' });
    const api = {
      sendChatAction: vi.fn().mockResolvedValue(undefined),
      sendMessage: vi.fn().mockResolvedValue({ ok: true }),
    };

    ap.setTelegramHandle(api as any, '12345');
    await ap.start({ partOfFleetStart: true });

    expect(api.sendMessage).not.toHaveBeenCalled();
  });

  it('uses direct kill path on stop, not Claude /exit choreography', async () => {
    const ap = new AgentProcess('codex-app-agent', mockEnv, { runtime: 'codex-app-server' });
    await ap.start();
    expect(capturedOnExit).not.toBeNull();

    const stopPromise = ap.stop();
    await new Promise((resolve) => setTimeout(resolve, 100));

    const writes = mockCodexAppServerPty.write.mock.calls.map((call: string[]) => call[0]);
    expect(writes).not.toContain('\x03');
    expect(writes).not.toContain('/exit\r\n');

    capturedOnExit!(0, 0);
    await stopPromise;
    expect(mockCodexAppServerPty.kill).toHaveBeenCalled();
  }, 10000);

  it('ignores stale Claude JSONL when picking continue vs fresh', async () => {
    const codexThreadPath = '/tmp/test-ctx/state/codex-app-agent/codex-app-server-thread.json';

    // A stale Claude JSONL is irrelevant for this runtime. With no Codex thread
    // state, the launch must be fresh.
    fsMocks.existsSync.mockImplementation((path: string) => {
      if (path.endsWith('.force-fresh')) return false;
      if (path === codexThreadPath) return false;
      return path.endsWith('.jsonl');
    });
    const fresh = new AgentProcess('codex-app-agent', mockEnv, { runtime: 'codex-app-server' });
    await fresh.start();
    expect(mockCodexAppServerPty.spawn).toHaveBeenLastCalledWith('fresh', expect.any(String));

    // The runtime's own thread-state file is the only continue signal.
    mockCodexAppServerPty.spawn.mockClear();
    fsMocks.existsSync.mockImplementation((path: string) => {
      if (path.endsWith('.force-fresh')) return false;
      return path === codexThreadPath;
    });
    const continued = new AgentProcess('codex-app-agent', mockEnv, { runtime: 'codex-app-server' });
    await continued.start();
    expect(mockCodexAppServerPty.spawn).toHaveBeenLastCalledWith('continue', expect.any(String));
  });

  it('force-fresh wins over codex thread state and the marker is consumed', async () => {
    const codexThreadPath = '/tmp/test-ctx/state/codex-app-agent/codex-app-server-thread.json';

    // Both signals present: .force-fresh must win (fresh spawn), and the
    // marker must be consumed in the launch decision — pins the
    // force-fresh-BEFORE-runtime-checks ordering in shouldContinue().
    fsMocks.existsSync.mockImplementation((path: string) => {
      if (path.endsWith('.force-fresh')) return true;
      return path === codexThreadPath;
    });
    const forced = new AgentProcess('codex-app-agent', mockEnv, { runtime: 'codex-app-server' });
    await forced.start();
    expect(mockCodexAppServerPty.spawn).toHaveBeenLastCalledWith('fresh', expect.any(String));
    expect(fsMocks.unlinkSync).toHaveBeenCalledWith(expect.stringMatching(/\.force-fresh$/));
  });
});
