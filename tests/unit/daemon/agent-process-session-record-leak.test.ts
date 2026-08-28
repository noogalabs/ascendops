import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, chmodSync, readdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  recordSessionNonce, isSessionNonceLive, revokeAllSessionNonces,
} from '../../../src/bus/heartbeat-session-store';

/**
 * The PTY records its nonce BEFORE the child environment exists — agent-pty.ts
 * writes the record and only then spawns, because a child that exists while its
 * record does not is a forgery window. The consequence is that a spawn which
 * FAILS has already published a live record, and the only thing that can name
 * that nonce is the lifecycle that minted it.
 *
 * Two paths reached the record's owner too late:
 *   - `await this.pty.spawn()` throws: the capture sat after the await, so the
 *     lifecycle never learned its own nonce and its clear no-oped.
 *   - the PTY exits DURING spawn: handleExit runs and clears with the nonce it
 *     had at the time, which was null, and performStart then returned early.
 * Either way the record survived with no owning process until daemon boot
 * revocation — a credential that still passes the liveness check for a session
 * that never started. That is the liveness lie this PR exists to close.
 *
 * The fake PTY below mirrors agent-pty.ts:187-188 exactly: record first, then do
 * the thing that can fail. If that ordering ever changes in the real PTY these
 * tests are measuring the wrong shape, so the ordering is asserted there too.
 */

const NONCE = 'minted-then-spawn-failed';
const state = { mode: 'throw' as 'throw' | 'exit-during-spawn', ctxRoot: '' };

const mocks = vi.hoisted(() => ({
  ctxRoot: '', nonce: '', mode: 'throw' as 'throw' | 'exit-during-spawn' | 'ok',
  // Each PTY instance takes the next nonce, so two lifecycles mint two records —
  // which is the whole point: a lifecycle must clear ITS OWN and no other's.
  queue: [] as string[],
  exits: [] as Array<(code: number) => void>,
}));

vi.mock('../../../src/pty/agent-pty.js', () => ({
  AgentPTY: function AgentPTY() {
    let exitCallback: ((code: number) => void) | undefined;
    const mine = mocks.queue.length ? mocks.queue.shift()! : mocks.nonce;
    return {
      spawn: async () => {
        // Mirrors agent-pty.ts:187-188: the record is published BEFORE the child
        // environment exists, so everything after this line can fail with a live
        // record already on disk.
        const store = await import('../../../src/bus/heartbeat-session-store');
        store.recordSessionNonce(mocks.ctxRoot, 'alice', mine);
        if (mocks.mode === 'throw') throw new Error('spawn failed after the record was published');
        if (mocks.mode === 'ok') return;
        // exit-during-spawn: the PTY dies before spawn settles. handleExit runs
        // and nulls this.pty, so performStart takes its early return — with the
        // nonce still uncaptured, which is what made the record leak.
        exitCallback?.(1);
      },
      sessionNonce: () => mine,
      kill: () => { exitCallback?.(0); },
      write: vi.fn(),
      getPid: () => process.pid,
      isAlive: () => true,
      getOutputBuffer: () => ({ hasRateLimitSignature: () => false }),
      onExit: (cb: (code: number) => void) => { exitCallback = cb; mocks.exits.push(cb); },
    };
  },
}));

describe('a lifecycle clears the record it minted even when the spawn fails', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cortextos-leak-'));
    mkdirSync(join(root, 'state', 'alice'), { recursive: true });
    mocks.ctxRoot = root;
    mocks.nonce = NONCE;
    mocks.mode = 'throw';
    mocks.queue = [];
    mocks.exits = [];
    state.ctxRoot = root;
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('a spawn that throws leaves NO live record behind', async () => {
    const { AgentProcess } = await import('../../../src/daemon/agent-process');
    const proc = new AgentProcess('alice', {
      instanceId: 'test', ctxRoot: root, frameworkRoot: root,
      agentName: 'alice', agentDir: root, org: 'acme', projectRoot: root,
    } as never, {} as never, () => {});

    await expect(proc.start()).rejects.toThrow(/spawn failed/);

    expect(`record-live-after-failed-spawn=${isSessionNonceLive(root, 'alice', NONCE)}`)
      .toBe('record-live-after-failed-spawn=false');
  });

  it('a PTY that exits DURING spawn leaves NO live record behind', async () => {
    // nova: this path is reachable and the fake's inability to drive it was an
    // instrument gap, not untestability. The fake now holds the onExit callback
    // and fires it before spawn settles, which is the production shape: handleExit
    // clears with the nonce it holds at the time — null — and performStart then
    // returned early without ever learning its own nonce.
    mocks.mode = 'exit-during-spawn';
    const { AgentProcess } = await import('../../../src/daemon/agent-process');
    const proc = new AgentProcess('alice', {
      instanceId: 'test', ctxRoot: root, frameworkRoot: root,
      agentName: 'alice', agentDir: root, org: 'acme', projectRoot: root,
    } as never, {} as never, () => {});

    await proc.start();

    expect(`record-live-after-exit-during-spawn=${isSessionNonceLive(root, 'alice', NONCE)}`)
      .toBe('record-live-after-exit-during-spawn=false');
  });
});

describe('boot revocation survives one agent it cannot read', () => {
  let root: string;
  let locked: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cortextos-revoke-'));
    recordSessionNonce(root, 'alpha', 'alpha-live-session-0001');
    recordSessionNonce(root, 'beta', 'beta-live-session-00001');
    recordSessionNonce(root, 'gamma', 'gamma-live-session-0001');
    locked = join(root, 'state', 'beta', 'heartbeat-sessions');
    chmodSync(locked, 0o000);
  });
  afterEach(() => {
    try { chmodSync(locked, 0o700); } catch { /* already restored */ }
    rmSync(root, { recursive: true, force: true });
  });

  it('does not throw, revokes every agent it CAN read, and reports the one it cannot', () => {
    // sage found this: readdirSync throws EACCES on a chmod-000 directory and
    // nothing above it catches. This runs at daemon boot, so ONE agent's bad
    // directory permission took the whole fleet down. The skip is reported, not
    // swallowed — an unrevoked record is a live credential for a dead session.
    const failures: string[] = [];
    const revoked = revokeAllSessionNonces(root, agent => failures.push(agent));

    expect(`revoked=${revoked} failures=${failures.join(',')}`).toBe('revoked=2 failures=beta');
    expect(isSessionNonceLive(root, 'alpha', 'alpha-live-session-0001')).toBe(false);
    expect(isSessionNonceLive(root, 'gamma', 'gamma-live-session-0001')).toBe(false);

    // ...and beta's record really is still there, so the report is not decorative.
    chmodSync(locked, 0o700);
    expect(readdirSync(locked)).toEqual(['beta-live-session-00001.json']);
  });
});
