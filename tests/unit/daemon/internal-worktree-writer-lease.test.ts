import { describe, expect, it } from 'vitest';
import { InternalWorktreeWriterLease } from '../../../src/daemon/internal-worktree-writer-lease';
import { acceptNativeMeasuredPeer } from '../../../src/daemon/peer-credentials';
import { WorktreeLeaseArbiter, type LeaseRecord } from '../../../src/daemon/worktree-lease-arbiter';
import type { DurableLeaseRequest } from '../../../src/daemon/durable-lease-request';

describe('internal agent-start repository writer lease', () => {
  it('serializes same-daemon writers by owner and releases the durable request', () => {
    let record: LeaseRecord | undefined;
    const removed: string[] = [];
    const arbiter = new WorktreeLeaseArbiter({
      persistence: {
        withScopeLock: (_scopeKey, operation) => operation(),
        publish: value => { record = value; },
        remove: () => { record = undefined; },
        load: () => record,
      },
      observeIdentity: () => 'matching-live',
      createToken: () => 'token',
    });
    const ids = [
      '00000000-0000-4000-8000-000000000001',
      '00000000-0000-4000-8000-000000000002',
    ];
    const lease = new InternalWorktreeWriterLease({
      scopeKey: 'repo:/canonical',
      arbiter,
      peer: () => acceptNativeMeasuredPeer({ pid: 7, platform: 'linux', processStartIdentity: 'boot:7' }),
      createRequest: agent => ({
        loadOrCreate: () => ids[agent === 'alpha' ? 0 : 1],
        removeAfterRelease: () => { removed.push(agent); },
      }) as DurableLeaseRequest,
    });
    expect(lease.acquire('alpha')).toBe(true);
    expect(lease.acquire('beta')).toBe(false);
    expect(record?.owner).toBe('daemon-agent-start:alpha');
    lease.release('alpha');
    expect(removed).toEqual(['alpha']);
    expect(lease.acquire('beta')).toBe(true);
  });
});
