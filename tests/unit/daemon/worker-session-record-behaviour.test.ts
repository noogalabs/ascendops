import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { isSessionNonceLive } from '../../../src/bus/heartbeat-session-store';

/**
 * BEHAVIOURAL replacement for the PATH 1+2 source-position anchor, which sage
 * defeated: its window ran 1600 chars forward from the onExit call and bled past
 * the closure into the try block, so MOVING the clear out of the exit handler and
 * into the line before `spawn()` — wrong handler, wrong moment, the record would
 * be cleared before it is even written — left that test GREEN.
 *
 * This one observes the effect instead: after the PTY's exit callback fires, the
 * record that run published is gone. Sage's mutation kills it, because clearing
 * before spawn clears nothing and the record then survives the exit.
 */

const NONCE = 'worker-run-nonce-000001';
const mocks = vi.hoisted(() => ({
  ctxRoot: '',
  exits: [] as Array<(c: number) => void>,
  spawned: 0,
  mode: 'ok' as 'ok' | 'throw' | 'throw-revoke',
}));

vi.mock('../../../src/pty/agent-pty.js', () => ({
  AgentPTY: function AgentPTY() {
    let exitCallback: ((code: number) => void) | undefined;
    return {
      spawn: async () => {
        // Mirrors agent-pty.ts: the record is published inside spawn(), before
        // the child environment exists.
        const store = await import('../../../src/bus/heartbeat-session-store');
        store.recordSessionNonce(mocks.ctxRoot, 'w1', NONCE);
        mocks.spawned += 1;
        if (mocks.mode === 'throw-revoke') {
          const record = join(mocks.ctxRoot, 'state', 'w1', 'heartbeat-sessions', `${NONCE}.json`);
          rmSync(record);
          mkdirSync(record);
        }
        if (mocks.mode === 'throw') throw new Error('spawn failed after the record was published');
        if (mocks.mode === 'throw-revoke') throw new Error('root worker spawn failure');
      },
      sessionNonce: () => NONCE,
      kill: () => { exitCallback?.(0); },
      write: vi.fn(),
      getPid: () => process.pid,
      isAlive: () => true,
      getOutputBuffer: () => ({ hasRateLimitSignature: () => false }),
      onExit: (cb: (code: number) => void) => { exitCallback = cb; mocks.exits.push(cb); },
    };
  },
}));

describe('a worker run clears the record it published, on the exit path', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cortextos-worker-behaviour-'));
    mkdirSync(join(root, 'state', 'w1'), { recursive: true });
    mocks.ctxRoot = root;
    mocks.exits = [];
    mocks.spawned = 0;
    mocks.mode = 'ok';
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  function env() {
    return {
      instanceId: 'test', ctxRoot: root, frameworkRoot: root,
      agentName: 'w1', agentDir: root, org: 'acme', projectRoot: root,
    };
  }

  it('the record is live while the worker runs, and GONE once its PTY exits', async () => {
    const { WorkerProcess } = await import('../../../src/daemon/worker-process');
    const worker = new WorkerProcess('w1', root, undefined, () => {});

    await worker.spawn(env() as never, 'do the thing');

    // The record must exist FIRST, or a clear that runs at the wrong moment would
    // look identical to a clear that works.
    expect(`spawned=${mocks.spawned} live-during-run=${isSessionNonceLive(root, 'w1', NONCE)}`)
      .toBe('spawned=1 live-during-run=true');

    mocks.exits[0](0);

    expect(`live-after-exit=${isSessionNonceLive(root, 'w1', NONCE)}`).toBe('live-after-exit=false');
  });

  it('a run whose spawn THROWS leaves no record behind, because onExit never fires', async () => {
    // Behavioural replacement for the PATH 3 source-position anchor. That anchor
    // bounded its window on a string the mutation itself moved, so a clear
    // relocated onto the SUCCESS path still matched — the end marker travelled
    // with the change. An anchor whose delimiter the mutation can shift is not an
    // anchor.
    mocks.mode = 'throw';
    const { WorkerProcess } = await import('../../../src/daemon/worker-process');
    const worker = new WorkerProcess('w1', root, undefined, () => {});

    await expect(worker.spawn(env() as never, 'do the thing')).rejects.toThrow(/spawn failed/);

    expect(`live-after-failed-spawn=${isSessionNonceLive(root, 'w1', NONCE)}`)
      .toBe('live-after-failed-spawn=false');
  });

  it('worker exit revocation failure completes terminal bookkeeping and exposes revoke-failed', async () => {
    const { WorkerProcess } = await import('../../../src/daemon/worker-process');
    const worker = new WorkerProcess('w1', root, undefined, () => {});
    const done = vi.fn();
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    worker.onDone(done);
    await worker.spawn(env() as never, 'do the thing');

    const record = join(root, 'state', 'w1', 'heartbeat-sessions', `${NONCE}.json`);
    rmSync(record);
    mkdirSync(record);

    expect(() => mocks.exits[0](7)).not.toThrow();
    expect(worker.getStatus()).toMatchObject({ status: 'revoke-failed', exitCode: 7 });
    expect(worker.getStatus().pid).toBeUndefined();
    expect(done).toHaveBeenCalledWith('w1', 7);
    expect(error).toHaveBeenCalledWith(expect.stringContaining('SESSION REVOCATION UNKNOWN'));
    error.mockRestore();
  });

  it('worker spawn cleanup failure preserves the root spawn error and completes failed bookkeeping', async () => {
    mocks.mode = 'throw-revoke';
    const { WorkerProcess } = await import('../../../src/daemon/worker-process');
    const worker = new WorkerProcess('w1', root, undefined, () => {});
    const done = vi.fn();
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    worker.onDone(done);

    await expect(worker.spawn(env() as never, 'do the thing')).rejects.toThrow('root worker spawn failure');
    expect(worker.getStatus()).toMatchObject({ status: 'revoke-failed' });
    expect(worker.getStatus().pid).toBeUndefined();
    expect(done).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledWith(expect.stringContaining('SESSION REVOCATION UNKNOWN'));
    error.mockRestore();
  });
});
