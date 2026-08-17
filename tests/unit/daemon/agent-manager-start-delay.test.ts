import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { join } from 'path';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';

const ptySpawn = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const ptyLifecycle = vi.hoisted(() => ({ active: 0, maxActive: 0 }));

vi.mock('../../../src/pty/agent-pty.js', () => ({
  AgentPTY: class {
    private spawned = false;
    private exitHandler: ((exitCode: number, signal?: number) => void) | undefined;
    async spawn(...args: unknown[]) {
      await ptySpawn(...args);
      this.spawned = true;
      ptyLifecycle.active += 1;
      ptyLifecycle.maxActive = Math.max(ptyLifecycle.maxActive, ptyLifecycle.active);
    }
    onExit(handler: (exitCode: number, signal?: number) => void) { this.exitHandler = handler; }
    getPid() { return process.pid; }
    isAlive() { return true; }
    getOutputBuffer() { return { hasRateLimitSignature: () => false }; }
    write() { /* no-op */ }
    kill() {
      if (!this.spawned) return;
      this.spawned = false;
      ptyLifecycle.active -= 1;
      this.exitHandler?.(0, 0);
    }
  },
}));
vi.mock('../../../src/daemon/fast-checker.js', () => ({
  FastChecker: class {
    async start() { /* no-op */ }
    stop() { /* no-op */ }
    wake() { /* no-op */ }
    resetWatchdogState() { /* no-op */ }
  },
}));
vi.mock('../../../src/telegram/api.js', () => ({ TelegramAPI: class {} }));
vi.mock('../../../src/telegram/poller.js', () => ({
  TelegramPoller: class { start() {} stop() {} onMessage() {} onCallback() {} onReaction() {} },
}));

const { AgentManager } = await import('../../../src/daemon/agent-manager.js');

describe('AgentManager delayed-start lifecycle matrix', () => {
  let root: string;
  let ctxRoot: string;
  let frameworkRoot: string;
  let agentDir: string;

  beforeEach(() => {
    vi.useFakeTimers();
    ptySpawn.mockClear();
    ptyLifecycle.active = 0;
    ptyLifecycle.maxActive = 0;
    root = mkdtempSync(join(tmpdir(), 'cortextos-am-start-delay-'));
    ctxRoot = join(root, 'instance');
    frameworkRoot = join(root, 'framework');
    agentDir = join(frameworkRoot, 'orgs', 'acme', 'agents', 'alice');
    mkdirSync(join(ctxRoot, 'config'), { recursive: true });
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(join(agentDir, 'config.json'), JSON.stringify({
      name: 'alice',
      startup_delay: 5,
      telegram_polling: false,
    }));
  });

  afterEach(() => {
    vi.useRealTimers();
    rmSync(root, { recursive: true, force: true });
  });

  it('cancels the pending start before PTY spawn and leaves no registry entry', async () => {
    const am = new AgentManager('test-instance', ctxRoot, frameworkRoot, 'acme');
    const agents = (am as unknown as { agents: Map<string, unknown> }).agents;
    const pendingRestarts = (am as unknown as { pendingRestarts: Map<string, unknown> }).pendingRestarts;
    const config = { startup_delay: 5, telegram_polling: false };

    const starting = am.startAgent(
      'alice',
      agentDir,
      config,
      'acme',
    );
    const duplicate = am.startAgent('alice', agentDir, config, 'acme');
    expect(agents.size).toBe(1);
    expect(pendingRestarts.size).toBe(0);

    await am.stopAgent('alice', true);
    expect(agents.size).toBe(0);

    await vi.advanceTimersByTimeAsync(5_000);
    await Promise.all([starting, duplicate]);

    expect(agents.size).toBe(0);
    expect(ptySpawn).not.toHaveBeenCalled();
    expect(pendingRestarts.size).toBe(0);
  });

  it('deduplicates a second start against the visible delayed lifecycle', async () => {
    const am = new AgentManager('test-instance', ctxRoot, frameworkRoot, 'acme');
    const agents = (am as unknown as { agents: Map<string, unknown> }).agents;
    const pendingRestarts = (am as unknown as { pendingRestarts: Map<string, unknown> }).pendingRestarts;
    const config = { startup_delay: 5, telegram_polling: false };

    const first = am.startAgent('alice', agentDir, config, 'acme');
    const second = am.startAgent('alice', agentDir, config, 'acme');

    expect(agents.size).toBe(1);
    expect(am.getAgentStatus('alice')?.status).toBe('starting');
    expect(ptySpawn).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(5_000);
    await Promise.all([first, second]);

    expect(agents.size).toBe(1);
    expect(am.getAgentStatus('alice')?.status).toBe('running');
    expect(ptySpawn).toHaveBeenCalledTimes(1);
    expect(pendingRestarts.size).toBe(0);
    expect(ptyLifecycle.maxActive).toBe(1);
  });

  it('keeps duplicate-start state inert through a later explicit restart', async () => {
    const am = new AgentManager('test-instance', ctxRoot, frameworkRoot, 'acme');
    const agents = (am as unknown as { agents: Map<string, unknown> }).agents;
    const pendingRestarts = (am as unknown as { pendingRestarts: Map<string, unknown> }).pendingRestarts;
    const config = { startup_delay: 5, telegram_polling: false };

    const first = am.startAgent('alice', agentDir, config, 'acme');
    const duplicate = am.startAgent('alice', agentDir, config, 'acme');
    await vi.advanceTimersByTimeAsync(5_000);
    await Promise.all([first, duplicate]);

    expect(pendingRestarts.size).toBe(0);
    expect(ptyLifecycle.active).toBe(1);

    const restart = am.restartAgent('alice');
    // Claude stop uses its six-second Ctrl-C + /exit grace sequence; only
    // after the old PTY exits may restart admit the replacement lifecycle.
    await vi.advanceTimersByTimeAsync(6_000);
    expect(agents.size).toBe(1);
    expect(am.getAgentStatus('alice')?.status).toBe('starting');
    expect(ptyLifecycle.active).toBe(0);

    await vi.advanceTimersByTimeAsync(5_000);
    await restart;

    expect(agents.size).toBe(1);
    expect(am.getAgentStatus('alice')?.status).toBe('running');
    expect(ptySpawn).toHaveBeenCalledTimes(2);
    expect(ptyLifecycle.active).toBe(1);
    expect(ptyLifecycle.maxActive).toBe(1);
    expect(pendingRestarts.size).toBe(0);
  });

  it('cancels the old delayed lifecycle and registers one replacement on restart', async () => {
    const am = new AgentManager('test-instance', ctxRoot, frameworkRoot, 'acme');
    const agents = (am as unknown as { agents: Map<string, unknown> }).agents;

    const original = am.startAgent(
      'alice',
      agentDir,
      { startup_delay: 5, telegram_polling: false },
      'acme',
    );
    const restart = am.restartAgent('alice');
    await vi.advanceTimersByTimeAsync(0);

    expect(agents.size).toBe(1);
    expect(am.getAgentStatus('alice')?.status).toBe('starting');
    expect(ptySpawn).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(5_000);
    await Promise.all([original, restart]);

    expect(agents.size).toBe(1);
    expect(am.getAgentStatus('alice')?.status).toBe('running');
    expect(ptySpawn).toHaveBeenCalledTimes(1);
  });

  it('cancels a delayed lifecycle during manager shutdown', async () => {
    const am = new AgentManager('test-instance', ctxRoot, frameworkRoot, 'acme');
    const agents = (am as unknown as { agents: Map<string, unknown> }).agents;
    const pendingRestarts = (am as unknown as { pendingRestarts: Map<string, unknown> }).pendingRestarts;
    const config = { startup_delay: 5, telegram_polling: false };

    const starting = am.startAgent(
      'alice',
      agentDir,
      config,
      'acme',
    );
    const duplicate = am.startAgent('alice', agentDir, config, 'acme');
    expect(pendingRestarts.size).toBe(0);
    await am.stopAll();

    await vi.advanceTimersByTimeAsync(5_000);
    await Promise.all([starting, duplicate]);

    expect(agents.size).toBe(0);
    expect(ptySpawn).not.toHaveBeenCalled();
    expect(pendingRestarts.size).toBe(0);
  });

  it('evicts one stale entry then keeps its delayed replacement visible', async () => {
    const am = new AgentManager('test-instance', ctxRoot, frameworkRoot, 'acme');
    const agents = (am as unknown as { agents: Map<string, unknown> }).agents;
    const pendingRestarts = (am as unknown as { pendingRestarts: Map<string, unknown> }).pendingRestarts;
    const staleStop = vi.fn().mockResolvedValue(undefined);
    const staleCheckerStop = vi.fn();
    const stale = {
      process: {
        getStatus: () => ({ name: 'alice', status: 'halted' }),
        stop: staleStop,
      },
      checker: { stop: staleCheckerStop },
    };
    agents.set('alice', stale);

    const replacement = am.startAgent(
      'alice',
      agentDir,
      { startup_delay: 5, telegram_polling: false },
      'acme',
    );
    await Promise.resolve();
    await Promise.resolve();

    expect(staleStop).toHaveBeenCalledTimes(1);
    expect(staleCheckerStop).toHaveBeenCalledTimes(1);
    expect(agents.size).toBe(1);
    expect(agents.get('alice')).not.toBe(stale);
    expect(am.getAgentStatus('alice')?.status).toBe('starting');

    // A second admission during replacement delay must see the replacement
    // as live, never stale-evict it or create a second PTY lifecycle.
    const duplicate = am.startAgent(
      'alice',
      agentDir,
      { startup_delay: 5, telegram_polling: false },
      'acme',
    );
    await vi.advanceTimersByTimeAsync(5_000);
    await Promise.all([replacement, duplicate]);

    expect(agents.size).toBe(1);
    expect(am.getAgentStatus('alice')?.status).toBe('running');
    expect(ptySpawn).toHaveBeenCalledTimes(1);
    expect(pendingRestarts.size).toBe(0);
    expect(ptyLifecycle.maxActive).toBe(1);
  });
});
