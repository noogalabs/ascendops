import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type { IPCRequest, IPCResponse } from '../../../src/types/index.js';

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
const { IPCServer } = await import('../../../src/daemon/ipc-server.js');

type TestSocket = {
  write: ReturnType<typeof vi.fn>;
  end: ReturnType<typeof vi.fn>;
};

function dispatchRestart(
  manager: {
    inspectAgentOp: ReturnType<typeof vi.fn>;
    restartAgent: ReturnType<typeof vi.fn>;
  },
  request: IPCRequest,
): { response: IPCResponse; socket: TestSocket } {
  const socket: TestSocket = {
    write: vi.fn(),
    end: vi.fn(),
  };
  const server = new IPCServer(manager as never);

  (server as unknown as {
    handleRequest: (incoming: IPCRequest, target: TestSocket) => void;
  }).handleRequest(request, socket);

  return {
    response: JSON.parse(socket.write.mock.calls[0][0]) as IPCResponse,
    socket,
  };
}

describe('IPC restart-agent verdict gate', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('does not dispatch restartAgent when inspection rejects the request', () => {
    const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const manager = {
      inspectAgentOp: vi.fn().mockReturnValue({
        ok: false,
        code: 'NOT_FOUND',
        message: 'agent "ghost" not in registry — cannot restart',
      }),
      restartAgent: vi.fn().mockResolvedValue(undefined),
    };

    const { response, socket } = dispatchRestart(manager, {
      type: 'restart-agent',
      agent: 'ghost',
      source: 'test',
    });

    expect(manager.restartAgent).not.toHaveBeenCalled();
    expect(response).toEqual({
      success: false,
      error: 'agent "ghost" not in registry — cannot restart',
      code: 'NOT_FOUND',
    });
    expect(consoleLogSpy).toHaveBeenCalledWith(
      '[ipc] restart-agent ghost: NOT_FOUND — agent "ghost" not in registry — cannot restart',
    );
    expect(socket.end).toHaveBeenCalledOnce();
  });

  it('dispatches one normal restart when inspection passes', () => {
    const manager = {
      inspectAgentOp: vi.fn().mockReturnValue({ ok: true }),
      restartAgent: vi.fn().mockResolvedValue(undefined),
    };

    const { response } = dispatchRestart(manager, {
      type: 'restart-agent',
      agent: 'alice',
      source: 'test',
    });

    expect(manager.restartAgent).toHaveBeenCalledOnce();
    expect(manager.restartAgent).toHaveBeenCalledWith('alice', undefined);
    expect(response).toEqual({ success: true, data: 'Restarting alice' });
  });

  it('records a refused FLEET member through the IPC seam, and does not for a manual one', () => {
    // The method-level overlap test exercises the coordinator semantics but BYPASSES the
    // seam that caused the bug. This asserts the IPC layer actually calls the accounting
    // hook on a refused FLEET request — and pointedly does not on a refused MANUAL one.
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const manager = {
      inspectAgentOp: vi.fn().mockReturnValue({
        ok: false,
        code: 'DEDUPED',
        message: 'restart request for "alice" deduped — restart already in flight',
      }),
      restartAgent: vi.fn().mockResolvedValue(undefined),
      recordFleetStartRejection: vi.fn(),
    };

    dispatchRestart(manager, {
      type: 'restart-agent',
      agent: 'alice',
      source: 'cortextos bus soft-restart-all',
      data: { fleetTotal: 2, fleetIndex: 0 },
    });
    expect(manager.recordFleetStartRejection).toHaveBeenCalledWith('alice', 2);
    expect(manager.restartAgent).not.toHaveBeenCalled();

    manager.recordFleetStartRejection.mockClear();
    dispatchRestart(manager, { type: 'restart-agent', agent: 'alice', source: 'test' });
    expect(manager.recordFleetStartRejection).not.toHaveBeenCalled();
    expect(manager.restartAgent).not.toHaveBeenCalled();
  });
});

describe('AgentManager restart in-flight verdict', () => {
  let testDir: string;
  let manager: InstanceType<typeof AgentManager>;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'cortextos-restart-gate-'));
    const ctxRoot = join(testDir, 'instance');
    const frameworkRoot = join(testDir, 'framework');
    mkdirSync(join(ctxRoot, 'config'), { recursive: true });
    mkdirSync(join(frameworkRoot, 'orgs', 'acme', 'agents', 'alice'), { recursive: true });
    manager = new AgentManager('test-instance', ctxRoot, frameworkRoot, 'acme');
    (manager as unknown as { agents: Map<string, unknown> }).agents.set('alice', {
      process: { getStatus: () => ({ name: 'alice', status: 'running' }) },
      checker: {},
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(testDir, { recursive: true, force: true });
  });

  it('returns DEDUPED while the same agent restart is in flight, then permits a rapid re-restart', async () => {
    let finishStop: (() => void) | undefined;
    vi.spyOn(manager, 'stopAgent').mockImplementation(() => new Promise<void>(resolve => {
      finishStop = resolve;
    }));
    vi.spyOn(manager, 'startAgent').mockResolvedValue(undefined);

    const firstRestart = manager.restartAgent('alice');

    expect(manager.inspectAgentOp('restart', 'alice')).toEqual({
      ok: false,
      code: 'DEDUPED',
      message: 'restart request for "alice" deduped — restart already in flight',
    });

    finishStop?.();
    await firstRestart;

    expect(manager.inspectAgentOp('restart', 'alice')).toEqual({ ok: true });
  });

  it('releases the marker when restartAgent rejects so a later restart is permitted', async () => {
    const stopSpy = vi.spyOn(manager, 'stopAgent')
      .mockRejectedValueOnce(new Error('stop exploded'))
      .mockResolvedValueOnce(undefined);
    vi.spyOn(manager, 'startAgent').mockResolvedValue(undefined);

    await expect(manager.restartAgent('alice')).rejects.toThrow('stop exploded');
    expect(manager.inspectAgentOp('restart', 'alice')).toEqual({ ok: true });
    await expect(manager.restartAgent('alice')).resolves.toBeUndefined();
    expect(stopSpy).toHaveBeenCalledTimes(2);
  });

  it('tracks fleet restarts per agent so distinct agents do not dedupe each other', async () => {
    (manager as unknown as { agents: Map<string, unknown> }).agents.set('bob', {
      process: { getStatus: () => ({ name: 'bob', status: 'running' }) },
      checker: {},
    });
    let finishAlice: (() => void) | undefined;
    vi.spyOn(manager, 'stopAgent').mockImplementation(name => {
      if (name === 'alice') {
        return new Promise<void>(resolve => {
          finishAlice = resolve;
        });
      }
      return Promise.resolve();
    });
    vi.spyOn(manager, 'startAgent').mockResolvedValue(undefined);

    const aliceRestart = manager.restartAgent('alice', {
      partOfFleetStart: true,
      fleetTotal: 2,
      fleetIndex: 0,
    });

    expect(manager.inspectAgentOp('restart', 'alice')).toMatchObject({
      ok: false,
      code: 'DEDUPED',
    });
    expect(manager.inspectAgentOp('restart', 'bob')).toEqual({ ok: true });

    finishAlice?.();
    await aliceRestart;
  });

  it('refuses to fabricate a batch when a rejection arrives with no usable fleetTotal', () => {
    // The no-guess branch. Previously `fleetTotal ?? 1` created a ONE-MEMBER batch,
    // immediately satisfied it, cleared it, and let the first genuine member open a
    // second batch that stranded one short — a missing total becoming silent corruption.
    // Contract now: malformed input => NO STATE CHANGE, warn, return. It deliberately
    // does NOT try to reconstruct a partially malformed fleet run.
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const batch = () => (manager as unknown as { fleetStartBatch: unknown }).fleetStartBatch;

    expect(batch()).toBeNull();

    manager.recordFleetStartRejection('alice', undefined);
    expect(batch()).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('refused fleet member alice not accounted'),
    );

    warnSpy.mockClear();
    manager.recordFleetStartRejection('alice', 0);
    expect(batch()).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('refused fleet member alice not accounted'),
    );
  });

  it('records a refused fleet member so the coordinator still clears (same-agent manual/fleet overlap)', async () => {
    // REGRESSION for the blocker found on 454650df, reproducing the real chain:
    // a MANUAL restart of alice is in flight when soft-restart-all arrives for
    // alice + bob (fleetTotal 2). The IPC gate refuses alice as DEDUPED, so
    // restartAgent(alice, {partOfFleetStart}) is NEVER CALLED and alice is never
    // recorded. Bob completes at 1 of 2, finishFleetStartBatch never clears, and the
    // stale coordinator then suppresses the NEXT fleet batch.
    // The repair records the REFUSED member without dispatching and without clearing
    // alice's live in-flight marker.
    (manager as unknown as { agents: Map<string, unknown> }).agents.set('bob', {
      process: { getStatus: () => ({ name: 'bob', status: 'running' }) },
      checker: {},
    });
    let finishAlice: (() => void) | undefined;
    const stopSpy = vi.spyOn(manager, 'stopAgent').mockImplementation(name => {
      if (name === 'alice') {
        return new Promise<void>(resolve => {
          finishAlice = resolve;
        });
      }
      return Promise.resolve();
    });
    vi.spyOn(manager, 'startAgent').mockResolvedValue(undefined);

    // 1. MANUAL restart of alice, in flight.
    const aliceManual = manager.restartAgent('alice');
    expect(manager.inspectAgentOp('restart', 'alice')).toMatchObject({ code: 'DEDUPED' });
    const aliceStops = () => stopSpy.mock.calls.filter(c => c[0] === 'alice').length;
    const aliceStopsAfterManual = aliceStops();

    // 2. Fleet restart: alice is REFUSED at the gate, so the caller records her
    //    instead of dispatching. Bob dispatches normally.
    manager.recordFleetStartRejection('alice', 2);
    await manager.restartAgent('bob', { partOfFleetStart: true, fleetTotal: 2, fleetIndex: 1 });

    // 3. ALICE was not dispatched a second time. Count only her calls — bob's own
    //    restart legitimately calls stopAgent too, and a total-count assertion would
    //    fail for the wrong reason.
    expect(aliceStops()).toBe(aliceStopsAfterManual);

    // 4. The coordinator CLEARED rather than stranding at 1 of 2.
    expect((manager as unknown as { fleetStartBatch: unknown }).fleetStartBatch).toBeNull();

    // 5. Alice's live in-flight marker SURVIVED the rejection path.
    expect(manager.inspectAgentOp('restart', 'alice')).toMatchObject({ code: 'DEDUPED' });

    finishAlice?.();
    await aliceManual;

    // 6. A later fleet batch is not absorbed by a stale coordinator.
    await manager.restartAgent('bob', { partOfFleetStart: true, fleetTotal: 1, fleetIndex: 0 });
    expect((manager as unknown as { fleetStartBatch: unknown }).fleetStartBatch).toBeNull();
  });
});
