import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const logEventMock = vi.hoisted(() => vi.fn());

vi.mock('../../../src/bus/event.js', () => ({
  logEvent: logEventMock,
}));
vi.mock('../../../src/daemon/agent-process.js', () => ({
  AgentProcess: class {},
}));
vi.mock('../../../src/daemon/worker-process.js', () => ({
  WorkerProcess: class {},
}));
vi.mock('../../../src/daemon/fast-checker.js', () => ({
  FastChecker: class {},
}));
vi.mock('../../../src/daemon/slack-socket-listener.js', () => ({
  SlackSocketListener: class {},
}));
vi.mock('../../../src/telegram/api.js', () => ({
  TelegramAPI: class {},
}));
vi.mock('../../../src/telegram/poller.js', () => ({
  TelegramPoller: class {},
}));

const { AgentManager } = await import('../../../src/daemon/agent-manager.js');

type PendingRestartEntry = {
  cause: 'post-crash' | 'in-flight-duplicate';
  queuedAt: number;
};

describe('AgentManager pending restart instrumentation', () => {
  let testDir: string;
  let ctxRoot: string;
  let frameworkRoot: string;
  let manager: InstanceType<typeof AgentManager>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-29T12:00:00.000Z'));
    logEventMock.mockClear();
    testDir = mkdtempSync(join(tmpdir(), 'cortextos-pending-restart-'));
    ctxRoot = join(testDir, 'instance');
    frameworkRoot = join(testDir, 'framework');
    mkdirSync(join(ctxRoot, 'config'), { recursive: true });
    manager = new AgentManager('test-instance', ctxRoot, frameworkRoot, 'acme');
  });

  afterEach(() => {
    vi.useRealTimers();
    rmSync(testDir, { recursive: true, force: true });
  });

  function registerStoppingAgent(name = 'alice'): void {
    (manager as any).agents.set(name, {
      process: { stop: vi.fn().mockResolvedValue(undefined) },
      checker: { stop: vi.fn() },
    });
  }

  function pendingEntry(name = 'alice'): PendingRestartEntry | undefined {
    return (manager as any).pendingRestarts.get(name);
  }

  function eventMeta(event: string): Record<string, unknown> | undefined {
    return logEventMock.mock.calls.find(call => call[4] === event)?.[6];
  }

  it('records the enqueue-time cause and timestamp', async () => {
    registerStoppingAgent();
    (manager as any).daemonJustCrashed = true;

    await manager.startAgent('alice', '');

    expect(pendingEntry()).toEqual({
      cause: 'post-crash',
      queuedAt: Date.parse('2026-07-29T12:00:00.000Z'),
    });
    expect(eventMeta('pending_restart_enqueued')).toMatchObject({
      agent: 'alice',
      recorded_cause: 'post-crash',
      consume_derived_cause: 'post-crash',
      elapsed_ms: 0,
    });
  });

  it('preserves the first cause and timestamp across duplicate enqueues', async () => {
    registerStoppingAgent();
    (manager as any).daemonJustCrashed = true;
    await manager.startAgent('alice', '');

    vi.advanceTimersByTime(250);
    (manager as any).daemonJustCrashed = false;
    await manager.startAgent('alice', '');

    expect(pendingEntry()).toEqual({
      cause: 'post-crash',
      queuedAt: Date.parse('2026-07-29T12:00:00.000Z'),
    });
    expect((manager as any).pendingRestarts.size).toBe(1);
  });

  it('logs cause disagreement after the crash flag clears and still restarts exactly once', async () => {
    registerStoppingAgent();
    (manager as any).daemonJustCrashed = true;
    await manager.startAgent('alice', '');

    vi.advanceTimersByTime(500);
    (manager as any).daemonJustCrashed = false;
    const startSpy = vi.spyOn(manager, 'startAgent').mockResolvedValue(undefined);

    await manager.stopAgent('alice');

    expect(startSpy).toHaveBeenCalledTimes(1);
    expect(startSpy).toHaveBeenCalledWith('alice', '');
    expect((manager as any).pendingRestarts.has('alice')).toBe(false);
    expect(eventMeta('pending_restart_consumed')).toMatchObject({
      agent: 'alice',
      recorded_cause: 'post-crash',
      consume_derived_cause: 'in-flight-duplicate',
      elapsed_ms: 500,
    });
    expect(eventMeta('pending_restart_cause_disagreement')).toMatchObject({
      agent: 'alice',
      recorded_cause: 'post-crash',
      consume_derived_cause: 'in-flight-duplicate',
      elapsed_ms: 500,
    });
  });

  it('does not emit or start when stop consumes no pending entry', async () => {
    registerStoppingAgent();
    const startSpy = vi.spyOn(manager, 'startAgent').mockResolvedValue(undefined);

    await manager.stopAgent('alice');

    expect(startSpy).not.toHaveBeenCalled();
    expect(logEventMock).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.anything(),
      'pending_restart_consumed',
      expect.anything(),
      expect.anything(),
    );
  });

  it('clears the queued entry when the agent directory disappeared before consume', async () => {
    registerStoppingAgent();
    (manager as any).daemonJustCrashed = false;
    await manager.startAgent('alice', '');

    await expect(manager.stopAgent('alice')).resolves.toBeUndefined();

    expect((manager as any).pendingRestarts.has('alice')).toBe(false);
    expect((manager as any).agents.has('alice')).toBe(false);
    expect(eventMeta('pending_restart_consumed')).toMatchObject({
      agent: 'alice',
      recorded_cause: 'in-flight-duplicate',
      consume_derived_cause: 'in-flight-duplicate',
    });
  });
});
