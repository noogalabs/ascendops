import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorktreeLeaseIpcService } from '../../../src/daemon/worktree-lease-ipc';
import { WorktreeLeaseArbiter, type LeasePersistence, type LeaseRecord } from '../../../src/daemon/worktree-lease-arbiter';
import { InternalWorktreeWriterLease } from '../../../src/daemon/internal-worktree-writer-lease';
import type { DurableLeaseRequest } from '../../../src/daemon/durable-lease-request';
import { createWorktreeLeaseRuntime } from '../../../src/daemon/worktree-lease-runtime';
import { measurePeerCredentials } from '../../../src/daemon/peer-credentials';

const requestId = '00000000-0000-4000-8000-000000000001';
const scopeKey = 'repo:/canonical/repo';

class MemoryStore implements LeasePersistence {
  record?: LeaseRecord;
  withScopeLock<T>(_scopeKey: string, operation: () => T): T { return operation(); }
  publish(record: LeaseRecord) { this.record = record; }
  remove() { this.record = undefined; }
  load() { return this.record; }
}

describe('worktree lease IPC boundary', () => {
  it('refuses-a-destructive-child-that-is-not-a-descendant-of-the-measured-peer', async () => {
    const store = new MemoryStore();
    const arbiter = new WorktreeLeaseArbiter({
      persistence: store,
      observeIdentity: () => 'matching-live',
      createToken: () => 'opaque-token',
    });
    const service = new WorktreeLeaseIpcService({
      arbiter,
      measurePeer: async () => ({ pid: 777, platform: 'linux', processStartIdentity: 'holder-start' }),
      measureProcess: () => ({ pid: 1, platform: 'linux', processStartIdentity: 'init-start' }),
    });
    await service.handle('acquire-worktree-lease', { scopeKey, requestId, owner: 'sample-owner' }, 19);
    const result = await service.handle('bind-worktree-lease-child', {
      scopeKey, requestId, token: 'opaque-token', childPid: 1,
    }, 19);
    expect(result).toMatchObject({ success: false, code: 'ADMISSION_FAILED' });
  });

  it('binds-the-stopped-destructive-child-before-the-span-can-resume', async () => {
    const store = new MemoryStore();
    const live = new Set(['777:holder-start', '888:child-start']);
    const arbiter = new WorktreeLeaseArbiter({
      persistence: store,
      observeIdentity: record => live.has(`${record.pid}:${record.processStartIdentity}`)
        ? 'matching-live' : 'dead-or-reused',
      createToken: () => 'opaque-token',
    });
    const service = new WorktreeLeaseIpcService({
      arbiter,
      measurePeer: async () => ({ pid: 777, platform: 'linux', processStartIdentity: 'holder-start' }),
      measureProcess: () => ({ pid: 888, platform: 'linux', processStartIdentity: 'child-start' }),
      isDescendant: () => true,
    });
    expect((await service.handle('acquire-worktree-lease', { scopeKey, requestId, owner: 'sample-owner' }, 19)).success).toBe(true);
    expect((await service.handle('bind-worktree-lease-child', {
      scopeKey, requestId, token: 'opaque-token', childPid: 888,
    }, 19)).success).toBe(true);
    expect(store.record?.destructiveChild).toEqual({
      pid: 888, platform: 'linux', processStartIdentity: 'child-start',
    });

    live.delete('777:holder-start');
    expect(arbiter.state(scopeKey)).toMatchObject({
      kind: 'held-unknown', reason: 'destructive-child-live',
    });
  });

  it('production-runtime-exposes-no-admission-before-rebuild', () => {
    const root = mkdtempSync(join(tmpdir(), 'lease-runtime-gate-'));
    try {
      let gatedResult: ReturnType<WorktreeLeaseArbiter['acquire']> | undefined;
      createWorktreeLeaseRuntime({
        ctxRoot: root,
        nativeHelperPath: '/usr/bin/true',
        observeReconstructionGate(arbiter) {
          gatedResult = arbiter.acquire({
            scopeKey,
            requestId,
            owner: 'internal-writer',
            peer: measurePeerCredentials(19, {
              readPeerCredentials: () => ({ pid: 777, platform: 'linux' }),
            }, { readStartIdentity: () => 'boot:internal' }),
          });
        },
      });
      expect(gatedResult).toEqual({ kind: 'refused', reason: 'UNKNOWN' });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('arbiter-rebuilds-persisted-scopes-before-any-admission-opens', async () => {
    const events: string[] = [];
    const store = new MemoryStore();
    store.load = () => { events.push('reconstruct'); return undefined; };
    const arbiter = new WorktreeLeaseArbiter({
      persistence: store,
      observeIdentity: () => 'matching-live',
      createToken: () => 'opaque-token',
      admissionInitiallyClosed: true,
    });
    const service = new WorktreeLeaseIpcService({
      arbiter,
      measurePeer: async () => {
        events.push('admission-peer-measurement');
        return { pid: 777, platform: 'linux', processStartIdentity: 'boot:real-start' };
      },
    });

    const closedResponse = await service.handle('acquire-worktree-lease', {
      scopeKey, requestId, owner: 'sample-owner',
    }, 19);
    const internal = new InternalWorktreeWriterLease({
      scopeKey,
      arbiter,
      peer: () => ({ pid: 778, platform: 'linux', processStartIdentity: 'boot:internal' }),
      createRequest: () => ({
        loadOrCreate: () => '00000000-0000-4000-8000-000000000002',
        removeAfterRelease: () => undefined,
      }) as unknown as DurableLeaseRequest,
    });
    expect(closedResponse).toMatchObject({ success: false, error: 'UNKNOWN' });
    expect(internal.acquire('alpha')).toBe(false);

    arbiter.rebuildPersistedScopes([scopeKey]);
    const response = await service.handle('acquire-worktree-lease', {
      scopeKey, requestId, owner: 'sample-owner',
    }, 19);

    expect(response.success).toBe(true);
    expect(events).toEqual([
      'admission-peer-measurement',
      'reconstruct',
      'admission-peer-measurement',
      'reconstruct',
    ]);
  });

  it('same-request-lost-grant-recovers-the-exact-lease-without-publication', async () => {
    const events: string[] = [];
    const store = new MemoryStore();
    store.record = {
      scopeKey,
      requestId,
      token: 'exact-token',
      owner: 'sample-owner',
      pid: 777,
      platform: 'linux',
      processStartIdentity: 'boot:real-start',
      grantedAtMs: 1,
    };
    const publish = vi.spyOn(store, 'publish');
    store.load = () => { events.push('reconstruct'); return store.record; };
    const arbiter = new WorktreeLeaseArbiter({
      persistence: store,
      observeIdentity: () => 'matching-live',
      createToken: () => 'second-token',
    });
    arbiter.closeForReconstruction();
    arbiter.rebuildPersistedScopes([scopeKey]);
    const service = new WorktreeLeaseIpcService({
      arbiter,
      measurePeer: async () => {
        events.push('admission-peer-measurement');
        return { pid: 777, platform: 'linux', processStartIdentity: 'boot:real-start' };
      },
    });

    expect(await service.handle('acquire-worktree-lease', {
      scopeKey, requestId, owner: 'sample-owner',
    }, 19)).toEqual({
      success: true,
      data: { kind: 'granted', token: 'exact-token', recovered: true },
    });
    expect(publish).not.toHaveBeenCalled();
    expect(events).toEqual(['reconstruct', 'admission-peer-measurement', 'reconstruct']);
  });

  it('live-holder-refuses-a-distinct-contender-without-reclaim', async () => {
    const events: string[] = [];
    const store = new MemoryStore();
    store.record = {
      scopeKey,
      requestId,
      token: 'holder-token',
      owner: 'holder',
      pid: 700,
      platform: 'linux',
      processStartIdentity: 'boot:holder',
      grantedAtMs: 1,
    };
    store.load = () => { events.push('reconstruct-holder'); return store.record; };
    const arbiter = new WorktreeLeaseArbiter({
      persistence: store,
      observeIdentity: () => { events.push('observe-holder'); return 'matching-live'; },
    });
    arbiter.closeForReconstruction();
    arbiter.rebuildPersistedScopes([scopeKey]);
    const service = new WorktreeLeaseIpcService({
      arbiter,
      measurePeer: async () => {
        events.push('measure-contender');
        return { pid: 701, platform: 'linux', processStartIdentity: 'boot:contender' };
      },
    });
    expect(events).toEqual(['reconstruct-holder', 'observe-holder']);
    expect(await service.handle('acquire-worktree-lease', {
      scopeKey,
      requestId: '00000000-0000-4000-8000-000000000002',
      owner: 'contender',
    }, 19)).toMatchObject({ success: false, data: { kind: 'refused', reason: 'LIVE_HELD' } });
    expect(store.record?.token).toBe('holder-token');
  });

  it('uses the accepted socket measurement and ignores caller-asserted identity', async () => {
    const store = new MemoryStore();
    const arbiter = new WorktreeLeaseArbiter({
      persistence: store,
      observeIdentity: () => 'matching-live',
      createToken: () => 'opaque-token',
    });
    const measurePeer = vi.fn(async () => ({
      pid: 777,
      platform: 'linux' as const,
      processStartIdentity: 'boot:real-start',
    }));
    const service = new WorktreeLeaseIpcService({ arbiter, measurePeer });

    const response = await service.handle('acquire-worktree-lease', {
      scopeKey,
      requestId,
      owner: 'sample-owner',
      pid: 1,
      processStartIdentity: 'forged',
    }, 19);

    expect(measurePeer).toHaveBeenCalledWith(19);
    expect(response).toEqual({ success: true, data: { kind: 'granted', token: 'opaque-token', recovered: false } });
    expect(store.record).toMatchObject({ pid: 777, processStartIdentity: 'boot:real-start' });
  });

  it('routes capability release without accepting a caller identity override', async () => {
    const store = new MemoryStore();
    const arbiter = new WorktreeLeaseArbiter({
      persistence: store,
      observeIdentity: () => 'matching-live',
      createToken: () => 'opaque-token',
    });
    const service = new WorktreeLeaseIpcService({
      arbiter,
      measurePeer: async () => ({ pid: 777, platform: 'linux', processStartIdentity: 'boot:real-start' }),
    });
    await service.handle('acquire-worktree-lease', { scopeKey, requestId, owner: 'sample-owner' }, 19);

    expect(await service.handle('release-worktree-lease', {
      scopeKey,
      requestId,
      token: 'opaque-token',
      pid: 1,
    }, 19)).toEqual({
      success: true,
      data: { kind: 'released', alreadyAbsent: false },
    });
  });

  it('checks the exact live capability before a protected child acts', async () => {
    const arbiter = new WorktreeLeaseArbiter({
      persistence: new MemoryStore(),
      observeIdentity: () => 'matching-live',
      createToken: () => 'opaque-token',
    });
    const service = new WorktreeLeaseIpcService({
      arbiter,
      measurePeer: async () => ({ pid: 777, platform: 'linux', processStartIdentity: 'boot:real-start' }),
    });
    await service.handle('acquire-worktree-lease', { scopeKey, requestId, owner: 'sample-owner' }, 19);
    expect(await service.handle('check-worktree-lease', { scopeKey, requestId, token: 'opaque-token' }, 20))
      .toEqual({ success: true, data: { kind: 'held' } });
    expect((await service.handle('check-worktree-lease', { scopeKey, requestId, token: 'wrong' }, 20)).success)
      .toBe(false);
  });

  it('fails closed when peer measurement is unavailable', async () => {
    const arbiter = new WorktreeLeaseArbiter({
      persistence: new MemoryStore(),
      observeIdentity: () => 'unknown',
    });
    const service = new WorktreeLeaseIpcService({
      arbiter,
      measurePeer: async () => { throw new Error('LOCAL_PEERPID unavailable'); },
    });
    expect(await service.handle('acquire-worktree-lease', {
      scopeKey, requestId, owner: 'sample-owner',
    }, 19)).toEqual({
      success: false,
      error: 'peer-identity-unknown',
      code: 'ADMISSION_FAILED',
    });
  });
});
