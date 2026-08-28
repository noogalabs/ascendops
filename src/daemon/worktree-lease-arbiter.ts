import { randomUUID } from 'node:crypto';
import {
  isMeasuredPeerCredentials,
  type MeasuredPeerCredentials,
} from './peer-credentials.js';

export type LeaseRecord = Readonly<{
  scopeKey: string;
  requestId: string;
  token: string;
  owner: string;
  pid: number;
  processStartIdentity: string;
  platform: 'linux' | 'darwin';
  grantedAtMs: number;
  destructiveChild?: Readonly<{
    pid: number;
    processStartIdentity: string;
    platform: 'linux' | 'darwin';
  }>;
}>;

export type ReconstructedLeaseState =
  | { kind: 'absent' }
  | { kind: 'live-held'; lease: LeaseRecord }
  | { kind: 'stale'; lease: LeaseRecord }
  | { kind: 'held-unknown'; reason: string; lease?: LeaseRecord };

export type LeasePersistence = {
  /** Must complete temp-write, file-sync, rename and parent-sync before return. */
  publish(record: LeaseRecord): void;
  /** Must unlink and parent-sync before return. */
  remove(record: LeaseRecord): void;
  load(scopeKey: string): LeaseRecord | undefined;
  loadReleasedRequest?(scopeKey: string): string | undefined;
  /** Interprocess exclusion for observe -> decide -> publish on one repository scope. */
  withScopeLock<T>(scopeKey: string, operation: () => T): T;
};

export type IdentityObservation = 'matching-live' | 'dead-or-reused' | 'unknown';

export type LeaseArbiterOptions = {
  persistence: LeasePersistence;
  observeIdentity(record: LeaseRecord): IdentityObservation;
  createToken?: () => string;
  now?: () => number;
  /** Production starts closed; tests may retain the legacy eager-open default. */
  admissionInitiallyClosed?: boolean;
};

export type AcquireLeaseRequest = Readonly<{
  scopeKey: string;
  requestId: string;
  owner: string;
  peer: MeasuredPeerCredentials;
}>;

export type AcquireLeaseResult =
  | { kind: 'granted'; token: string; recovered: boolean }
  | { kind: 'refused'; reason: 'LIVE_HELD' | 'UNKNOWN' | 'INVALID_REQUEST' };

export type ReleaseLeaseResult =
  | { kind: 'released'; alreadyAbsent: boolean }
  | { kind: 'refused'; reason: 'CAPABILITY_MISMATCH' | 'UNKNOWN' | 'INVALID_REQUEST' };

export type CheckLeaseResult =
  | { kind: 'held' }
  | { kind: 'refused'; reason: 'CAPABILITY_MISMATCH' | 'UNKNOWN' | 'INVALID_REQUEST' };

export type BindLeaseChildResult =
  | { kind: 'bound' }
  | { kind: 'refused'; reason: 'CAPABILITY_MISMATCH' | 'UNKNOWN' | 'INVALID_REQUEST' };

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function validScopeKey(value: string): boolean {
  return value.length > 0 && value.length <= 4096 && value === value.trim() && value.includes(':');
}

/** Pure serialized authority; all persistence calls are intentionally synchronous. */
export class WorktreeLeaseArbiter {
  /**
   * Declared repository-global authority, keyed by canonical repository scope.
   * The daemon arbiter owns both maps. A live holder has no age bound and causes
   * explicit LIVE_HELD refusal; unknown identity fails closed as UNKNOWN. Dead
   * or reused holders are recoverable only after fresh identity observation.
   * releasedRequests is bounded to the latest durable request ID per scope and
   * exists solely to make token-checked release/retry idempotent.
   */
  private readonly states = new Map<string, ReconstructedLeaseState>();
  private readonly releasedRequests = new Map<string, string>();
  private readonly persistence: LeasePersistence;
  private readonly observeIdentity: (record: LeaseRecord) => IdentityObservation;
  private readonly createToken: () => string;
  private readonly now: () => number;
  private admissionState: 'closed' | 'reconstructing' | 'open';

  constructor(options: LeaseArbiterOptions) {
    this.persistence = options.persistence;
    this.observeIdentity = options.observeIdentity;
    this.createToken = options.createToken ?? randomUUID;
    this.now = options.now ?? Date.now;
    this.admissionState = options.admissionInitiallyClosed ? 'closed' : 'open';
  }

  /**
   * Shared gate for every IPC and daemon-internal admission surface. The gate,
   * not construction order, is the contract: a failed rebuild never opens.
   */
  rebuildPersistedScopes(scopeKeys: readonly string[]): void {
    this.admissionState = 'reconstructing';
    for (const scopeKey of scopeKeys) this.reconstruct(scopeKey);
    this.admissionState = 'open';
  }

  closeForReconstruction(): void {
    this.admissionState = 'reconstructing';
  }

  openAfterReconstruction(): void {
    if (this.admissionState !== 'reconstructing') {
      throw new Error('lease admission can open only after reconstruction starts');
    }
    this.admissionState = 'open';
  }

  reconstruct(scopeKey: string): ReconstructedLeaseState {
    if (!validScopeKey(scopeKey)) return { kind: 'held-unknown', reason: 'invalid-scope-key' };
    let lease: LeaseRecord | undefined;
    try {
      lease = this.persistence.load(scopeKey);
    } catch {
      const state = { kind: 'held-unknown', reason: 'persisted-state-unreadable' } as const;
      this.states.set(scopeKey, state);
      return state;
    }
    if (!lease) {
      const releasedRequest = this.persistence.loadReleasedRequest?.(scopeKey);
      if (releasedRequest) this.releasedRequests.set(scopeKey, releasedRequest);
      const state = { kind: 'absent' } as const;
      this.states.set(scopeKey, state);
      return state;
    }
    if (lease.scopeKey !== scopeKey || !UUID_V4.test(lease.requestId)) {
      const state = { kind: 'held-unknown', reason: 'persisted-state-malformed', lease } as const;
      this.states.set(scopeKey, state);
      return state;
    }
    const state = this.observeLeaseRecord(lease);
    this.states.set(scopeKey, state);
    return state;
  }

  state(scopeKey: string): ReconstructedLeaseState {
    const cached = this.states.get(scopeKey);
    if (!cached) return this.reconstruct(scopeKey);
    const reobservableUnknown = cached.kind === 'held-unknown' && cached.lease
      && ['holder-identity-unknown', 'destructive-child-live', 'destructive-child-identity-unknown']
        .includes(cached.reason);
    if (cached.kind !== 'live-held' && !reobservableUnknown) return cached;
    const refreshed = this.observeLeaseRecord(cached.lease!);
    this.states.set(scopeKey, refreshed);
    return refreshed;
  }

  private observeLeaseRecord(lease: LeaseRecord): ReconstructedLeaseState {
    const holderObservation = this.observeIdentity(lease);
    if (holderObservation === 'matching-live') return { kind: 'live-held', lease };
    if (holderObservation === 'unknown') {
      return { kind: 'held-unknown', reason: 'holder-identity-unknown', lease };
    }
    if (!lease.destructiveChild) return { kind: 'stale', lease };
    const child = lease.destructiveChild;
    const childObservation = this.observeIdentity({
      ...lease,
      pid: child.pid,
      platform: child.platform,
      processStartIdentity: child.processStartIdentity,
    });
    if (childObservation === 'dead-or-reused') return { kind: 'stale', lease };
    return {
      kind: 'held-unknown',
      reason: childObservation === 'matching-live'
        ? 'destructive-child-live'
        : 'destructive-child-identity-unknown',
      lease,
    };
  }

  bindDestructiveChild(
    scopeKey: string,
    requestId: string,
    token: string,
    peer: MeasuredPeerCredentials,
    child: Readonly<{ pid: number; processStartIdentity: string; platform: 'linux' | 'darwin' }>,
  ): BindLeaseChildResult {
    if (!validScopeKey(scopeKey) || !UUID_V4.test(requestId) || !token
      || !isMeasuredPeerCredentials(peer) || !Number.isSafeInteger(child.pid)
      || child.pid <= 0 || !child.processStartIdentity) {
      return { kind: 'refused', reason: 'INVALID_REQUEST' };
    }
    if (this.admissionState !== 'open') return { kind: 'refused', reason: 'UNKNOWN' };
    try {
      return this.persistence.withScopeLock(scopeKey, () => this.bindDestructiveChildLocked(
        scopeKey, requestId, token, peer, child,
      ));
    } catch {
      return { kind: 'refused', reason: 'UNKNOWN' };
    }
  }

  private bindDestructiveChildLocked(
    scopeKey: string,
    requestId: string,
    token: string,
    peer: MeasuredPeerCredentials,
    child: Readonly<{ pid: number; processStartIdentity: string; platform: 'linux' | 'darwin' }>,
  ): BindLeaseChildResult {
    // The process-local cache is not authority across daemon instances. Every
    // mutator rereads the common-dir record after taking the same scope lock.
    this.reconstruct(scopeKey);
    const state = this.state(scopeKey);
    if (state.kind !== 'live-held') {
      return { kind: 'refused', reason: state.kind === 'held-unknown' ? 'UNKNOWN' : 'CAPABILITY_MISMATCH' };
    }
    const lease = state.lease;
    const exactHolder = lease.requestId === requestId && lease.token === token
      && lease.pid === peer.pid && lease.platform === peer.platform
      && lease.processStartIdentity === peer.processStartIdentity;
    if (!exactHolder) return { kind: 'refused', reason: 'CAPABILITY_MISMATCH' };
    const bound = Object.freeze({ ...lease, destructiveChild: Object.freeze({ ...child }) });
    try {
      this.persistence.publish(bound);
    } catch {
      this.states.set(scopeKey, { kind: 'held-unknown', reason: 'child-binding-publication-failed', lease });
      return { kind: 'refused', reason: 'UNKNOWN' };
    }
    this.states.set(scopeKey, { kind: 'live-held', lease: bound });
    return { kind: 'bound' };
  }

  acquire(request: AcquireLeaseRequest): AcquireLeaseResult {
    if (!validScopeKey(request.scopeKey) || !UUID_V4.test(request.requestId)
      || !request.owner || !isMeasuredPeerCredentials(request.peer)) {
      return { kind: 'refused', reason: 'INVALID_REQUEST' };
    }
    if (this.admissionState !== 'open') return { kind: 'refused', reason: 'UNKNOWN' };
    // A synchronous release has already made the scope indeterminate. Do not
    // let a re-entrant acquire overwrite that transition by reconstructing the
    // still-present durable grant while remove() is in progress.
    const cached = this.states.get(request.scopeKey);
    if (cached?.kind === 'held-unknown' && cached.reason === 'release-in-progress') {
      return { kind: 'refused', reason: 'UNKNOWN' };
    }
    try {
      return this.persistence.withScopeLock(request.scopeKey, () => this.acquireLocked(request));
    } catch {
      return { kind: 'refused', reason: 'UNKNOWN' };
    }
  }

  private acquireLocked(request: AcquireLeaseRequest): AcquireLeaseResult {
    // Every process may have cached `absent` during boot. Once the common-dir
    // lock is held, reread durable state so publication is conditional on the
    // winner's observation, rather than on a process-local snapshot.
    this.reconstruct(request.scopeKey);
    const state = this.state(request.scopeKey);
    if (state.kind === 'held-unknown') return { kind: 'refused', reason: 'UNKNOWN' };

    if (state.kind === 'live-held') {
      const sameRequester = state.lease.requestId === request.requestId
        && state.lease.owner === request.owner
        && state.lease.pid === request.peer.pid
        && state.lease.platform === request.peer.platform
        && state.lease.processStartIdentity === request.peer.processStartIdentity;
      // Lost-grant recovery must precede the generic live-peer refusal.
      if (sameRequester) {
        return { kind: 'granted', token: state.lease.token, recovered: true };
      }
      return { kind: 'refused', reason: 'LIVE_HELD' };
    }

    if (state.kind === 'stale') {
      const observation = this.observeIdentity(state.lease);
      if (observation === 'matching-live') {
        this.states.set(request.scopeKey, { kind: 'live-held', lease: state.lease });
        return { kind: 'refused', reason: 'LIVE_HELD' };
      }
      if (observation === 'unknown') {
        this.states.set(request.scopeKey, {
          kind: 'held-unknown', reason: 'stale-revalidation-unknown', lease: state.lease,
        });
        return { kind: 'refused', reason: 'UNKNOWN' };
      }
    }

    const lease: LeaseRecord = Object.freeze({
      scopeKey: request.scopeKey,
      requestId: request.requestId,
      token: this.createToken(),
      owner: request.owner,
      pid: request.peer.pid,
      platform: request.peer.platform,
      processStartIdentity: request.peer.processStartIdentity,
      grantedAtMs: this.now(),
    });
    try {
      this.persistence.publish(lease);
    } catch {
      this.states.set(request.scopeKey, { kind: 'held-unknown', reason: 'publication-failed' });
      return { kind: 'refused', reason: 'UNKNOWN' };
    }
    this.states.set(request.scopeKey, { kind: 'live-held', lease });
    return { kind: 'granted', token: lease.token, recovered: false };
  }

  check(scopeKey: string, requestId: string, token: string): CheckLeaseResult {
    if (!validScopeKey(scopeKey) || !UUID_V4.test(requestId) || !token) {
      return { kind: 'refused', reason: 'INVALID_REQUEST' };
    }
    if (this.admissionState !== 'open') return { kind: 'refused', reason: 'UNKNOWN' };
    const state = this.state(scopeKey);
    if (state.kind === 'held-unknown') return { kind: 'refused', reason: 'UNKNOWN' };
    if (state.kind !== 'live-held') return { kind: 'refused', reason: 'CAPABILITY_MISMATCH' };
    return state.lease.requestId === requestId && state.lease.token === token
      ? { kind: 'held' }
      : { kind: 'refused', reason: 'CAPABILITY_MISMATCH' };
  }

  release(scopeKey: string, requestId: string, token: string): ReleaseLeaseResult {
    if (!validScopeKey(scopeKey) || !UUID_V4.test(requestId) || !token) {
      return { kind: 'refused', reason: 'INVALID_REQUEST' };
    }
    if (this.admissionState !== 'open') return { kind: 'refused', reason: 'UNKNOWN' };
    try {
      return this.persistence.withScopeLock(scopeKey, () => this.releaseLocked(scopeKey, requestId, token));
    } catch {
      return { kind: 'refused', reason: 'UNKNOWN' };
    }
  }

  private releaseLocked(scopeKey: string, requestId: string, token: string): ReleaseLeaseResult {
    // Match acquire/bind: observe only after the interprocess scope lock is
    // held so a concurrent publication cannot be removed or resurrected.
    this.reconstruct(scopeKey);
    const state = this.state(scopeKey);
    if (state.kind === 'held-unknown') return { kind: 'refused', reason: 'UNKNOWN' };
    if (state.kind === 'absent') {
      return this.releasedRequests.get(scopeKey) === requestId
        ? { kind: 'released', alreadyAbsent: true }
        : { kind: 'refused', reason: 'CAPABILITY_MISMATCH' };
    }
    const lease = state.lease;
    if (lease.requestId !== requestId || lease.token !== token) {
      return { kind: 'refused', reason: 'CAPABILITY_MISMATCH' };
    }
    if (lease.destructiveChild) {
      const child = lease.destructiveChild;
      const observation = this.observeIdentity({
        ...lease,
        pid: child.pid,
        platform: child.platform,
        processStartIdentity: child.processStartIdentity,
      });
      // Release is the invariant boundary. Callers may reap locally for
      // progress, but no path can surrender repository custody while its
      // durably bound destructive child is live or unobservable.
      if (observation !== 'dead-or-reused') {
        return { kind: 'refused', reason: 'UNKNOWN' };
      }
    }
    this.states.set(scopeKey, { kind: 'held-unknown', reason: 'release-in-progress', lease });
    try {
      this.persistence.remove(lease);
    } catch {
      this.states.set(scopeKey, { kind: 'held-unknown', reason: 'release-durability-unknown', lease });
      return { kind: 'refused', reason: 'UNKNOWN' };
    }
    this.releasedRequests.set(scopeKey, requestId);
    this.states.set(scopeKey, { kind: 'absent' });
    return { kind: 'released', alreadyAbsent: false };
  }

  availability(scopeKey: string): 'clear' | 'blocked' | 'unknown' {
    if (!validScopeKey(scopeKey) || this.admissionState !== 'open') return 'unknown';
    const state = this.state(scopeKey);
    if (state.kind === 'held-unknown') return 'unknown';
    return state.kind === 'absent' || state.kind === 'stale' ? 'clear' : 'blocked';
  }
}
