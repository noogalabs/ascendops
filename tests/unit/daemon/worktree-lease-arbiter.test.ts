import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  runPr267LeaseScenario,
  type Pr267LeaseScenarioName,
} from '../../helpers/pr267-v6-lease-scenarios';
import { measurePeerCredentials } from '../../../src/daemon/peer-credentials';
import { WorktreeLeaseArbiter, type LeaseRecord } from '../../../src/daemon/worktree-lease-arbiter';

describe('PR267 frozen-v6 pure lease arbiter', () => {
  it('every-mutator-requires-and-unconditionally-takes-the-scope-lock', () => {
    const source = readFileSync(new URL('../../../src/daemon/worktree-lease-arbiter.ts', import.meta.url), 'utf8');
    expect(source).toContain('withScopeLock<T>(scopeKey: string, operation: () => T): T;');
    expect(source).not.toContain('withScopeLock?<T>');
    expect(source).not.toContain('if (this.persistence.withScopeLock)');
    expect(source.match(/this\.persistence\.withScopeLock\(/g)).toHaveLength(3);
  });
  const scenarios: Pr267LeaseScenarioName[] = [
    'native-peer-is-measured-not-asserted',
    'supervisor-death-enters-stale-reclaim',
    'lost-grant-idempotent-recovery',
    'daemon-restart-reconstructs-lease',
    'lease-scope-binds-machine-and-reaper',
    'request-id-is-durable-before-acquire',
    'same-request-recovery-precedes-peer-refusal',
    'release-absent-is-same-request-idempotent',
    'reconstruction-enumerates-safe-states',
    'concurrent-acquire-serializes-one-grant',
    'same-id-different-owner-cannot-recover',
  ];

  for (const scenario of scenarios) {
    it(scenario, async () => {
      await expect(runPr267LeaseScenario(scenario)).resolves.toEqual({ scenario, observed: true });
    });
  }

  it('release-gate-refuses-a-live-bound-child-even-when-path-local-cleanup-is-removed', () => {
    let persisted: LeaseRecord | undefined;
    const arbiter = new WorktreeLeaseArbiter({
      persistence: {
        withScopeLock: (_scopeKey, operation) => operation(),
        publish: record => { persisted = record; },
        remove: () => { persisted = undefined; },
        load: () => persisted,
      },
      observeIdentity: record => record.pid === 42 ? 'matching-live' : 'matching-live',
      createToken: () => 'opaque-token',
    });
    const peer = measurePeerCredentials(9, {
      readPeerCredentials: () => ({ pid: 10, platform: 'linux' }),
    }, { readStartIdentity: () => 'kernel:10' })!;
    const requestId = '00000000-0000-4000-8000-000000000001';
    expect(arbiter.acquire({ scopeKey: 'repo:/canonical/repo', requestId, owner: 'test', peer }).kind).toBe('granted');
    expect(arbiter.bindDestructiveChild(
      'repo:/canonical/repo', requestId, 'opaque-token', peer,
      { pid: 42, platform: 'linux', processStartIdentity: 'kernel:42' },
    )).toEqual({ kind: 'bound' });

    expect(arbiter.release('repo:/canonical/repo', requestId, 'opaque-token')).toEqual({
      kind: 'refused', reason: 'UNKNOWN',
    });
    expect(persisted?.destructiveChild?.pid).toBe(42);
  });
});
