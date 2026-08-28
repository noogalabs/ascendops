import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNodeDurableFs } from '../../../src/daemon/node-durable-state';
import { DurableWorktreeLeaseStore } from '../../../src/daemon/durable-worktree-lease-store';
import { WorktreeLeaseArbiter, type LeaseRecord } from '../../../src/daemon/worktree-lease-arbiter';
import { measurePeerCredentials } from '../../../src/daemon/peer-credentials';
import { WorktreeLeaseIpcService } from '../../../src/daemon/worktree-lease-ipc';

const dirs: string[] = [];
afterEach(() => {
  for (const path of dirs.splice(0)) rmSync(path, { recursive: true, force: true });
});

const record: LeaseRecord = {
  scopeKey: 'repo:/canonical/repo',
  requestId: '00000000-0000-4000-8000-000000000001',
  token: 'opaque-token',
  owner: 'sample-owner',
  pid: 101,
  platform: 'linux',
  processStartIdentity: 'boot:start',
  grantedAtMs: 10,
};

describe('durable worktree lease store', () => {
  it('scope-lock-publishes-measured-holder-identity-before-entering-the-operation', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cortext-lease-store-lock-'));
    dirs.push(dir);
    const store = new DurableWorktreeLeaseStore({
      directory: dir,
      platform: 'linux',
      fs: createNodeDurableFs({ fullFsync: () => { throw new Error('not macOS'); } }),
      createAttemptNonce: () => 'identity-publication',
      lockOwner: () => ({ pid: 202, platform: 'linux', processStartIdentity: 'owner:start', scopeKey: '', acquiredAtMs: 2 }),
    });
    const lockPath = `${store.pathForScope(record.scopeKey)}.lock`;

    store.withScopeLock(record.scopeKey, () => {
      expect(JSON.parse(readFileSync(join(lockPath, 'owner.json'), 'utf8'))).toMatchObject({
        pid: 202, processStartIdentity: 'owner:start', scopeKey: record.scopeKey,
      });
    });
  });

  it('dead-lock-holder-is-reobserved-and-reclaimed-before-the-scope-operation', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cortext-lease-store-lock-'));
    dirs.push(dir);
    const store = new DurableWorktreeLeaseStore({
      directory: dir,
      platform: 'linux',
      fs: createNodeDurableFs({ fullFsync: () => { throw new Error('not macOS'); } }),
      createAttemptNonce: () => 'dead-reclaim',
      lockOwner: () => ({ pid: 202, platform: 'linux', processStartIdentity: 'new:start', scopeKey: '', acquiredAtMs: 2 }),
      observeLockOwner: owner => owner.pid === 101 ? 'dead-or-reused' : 'matching-live',
    });
    const lockPath = `${store.pathForScope(record.scopeKey)}.lock`;
    mkdirSync(lockPath);
    writeFileSync(join(lockPath, 'owner.json'), JSON.stringify({
      pid: 101, platform: 'linux', processStartIdentity: 'old:start', scopeKey: record.scopeKey, acquiredAtMs: 1,
    }));

    expect(store.withScopeLock(record.scopeKey, () => 'reclaimed')).toBe('reclaimed');
    expect(existsSync(lockPath)).toBe(false);
  });

  it('live-lock-holder-is-reobserved-and-refused', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cortext-lease-store-lock-'));
    dirs.push(dir);
    const store = new DurableWorktreeLeaseStore({
      directory: dir,
      platform: 'linux',
      fs: createNodeDurableFs({ fullFsync: () => { throw new Error('not macOS'); } }),
      createAttemptNonce: () => 'live-refuse',
      observeLockOwner: () => 'matching-live',
    });
    const lockPath = `${store.pathForScope(record.scopeKey)}.lock`;
    mkdirSync(lockPath);
    writeFileSync(join(lockPath, 'owner.json'), JSON.stringify({
      pid: 101, platform: 'linux', processStartIdentity: 'old:start', scopeKey: record.scopeKey, acquiredAtMs: 1,
    }));

    expect(() => store.withScopeLock(record.scopeKey, () => 'wrong')).toThrow('lease-scope-lock-held');
  });

  it('stale-lock-reclaim-is-conditional-on-the-exact-owner-that-was-observed-dead', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cortext-lease-store-lock-'));
    dirs.push(dir);
    let lockPath = '';
    const replacement = {
      pid: 303, platform: 'linux' as const, processStartIdentity: 'winner:start',
      scopeKey: record.scopeKey, acquiredAtMs: 3,
    };
    const store = new DurableWorktreeLeaseStore({
      directory: dir,
      platform: 'linux',
      fs: createNodeDurableFs({ fullFsync: () => { throw new Error('not macOS'); } }),
      createAttemptNonce: () => 'loser',
      observeLockOwner: () => {
        rmSync(lockPath, { recursive: true, force: true });
        mkdirSync(lockPath);
        writeFileSync(join(lockPath, 'owner.json'), JSON.stringify(replacement));
        return 'dead-or-reused';
      },
    });
    lockPath = `${store.pathForScope(record.scopeKey)}.lock`;
    mkdirSync(lockPath);
    writeFileSync(join(lockPath, 'owner.json'), JSON.stringify({
      pid: 101, platform: 'linux', processStartIdentity: 'stale:start',
      scopeKey: record.scopeKey, acquiredAtMs: 1,
    }));

    expect(() => store.withScopeLock(record.scopeKey, () => 'double-grant'))
      .toThrow('lease-scope-lock-reclaim-lost');
    expect(JSON.parse(readFileSync(join(lockPath, 'owner.json'), 'utf8'))).toEqual(replacement);
  });

  it('unreadable-lock-holder-identity-is-unknown-and-refused', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cortext-lease-store-lock-'));
    dirs.push(dir);
    const store = new DurableWorktreeLeaseStore({
      directory: dir,
      platform: 'linux',
      fs: createNodeDurableFs({ fullFsync: () => { throw new Error('not macOS'); } }),
      createAttemptNonce: () => 'unknown-refuse',
      observeLockOwner: () => 'dead-or-reused',
    });
    mkdirSync(`${store.pathForScope(record.scopeKey)}.lock`);

    expect(() => store.withScopeLock(record.scopeKey, () => 'wrong'))
      .toThrow('lease-scope-lock-held-unknown');
  });

  it('reconstructs a durable grant and embeds request attribution in temp names', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cortext-lease-store-'));
    dirs.push(dir);
    const store = new DurableWorktreeLeaseStore({
      directory: dir,
      platform: 'linux',
      fs: createNodeDurableFs({ fullFsync: () => { throw new Error('not macOS'); } }),
      createAttemptNonce: () => 'attempt-a',
    });

    store.publish(record);
    expect(store.load(record.scopeKey)).toEqual(record);
    expect(store.listPersistedScopes()).toEqual([record.scopeKey]);
    expect(store.lastTempPath()).toContain(`${record.requestId}.attempt-a`);
  });

  it('persists released-request identity across daemon reconstruction', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cortext-lease-store-'));
    dirs.push(dir);
    const options = {
      directory: dir,
      platform: 'linux' as const,
      fs: createNodeDurableFs({ fullFsync: () => { throw new Error('not macOS'); } }),
      createAttemptNonce: () => 'attempt-b',
    };
    const store = new DurableWorktreeLeaseStore(options);
    store.publish(record);
    store.remove(record);

    const restarted = new DurableWorktreeLeaseStore(options);
    expect(restarted.load(record.scopeKey)).toBeUndefined();
    expect(restarted.loadReleasedRequest(record.scopeKey)).toBe(record.requestId);
  });

  it('keeps same-request release idempotent after daemon restart', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cortext-lease-store-'));
    dirs.push(dir);
    const store = new DurableWorktreeLeaseStore({
      directory: dir,
      platform: 'linux',
      fs: createNodeDurableFs({ fullFsync: () => { throw new Error('not macOS'); } }),
      createAttemptNonce: () => `attempt-${Math.random().toString(16).slice(2)}`,
    });
    const peer = measurePeerCredentials(3, {
      readPeerCredentials: () => ({ pid: record.pid, platform: 'linux' }),
    }, {
      readStartIdentity: () => record.processStartIdentity,
    });
    const first = new WorktreeLeaseArbiter({
      persistence: store,
      createToken: () => record.token,
      observeIdentity: () => 'matching-live',
    });
    const grant = first.acquire({
      scopeKey: record.scopeKey,
      requestId: record.requestId,
      owner: record.owner,
      peer,
    });
    expect(grant.kind).toBe('granted');
    expect(first.release(record.scopeKey, record.requestId, record.token)).toEqual({
      kind: 'released', alreadyAbsent: false,
    });

    const restarted = new WorktreeLeaseArbiter({
      persistence: new DurableWorktreeLeaseStore({
        directory: dir,
        platform: 'linux',
        fs: createNodeDurableFs({ fullFsync: () => { throw new Error('not macOS'); } }),
        createAttemptNonce: () => 'restart-attempt',
      }),
      observeIdentity: () => 'unknown',
    });
    expect(restarted.release(record.scopeKey, record.requestId, record.token)).toEqual({
      kind: 'released', alreadyAbsent: true,
    });
  });

  it('fails closed on malformed persisted state', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cortext-lease-store-'));
    dirs.push(dir);
    const store = new DurableWorktreeLeaseStore({
      directory: dir,
      platform: 'linux',
      fs: createNodeDurableFs({ fullFsync: () => { throw new Error('not macOS'); } }),
      createAttemptNonce: () => 'attempt-c',
    });
    writeFileSync(store.pathForScope(record.scopeKey), '{not-json');
    expect(() => store.load(record.scopeKey)).toThrow('lease-state-malformed');
  });

  it('released-tombstones-are-durably-reaped-after-the-stated-bound', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cortext-lease-store-'));
    dirs.push(dir);
    const store = new DurableWorktreeLeaseStore({
      directory: dir,
      platform: 'linux',
      fs: createNodeDurableFs({ fullFsync: () => { throw new Error('not macOS'); } }),
      createAttemptNonce: () => 'bounded-reap',
    });
    store.publish(record);
    store.remove(record);
    const tombstone = store.pathForScope(record.scopeKey);
    utimesSync(tombstone, new Date(0), new Date(0));

    const restarted = new DurableWorktreeLeaseStore({
      directory: dir,
      platform: 'linux',
      fs: createNodeDurableFs({ fullFsync: () => { throw new Error('not macOS'); } }),
      createAttemptNonce: () => 'restart',
    });
    restarted.listPersistedScopes();
    expect(existsSync(tombstone)).toBe(false);
  });

  it('ambiguous-tombstone-is-unknown-never-absent', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cortext-lease-store-'));
    dirs.push(dir);
    const store = new DurableWorktreeLeaseStore({
      directory: dir,
      platform: 'linux',
      fs: createNodeDurableFs({ fullFsync: () => { throw new Error('not macOS'); } }),
      createAttemptNonce: () => 'ambiguous',
    });
    writeFileSync(join(dir, '.orphaned-release.tmp'), '{"version":1,"kind":"released"');
    const arbiter = new WorktreeLeaseArbiter({
      persistence: store,
      observeIdentity: () => 'matching-live',
      createToken: () => 'must-not-grant',
    });
    const peer = measurePeerCredentials(3, {
      readPeerCredentials: () => ({ pid: record.pid, platform: 'linux' }),
    }, { readStartIdentity: () => record.processStartIdentity });
    expect(arbiter.acquire({
      scopeKey: record.scopeKey, requestId: record.requestId, owner: record.owner, peer,
    })).toEqual({ kind: 'refused', reason: 'UNKNOWN' });
  });

  it('released-tombstone-is-published-before-admission-reopens', () => {
    let reentrant: ReturnType<WorktreeLeaseArbiter['acquire']> | undefined;
    let arbiter!: WorktreeLeaseArbiter;
    const persistence = {
      current: undefined as LeaseRecord | undefined,
      withScopeLock<T>(_scopeKey: string, operation: () => T): T { return operation(); },
      publish(value: LeaseRecord) { this.current = value; },
      remove() {
        reentrant = arbiter.acquire({
          scopeKey: record.scopeKey,
          requestId: '00000000-0000-4000-8000-000000000002',
          owner: 'contender',
          peer: measurePeerCredentials(4, {
            readPeerCredentials: () => ({ pid: 202, platform: 'linux' }),
          }, { readStartIdentity: () => 'contender:start' }),
        });
        this.current = undefined;
      },
      load() { return this.current; },
    };
    arbiter = new WorktreeLeaseArbiter({
      persistence,
      observeIdentity: () => 'matching-live',
      createToken: () => record.token,
    });
    const holder = measurePeerCredentials(3, {
      readPeerCredentials: () => ({ pid: record.pid, platform: 'linux' }),
    }, { readStartIdentity: () => record.processStartIdentity });
    expect(arbiter.acquire({
      scopeKey: record.scopeKey, requestId: record.requestId, owner: record.owner, peer: holder,
    }).kind).toBe('granted');
    expect(arbiter.release(record.scopeKey, record.requestId, record.token).kind).toBe('released');
    expect(reentrant).toEqual({ kind: 'refused', reason: 'UNKNOWN' });
  });

  it('released-tombstone-reconstructs-absent-not-live', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cortext-lease-store-'));
    dirs.push(dir);
    const options = {
      directory: dir,
      platform: 'linux' as const,
      fs: createNodeDurableFs({ fullFsync: () => { throw new Error('not macOS'); } }),
      createAttemptNonce: () => 'released-reconstruct',
    };
    const firstStore = new DurableWorktreeLeaseStore(options);
    firstStore.publish(record);
    firstStore.remove(record);
    let loads = 0;
    const restartedStore = new DurableWorktreeLeaseStore(options);
    const persistence = {
      publish: (value: LeaseRecord) => restartedStore.publish(value),
      remove: (value: LeaseRecord) => restartedStore.remove(value),
      load: (scope: string) => { loads += 1; return restartedStore.load(scope); },
      loadReleasedRequest: (scope: string) => restartedStore.loadReleasedRequest(scope),
    };
    const arbiter = new WorktreeLeaseArbiter({ persistence, observeIdentity: () => 'matching-live' });
    new WorktreeLeaseIpcService({
      arbiter,
      measurePeer: async () => ({ pid: 202, platform: 'linux', processStartIdentity: 'new:start' }),
    });
    expect(arbiter.state(record.scopeKey)).toEqual({ kind: 'absent' });
    expect(loads).toBe(1);
  });
});
