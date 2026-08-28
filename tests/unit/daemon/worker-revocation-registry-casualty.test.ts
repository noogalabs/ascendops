import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const NONCES = ['worker-registry-nonce-0001', 'worker-registry-nonce-0002'];
const mocks = vi.hoisted(() => ({
  exits: [] as Array<(code: number) => void>,
  suppressExitOnKill: false,
  created: 0,
}));

vi.mock('../../../src/pty/agent-pty.js', () => ({
  AgentPTY: function AgentPTY(env: { ctxRoot: string; agentName: string }) {
    let onExit: ((code: number) => void) | null = null;
    const nonce = NONCES[mocks.created++] ?? `worker-registry-nonce-${mocks.created.toString().padStart(4, '0')}`;
    return {
      spawn: async () => {
        const store = await import('../../../src/bus/heartbeat-session-store');
        store.recordSessionNonce(env.ctxRoot, env.agentName, nonce);
      },
      sessionNonce: () => nonce,
      onExit: (cb: (code: number) => void) => { onExit = cb; mocks.exits.push(cb); },
      write: () => {},
      kill: () => { if (!mocks.suppressExitOnKill) onExit?.(0); },
      getPid: () => process.pid,
      isAlive: () => true,
      getOutputBuffer: () => ({ hasRateLimitSignature: () => false }),
    };
  },
}));

describe('worker revocation failure reaches terminal registry accounting', () => {
  let root: string;

  beforeEach(() => {
    vi.useFakeTimers();
    mocks.exits = [];
    mocks.suppressExitOnKill = false;
    mocks.created = 0;
    root = mkdtempSync(join(tmpdir(), 'worker-revoke-registry-'));
  });

  afterEach(() => {
    vi.useRealTimers();
    rmSync(root, { recursive: true, force: true });
  });

  it('a worker tombstone prevents a second live credential until its exact retained nonce is revoked', async () => {
    const { AgentManager } = await import('../../../src/daemon/agent-manager');
    const manager = new AgentManager('test', root, root, 'acme');
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    await manager.spawnWorker('worker-a', root, 'do work');
    const record = join(root, 'state', 'worker-a', 'heartbeat-sessions', `${NONCES[0]}.json`);
    rmSync(record);
    mkdirSync(record);

    expect(() => mocks.exits[0](9)).not.toThrow();
    expect(manager.getWorkerStatus('worker-a')).toMatchObject({ status: 'revoke-failed', exitCode: 9 });
    expect(error).toHaveBeenCalledWith(expect.stringContaining('SESSION REVOCATION UNKNOWN'));

    await vi.advanceTimersByTimeAsync(30_000);
    expect(manager.getWorkerStatus('worker-a')).toMatchObject({ status: 'revoke-failed' });

    await expect(manager.spawnWorker('worker-a', root, 'second run'))
      .rejects.toThrow('SESSION REVOCATION UNKNOWN');
    expect(mocks.created).toBe(1);

    rmSync(record, { recursive: true, force: true });
    const sessions = join(root, 'state', 'worker-a', 'heartbeat-sessions');
    mkdirSync(sessions, { recursive: true });
    await manager.spawnWorker('worker-a', root, 'second run');
    expect(mocks.created).toBe(2);
    expect(readdirSync(sessions)).toEqual([`${NONCES[1]}.json`]);
    error.mockRestore();
  });

  it('Ctrl-C-honoured termination reports revocation failure and retains the tombstone', async () => {
    const { AgentManager } = await import('../../../src/daemon/agent-manager');
    const manager = new AgentManager('test', root, root, 'acme');
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    await manager.spawnWorker('worker-a', root, 'do work');
    const record = join(root, 'state', 'worker-a', 'heartbeat-sessions', `${NONCES[0]}.json`);
    rmSync(record);
    mkdirSync(record);

    const termination = manager.terminateWorker('worker-a');
    const rejection = expect(termination).rejects.toThrow('SESSION REVOCATION UNKNOWN');
    await vi.advanceTimersByTimeAsync(500);
    await rejection;
    expect(manager.getWorkerStatus('worker-a')).toMatchObject({ status: 'revoke-failed' });
    expect(error).toHaveBeenCalledWith(expect.stringContaining('SESSION REVOCATION UNKNOWN'));
    error.mockRestore();
  });

  it('a clean explicit termination completes and frees the name for reuse', async () => {
    const { AgentManager } = await import('../../../src/daemon/agent-manager');
    const manager = new AgentManager('test', root, root, 'acme');
    await manager.spawnWorker('worker-a', root, 'do work');

    const termination = manager.terminateWorker('worker-a');
    await vi.advanceTimersByTimeAsync(500);
    await expect(termination).resolves.toBeUndefined();
    expect(manager.getWorkerStatus('worker-a')).toBeNull();
    await expect(manager.spawnWorker('worker-a', root, 'again')).resolves.toBeUndefined();
  });
});
