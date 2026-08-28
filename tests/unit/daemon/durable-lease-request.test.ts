import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DurableLeaseRequest } from '../../../src/daemon/durable-lease-request';
import { createNodeDurableFs } from '../../../src/daemon/node-durable-state';

const dirs: string[] = [];
afterEach(() => {
  for (const path of dirs.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe('durable lease requester identity', () => {
  it('persists before acquire and reuses the same request ID after requester restart', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cortext-requester-'));
    dirs.push(dir);
    const options = {
      directory: dir,
      scopeKey: 'repo:/canonical/repo',
      owner: 'sample-owner',
      platform: 'linux' as const,
      fs: createNodeDurableFs({ fullFsync: () => { throw new Error('not macOS'); } }),
      createRequestId: () => '00000000-0000-4000-8000-000000000001',
      createAttemptNonce: () => 'attempt-a',
    };
    const first = new DurableLeaseRequest(options);
    expect(first.loadOrCreate()).toBe('00000000-0000-4000-8000-000000000001');
    expect(first.lastTempPath()).toContain('00000000-0000-4000-8000-000000000001.attempt-a');

    const restarted = new DurableLeaseRequest({
      ...options,
      createRequestId: () => '00000000-0000-4000-8000-000000000099',
      createAttemptNonce: () => 'attempt-b',
    });
    expect(restarted.loadOrCreate()).toBe('00000000-0000-4000-8000-000000000001');
  });

  it('durably removes request evidence only after successful release', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cortext-requester-'));
    dirs.push(dir);
    const request = new DurableLeaseRequest({
      directory: dir,
      scopeKey: 'repo:/canonical/repo',
      owner: 'sample-owner',
      platform: 'linux',
      fs: createNodeDurableFs({ fullFsync: () => { throw new Error('not macOS'); } }),
      createRequestId: () => '00000000-0000-4000-8000-000000000001',
      createAttemptNonce: () => 'attempt-a',
    });
    request.loadOrCreate();
    request.removeAfterRelease();
    expect(request.exists()).toBe(false);
  });
});
