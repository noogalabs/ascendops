import { describe, expect, it, vi } from 'vitest';
import {
  superviseLeaseSpan,
  type LeaseSupervisorDependencies,
} from '../../../src/daemon/worktree-lease-supervisor';
import { WorktreeLeaseArbiter, type LeaseRecord } from '../../../src/daemon/worktree-lease-arbiter';
import { measurePeerCredentials } from '../../../src/daemon/peer-credentials';

function fixture(options: { childExit?: number; dieAfterAcquire?: boolean } = {}) {
  const events: string[] = [];
  let settleChild!: (code: number) => void;
  const childSettled = new Promise<number>(resolve => { settleChild = resolve; });
  const dependencies: LeaseSupervisorDependencies = {
    createRequestId: () => '00000000-0000-4000-8000-000000000001',
    persistRequestId: async requestId => { events.push(`persist:${requestId}`); },
    acquire: async request => {
      events.push(`acquire:${request.requestId}`);
      return { kind: 'granted', token: 'opaque-token' };
    },
    bindChild: async () => ({ kind: 'bound' }),
    spawnProtectedChild: (_command, lease) => {
      events.push(`lease:${lease.scopeKey}:${lease.requestId}:${lease.token}`);
      events.push('spawn');
      if (options.childExit !== undefined) queueMicrotask(() => settleChild(options.childExit!));
      return { pid: 42, settled: childSettled, resume: vi.fn(), terminate: vi.fn(() => settleChild(143)) };
    },
    release: async request => { events.push(`release:${request.token}`); },
    removeRequestId: async requestId => { events.push(`remove:${requestId}`); },
    supervisorDeath: options.dieAfterAcquire
      ? new Promise<void>(resolve => queueMicrotask(resolve))
      : new Promise<void>(() => {}),
  };
  return { dependencies, events, settleChild };
}

describe('worktree lease supervisor', () => {
  for (const bindMode of ['refused', 'rejected'] as const) {
    it(`arbiter-release-gate-backs-stops-${bindMode}-path-when-local-settle-is-removed`, async () => {
      let persisted: LeaseRecord | undefined;
      let childLive = true;
      const arbiter = new WorktreeLeaseArbiter({
        persistence: {
          withScopeLock: (_scopeKey, operation) => operation(),
          publish: record => { persisted = record; }, remove: () => { persisted = undefined; },
          load: () => persisted,
        },
        observeIdentity: record => record.pid === 10 || (record.pid === 42 && childLive)
          ? 'matching-live' : 'dead-or-reused',
        createToken: () => 'opaque-token',
      });
      const peer = measurePeerCredentials(9, {
        readPeerCredentials: () => ({ pid: 10, platform: 'linux' }),
      }, { readStartIdentity: () => 'kernel:10' })!;
      const requestId = '00000000-0000-4000-8000-000000000001';
      const releaseKinds: string[] = [];
      let settle!: (code: number) => void;
      const dependencies: LeaseSupervisorDependencies = {
        createRequestId: () => requestId, persistRequestId: async () => {},
        acquire: async request => arbiter.acquire({ ...request, peer }),
        bindChild: async request => {
          const bound = arbiter.bindDestructiveChild(request.scopeKey, request.requestId, request.token, peer, {
            pid: 42, platform: 'linux', processStartIdentity: 'kernel:42',
          });
          expect(bound).toEqual({ kind: 'bound' });
          if (bindMode === 'rejected') throw new Error('transport rejected after durable bind');
          return { kind: 'refused', reason: 'post-bind refusal' };
        },
        spawnProtectedChild: () => ({
          pid: 42,
          settled: new Promise<number>(resolve => { settle = resolve; }),
          resume: () => {},
          terminate: () => queueMicrotask(() => { childLive = false; settle(143); }),
        }),
        release: async request => {
          const result = arbiter.release(request.scopeKey, request.requestId, request.token);
          releaseKinds.push(result.kind);
          if (result.kind !== 'released') throw new Error(`release refused: ${result.reason}`);
        },
        removeRequestId: async () => {}, supervisorDeath: new Promise<void>(() => {}),
      };
      const run = superviseLeaseSpan({
        scopeKey: 'repo:/canonical/repo', owner: 'test', command: ['protected'],
      }, dependencies);
      if (bindMode === 'rejected') await expect(run).rejects.toThrow('transport rejected');
      else await expect(run).resolves.toEqual({ kind: 'refused', reason: 'post-bind refusal' });
      expect(releaseKinds).toEqual(['released']);
      expect(childLive).toBe(false);
    });
  }

  it('persists the request ID before acquire and brackets the entire child span with the token', async () => {
    const { dependencies, events } = fixture({ childExit: 0 });
    const result = await superviseLeaseSpan({
      scopeKey: 'repo:/canonical/repo',
      owner: 'sample-owner',
      command: ['reap-agent-worktrees', '--owner', 'sample-owner'],
    }, dependencies);

    expect(result).toEqual({ kind: 'completed', exitCode: 0 });
    expect(events).toEqual([
      'persist:00000000-0000-4000-8000-000000000001',
      'acquire:00000000-0000-4000-8000-000000000001',
      'lease:repo:/canonical/repo:00000000-0000-4000-8000-000000000001:opaque-token',
      'spawn',
      'release:opaque-token',
      'remove:00000000-0000-4000-8000-000000000001',
    ]);
  });

  it('does not release or erase requester evidence when the supervisor dies mid-span', async () => {
    const { dependencies, events } = fixture({ dieAfterAcquire: true });
    const result = await superviseLeaseSpan({
      scopeKey: 'repo:/canonical/repo',
      owner: 'sample-owner',
      command: ['reap-agent-worktrees', '--owner', 'sample-owner'],
    }, dependencies);

    expect(result).toEqual({ kind: 'supervisor-died' });
    expect(events).toEqual([
      'persist:00000000-0000-4000-8000-000000000001',
      'acquire:00000000-0000-4000-8000-000000000001',
      'lease:repo:/canonical/repo:00000000-0000-4000-8000-000000000001:opaque-token',
      'spawn',
    ]);
  });

  it('holder-death-cannot-outlive-the-destructive-span', async () => {
    let die!: () => void;
    let childExit!: (code: number) => void;
    const terminate = vi.fn();
    const dependencies: LeaseSupervisorDependencies = {
      createRequestId: () => '00000000-0000-4000-8000-000000000001',
      persistRequestId: async () => {},
      acquire: async () => ({ kind: 'granted', token: 'opaque-token' }),
      bindChild: async () => ({ kind: 'bound' }),
      spawnProtectedChild: () => ({
        pid: 42,
        settled: new Promise<number>(resolve => { childExit = resolve; }),
        resume: vi.fn(),
        terminate,
      }),
      release: vi.fn(),
      removeRequestId: vi.fn(),
      supervisorDeath: new Promise<void>(resolve => { die = resolve; }),
    };
    const span = superviseLeaseSpan({
      scopeKey: 'repo:/canonical/repo', owner: 'sample-owner', command: ['reap-agent-worktrees'],
    }, dependencies);
    await Promise.resolve();
    die();
    await vi.waitFor(() => expect(terminate).toHaveBeenCalledOnce());
    let settled = false;
    span.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    childExit(143);
    expect(await span).toEqual({ kind: 'supervisor-died' });
  });

  it('never spawns when acquire refuses and preserves the durable request ID for retry', async () => {
    const { dependencies, events } = fixture();
    dependencies.acquire = async request => {
      events.push(`acquire:${request.requestId}`);
      return { kind: 'refused', reason: 'LIVE_HELD' };
    };
    const result = await superviseLeaseSpan({
      scopeKey: 'repo:/canonical/repo',
      owner: 'sample-owner',
      command: ['reap-agent-worktrees'],
    }, dependencies);

    expect(result).toEqual({ kind: 'refused', reason: 'LIVE_HELD' });
    expect(events).toEqual([
      'persist:00000000-0000-4000-8000-000000000001',
      'acquire:00000000-0000-4000-8000-000000000001',
    ]);
  });

  it('bind refusal resumes and terminates the stopped child, reaps it, and releases the lease within a bound', async () => {
    let stopped = true;
    let terminated = false;
    let settle!: (code: number) => void;
    const release = vi.fn(async () => {});
    const removeRequestId = vi.fn(async () => {});
    const dependencies: LeaseSupervisorDependencies = {
      createRequestId: () => '00000000-0000-4000-8000-000000000001',
      persistRequestId: async () => {},
      acquire: async () => ({ kind: 'granted', token: 'opaque-token' }),
      bindChild: async () => ({ kind: 'refused', reason: 'CAPABILITY_MISMATCH' }),
      spawnProtectedChild: () => ({
        pid: 42,
        settled: new Promise<number>(resolve => { settle = resolve; }),
        resume: () => {
          stopped = false;
          if (terminated) settle(143);
        },
        terminate: () => {
          terminated = true;
          if (!stopped) settle(143);
        },
      }),
      release,
      removeRequestId,
      supervisorDeath: new Promise<void>(() => {}),
    };
    const outcome = superviseLeaseSpan({
      scopeKey: 'repo:/canonical/repo', owner: 'sample-owner', command: ['reap-agent-worktrees'],
    }, dependencies);
    await expect(Promise.race([
      outcome,
      new Promise((_, reject) => setTimeout(() => reject(new Error('bind-refusal-timeout')), 100)),
    ])).resolves.toEqual({ kind: 'refused', reason: 'CAPABILITY_MISMATCH' });
    expect(release).toHaveBeenCalledOnce();
    expect(removeRequestId).toHaveBeenCalledOnce();
  });

  it('bind rejection resumes-terminates-reaps-and-releases-before-surfacing-the-error', async () => {
    const events: string[] = [];
    let settle!: (code: number) => void;
    const dependencies: LeaseSupervisorDependencies = {
      createRequestId: () => '00000000-0000-4000-8000-000000000002',
      persistRequestId: async () => {},
      acquire: async () => ({ kind: 'granted', token: 'opaque-token' }),
      bindChild: async () => { throw new Error('IPC timeout'); },
      spawnProtectedChild: () => ({
        pid: 43,
        settled: new Promise<number>(resolve => { settle = resolve; }),
        resume: () => { events.push('resume'); },
        terminate: () => { events.push('terminate'); settle(143); },
      }),
      release: async () => { events.push('release'); },
      removeRequestId: async () => { events.push('remove'); },
      supervisorDeath: new Promise<void>(() => {}),
    };
    await expect(superviseLeaseSpan({
      scopeKey: 'repo:/canonical/repo', owner: 'sample-owner', command: ['reap-agent-worktrees'],
    }, dependencies)).rejects.toThrow('IPC timeout');
    expect(events).toEqual(['resume', 'terminate', 'release', 'remove']);
  });
});
