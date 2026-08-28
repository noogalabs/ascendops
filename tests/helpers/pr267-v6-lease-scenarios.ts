import { measurePeerCredentials } from '../../src/daemon/peer-credentials';
import {
  WorktreeLeaseArbiter,
  type LeasePersistence,
  type LeaseRecord,
} from '../../src/daemon/worktree-lease-arbiter';

export type Pr267LeaseScenarioName =
  | 'native-peer-is-measured-not-asserted'
  | 'supervisor-death-enters-stale-reclaim'
  | 'lost-grant-idempotent-recovery'
  | 'daemon-restart-reconstructs-lease'
  | 'lease-scope-binds-machine-and-reaper'
  | 'request-id-is-durable-before-acquire'
  | 'same-request-recovery-precedes-peer-refusal'
  | 'release-absent-is-same-request-idempotent'
  | 'reconstruction-enumerates-safe-states'
  | 'concurrent-acquire-serializes-one-grant'
  | 'same-id-different-owner-cannot-recover';

const requestA = '00000000-0000-4000-8000-000000000001';
const requestB = '00000000-0000-4000-8000-000000000002';
const scopeA = 'repo:/canonical/tree/a';
const scopeB = 'repo:/canonical/tree/b';

class MemoryPersistence implements LeasePersistence {
  readonly records = new Map<string, LeaseRecord>();
  readonly events: string[] = [];

  withScopeLock<T>(_scopeKey: string, operation: () => T): T {
    return operation();
  }

  publish(record: LeaseRecord): void {
    this.events.push(`publish:${record.requestId}`);
    this.records.set(record.scopeKey, record);
  }

  remove(record: LeaseRecord): void {
    this.events.push(`remove:${record.requestId}`);
    this.records.delete(record.scopeKey);
  }

  load(scopeKey: string): LeaseRecord | undefined {
    return this.records.get(scopeKey);
  }
}

function peer(pid: number, start = `start-${pid}`) {
  return measurePeerCredentials(9, {
    readPeerCredentials: () => ({ pid, platform: 'linux' }),
  }, {
    readStartIdentity: () => start,
  });
}

function fixture() {
  const persistence = new MemoryPersistence();
  const live = new Set<string>();
  const arbiter = new WorktreeLeaseArbiter({
    persistence,
    createToken: () => `token-${persistence.events.length + 1}`,
    now: () => 10,
    observeIdentity: lease => live.has(`${lease.pid}:${lease.processStartIdentity}`)
      ? 'matching-live'
      : 'dead-or-reused',
  });
  return { persistence, live, arbiter };
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

export async function runPr267LeaseScenario(scenario: Pr267LeaseScenarioName) {
  const f = fixture();
  const a = peer(101);
  f.live.add('101:start-101');

  if (scenario === 'native-peer-is-measured-not-asserted') {
    const forged = { pid: 101, platform: 'linux', processStartIdentity: 'start-101' };
    const result = f.arbiter.acquire({ scopeKey: scopeA, requestId: requestA, owner: 'reaper', peer: forged as never });
    assert(result.kind === 'refused' && result.reason === 'INVALID_REQUEST', 'caller assertions were trusted');
  } else if (scenario === 'supervisor-death-enters-stale-reclaim') {
    const grant = f.arbiter.acquire({ scopeKey: scopeA, requestId: requestA, owner: 'supervisor', peer: a });
    assert(grant.kind === 'granted', 'supervisor did not acquire');
    const child = peer(303);
    f.live.add('303:start-303');
    const bound = f.arbiter.bindDestructiveChild(scopeA, requestA, grant.token, a, child);
    assert(bound.kind === 'bound', 'destructive child was not durably bound');
    f.live.delete('101:start-101');
    const restarted = new WorktreeLeaseArbiter({
      persistence: f.persistence,
      observeIdentity: record => f.live.has(`${record.pid}:${record.processStartIdentity}`)
        ? 'matching-live' : 'dead-or-reused',
    });
    assert(restarted.reconstruct(scopeA).kind === 'held-unknown', 'live destructive child did not retain custody');
    const refused = restarted.acquire({ scopeKey: scopeA, requestId: requestB, owner: 'next-supervisor', peer: peer(202) });
    assert(refused.kind === 'refused', 'contender reclaimed while destructive child was live');
    f.live.delete('303:start-303');
    const reclaimed = restarted.acquire({ scopeKey: scopeA, requestId: requestB, owner: 'next-supervisor', peer: peer(202) });
    assert(reclaimed.kind === 'granted', 'stale supervisor lease was not reclaimed');
  } else if (scenario === 'lost-grant-idempotent-recovery' || scenario === 'same-request-recovery-precedes-peer-refusal') {
    const first = f.arbiter.acquire({ scopeKey: scopeA, requestId: requestA, owner: 'supervisor', peer: a });
    const recovered = f.arbiter.acquire({ scopeKey: scopeA, requestId: requestA, owner: 'supervisor', peer: a });
    assert(first.kind === 'granted' && recovered.kind === 'granted', 'grant was not recoverable');
    assert(first.token === recovered.token && recovered.recovered, 'recovery allocated another token');
    assert(f.persistence.events.filter(event => event.startsWith('publish:')).length === 1, 'recovery republished');
  } else if (scenario === 'daemon-restart-reconstructs-lease') {
    f.arbiter.acquire({ scopeKey: scopeA, requestId: requestA, owner: 'supervisor', peer: a });
    const restarted = new WorktreeLeaseArbiter({ persistence: f.persistence, observeIdentity: () => 'matching-live' });
    assert(restarted.reconstruct(scopeA).kind === 'live-held', 'live lease was forgotten at restart');
  } else if (scenario === 'lease-scope-binds-machine-and-reaper') {
    const one = f.arbiter.acquire({ scopeKey: scopeA, requestId: requestA, owner: 'machine', peer: a });
    const two = f.arbiter.acquire({ scopeKey: scopeB, requestId: requestB, owner: 'reaper', peer: peer(202) });
    assert(one.kind === 'granted' && two.kind === 'granted', 'canonical scopes were conflated');
    assert(f.persistence.records.get(scopeA)?.scopeKey === scopeA, 'scope was not persisted');
  } else if (scenario === 'request-id-is-durable-before-acquire') {
    const invalid = f.arbiter.acquire({ scopeKey: scopeA, requestId: '', owner: 'supervisor', peer: a });
    assert(invalid.kind === 'refused' && f.persistence.events.length === 0, 'missing durable UUID reached publication');
  } else if (scenario === 'release-absent-is-same-request-idempotent') {
    const grant = f.arbiter.acquire({ scopeKey: scopeA, requestId: requestA, owner: 'supervisor', peer: a });
    assert(grant.kind === 'granted', 'lease not granted');
    const first = f.arbiter.release(scopeA, requestA, grant.token);
    const repeat = f.arbiter.release(scopeA, requestA, grant.token);
    const stranger = f.arbiter.release(scopeA, requestB, grant.token);
    assert(first.kind === 'released' && !first.alreadyAbsent, 'first release failed');
    assert(repeat.kind === 'released' && repeat.alreadyAbsent, 'same request release was not idempotent');
    assert(stranger.kind === 'refused', 'different request released absent state');
  } else if (scenario === 'reconstruction-enumerates-safe-states') {
    assert(f.arbiter.reconstruct(scopeA).kind === 'absent', 'absence was not explicit');
    f.arbiter.acquire({ scopeKey: scopeA, requestId: requestA, owner: 'supervisor', peer: a });
    const live = new WorktreeLeaseArbiter({ persistence: f.persistence, observeIdentity: () => 'matching-live' });
    const stale = new WorktreeLeaseArbiter({ persistence: f.persistence, observeIdentity: () => 'dead-or-reused' });
    const unknown = new WorktreeLeaseArbiter({ persistence: f.persistence, observeIdentity: () => 'unknown' });
    assert(live.reconstruct(scopeA).kind === 'live-held', 'live state missing');
    assert(stale.reconstruct(scopeA).kind === 'stale', 'stale state missing');
    assert(unknown.reconstruct(scopeA).kind === 'held-unknown', 'unknown state missing');
  } else if (scenario === 'same-id-different-owner-cannot-recover') {
    const first = f.arbiter.acquire({ scopeKey: scopeA, requestId: requestA, owner: 'alpha', peer: a });
    const wrongOwner = f.arbiter.acquire({ scopeKey: scopeA, requestId: requestA, owner: 'beta', peer: a });
    assert(first.kind === 'granted', 'first owner was not granted');
    assert(wrongOwner.kind === 'refused' && wrongOwner.reason === 'LIVE_HELD', 'owner was omitted from requester identity');
  } else if (scenario === 'concurrent-acquire-serializes-one-grant') {
    const [one, two] = await Promise.all([
      Promise.resolve().then(() => f.arbiter.acquire({ scopeKey: scopeA, requestId: requestA, owner: 'one', peer: a })),
      Promise.resolve().then(() => f.arbiter.acquire({ scopeKey: scopeA, requestId: requestB, owner: 'two', peer: peer(202) })),
    ]);
    assert([one, two].filter(result => result.kind === 'granted').length === 1, 'multiple concurrent grants escaped');
    assert(f.persistence.events.filter(event => event.startsWith('publish:')).length === 1, 'multiple leases published');
  } else {
    const exhaustive: never = scenario;
    throw new Error(`unhandled lease scenario ${exhaustive}`);
  }
  return { scenario, observed: true as const };
}
