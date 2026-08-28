import type { DeferredStartJournal } from './deferred-start-journal';

export type DeferredOperation = 'start' | 'restart';
export type DeferredPhase = 'before-stop' | 'stopping' | 'after-stop' | 'spawning';
export type DeferredState =
  | 'requested'
  | 'restart-pending'
  | 'stopping'
  | 'start-pending'
  | 'deferred-with-owner'
  | 'spawning'
  | 'spawned'
  | 'failed'
  | 'cancelled-by-stop'
  | 'cancelled-by-shutdown'
  | 'completed-for-accounting';

export type DeferredSubscriber = Readonly<{
  id: string;
  kind: 'individual' | 'fleet';
}>;

export type ChildBinding = Readonly<{
  token: string;
  pid: number;
  kernelIdentity: string;
}>;

export type ChildAdoptionVerdict = 'adopted' | 'reap-required';

export type DeferredOperationContext = Readonly<{
  agentDir: string;
  config?: unknown;
  org?: string;
  partOfFleetStart?: boolean;
}>;

export type DeferredRecord = Readonly<{
  agent: string;
  receiptId: string;
  operation: DeferredOperation;
  state: DeferredState;
  phase: DeferredPhase;
  recordGeneration: number;
  attemptEpoch: number;
  hasRetryOwner: boolean;
  enabled: boolean;
  oldProcessIdentity?: string;
  intendedChildToken?: string;
  childBinding?: ChildBinding;
  pendingReapBindings?: Readonly<Record<string, ChildBinding>>;
  recoveryDisposition?: 'reap-before-replacement';
  recoveryReapAccounted?: boolean;
  cancellationReapDisposition?: 'pending' | 'reaped' | 'reap-failed';
  childReleaseDisposition?: 'reaped' | 'reap-failed';
  operationContext?: DeferredOperationContext;
  subscribers: readonly DeferredSubscriber[];
  acknowledgedSubscribers: readonly string[];
  outcome?: 'spawned' | 'failed' | 'cancelled-by-stop' | 'cancelled-by-shutdown';
}>;

export type DeferredEffect =
  | { type: 'acquire-custody'; agent: string; generation: number }
  | { type: 'schedule-retry'; agent: string; generation: number; epoch: number }
  | { type: 'stop-old'; agent: string; identity: string }
  | { type: 'spawn'; agent: string; token: string; generation: number }
  | { type: 'reap-child'; agent: string; binding: ChildBinding }
  | { type: 'deliver'; agent: string; subscriber: DeferredSubscriber; idempotencyKey: string; outcome: NonNullable<DeferredRecord['outcome']> };

declare const deferredOwnerBrand: unique symbol;
export type DeferredOwner = Readonly<{
  agent: string;
  [deferredOwnerBrand]: true;
}>;

export type RequestResult =
  | { status: 'accepted'; receiptId: string; record: DeferredRecord }
  | { status: 'deferred'; receiptId: string; record: DeferredRecord }
  | { status: 'in-flight'; receiptId: string; record: DeferredRecord }
  | { status: 'cancelled'; receiptId: string; record: DeferredRecord }
  | { status: 'refused'; reason: 'UNKNOWN_GUARD' };

export type ReconstructionObservation = Readonly<{
  oldIdentity: 'exact' | 'absent' | 'conflict' | 'unknown';
  replacementIdentity: 'exact' | 'absent' | 'conflict' | 'unknown';
  custodyBlocked: boolean;
  child?: ChildBinding;
}>;

const terminal = new Set<DeferredState>([
  'spawned', 'failed', 'cancelled-by-stop', 'cancelled-by-shutdown', 'completed-for-accounting',
]);

export class DeferredStartMachine {
  private readonly records = new Map<string, DeferredRecord>();
  private readonly effectsByAgent = new Map<string, DeferredEffect[]>();
  private readonly owners = new Map<string, DeferredOwner>();
  private shutdownGate = false;
  private nextReceipt = 0;
  private nextToken = 0;

  constructor(private readonly journal: DeferredStartJournal<DeferredRecord>) {}

  persistedAgents(): readonly string[] {
    return this.journal.keys();
  }

  persistedRecord(agent: string): DeferredRecord | undefined {
    const record = this.journal.latest(agent)?.value;
    return record && structuredClone(record);
  }

  beginRecoveredChildReplacement(agent: string, generation: number): DeferredRecord {
    const record = this.require(agent);
    if (record.recordGeneration !== generation) throw new Error(`stale recovery generation for ${agent}`);
    return this.executeRow(record, {
      ...record,
      recoveryDisposition: 'reap-before-replacement',
      recoveryReapAccounted: false,
    });
  }

  completeRecoveredChildReap(agent: string, generation: number): DeferredRecord {
    const record = this.require(agent);
    if (record.recordGeneration !== generation) throw new Error(`stale recovery generation for ${agent}`);
    if (record.recoveryDisposition !== 'reap-before-replacement') {
      throw new Error(`recovered-child disposition is not durable for ${agent}`);
    }
    return this.executeRow(record, { ...record, recoveryReapAccounted: true });
  }

  observe(agent: string): DeferredRecord | undefined {
    const record = this.records.get(agent);
    return record && structuredClone(record);
  }

  owner(agent: string): DeferredOwner | undefined {
    if (!this.records.has(agent)) return undefined;
    let owner = this.owners.get(agent);
    if (!owner) {
      owner = Object.freeze({ agent }) as DeferredOwner;
      this.owners.set(agent, owner);
    }
    return owner;
  }

  drainEffects(owner: DeferredOwner): DeferredEffect[] {
    if (!owner || this.owners.get(owner.agent) !== owner) {
      throw new Error('effect drain requires a known agent owner');
    }
    const effects = this.effectsByAgent.get(owner.agent) ?? [];
    this.effectsByAgent.delete(owner.agent);
    return effects.map((effect) => structuredClone(effect));
  }

  request(input: {
    agent: string;
    operation: DeferredOperation;
    subscriber: DeferredSubscriber;
    custodyBlocked: boolean;
    oldProcessIdentity?: string;
    operationContext?: DeferredOperationContext;
  }): RequestResult {
    const existing = this.records.get(input.agent);
    if (existing && !terminal.has(existing.state)) {
      if (existing.operation !== input.operation) {
        return { status: 'in-flight', receiptId: existing.receiptId, record: structuredClone(existing) };
      }
      const subscribers = existing.subscribers.some(({ id }) => id === input.subscriber.id)
        ? existing.subscribers
        : [...existing.subscribers, input.subscriber];
      const deduped = this.publish({ ...existing, subscribers });
      return {
        status: deduped.state === 'deferred-with-owner' ? 'deferred' : 'accepted',
        receiptId: deduped.receiptId,
        record: deduped,
      };
    }

    const receiptId = `${input.agent}:operation:${++this.nextReceipt}`;
    const initial: DeferredRecord = {
      agent: input.agent,
      receiptId,
      operation: input.operation,
      state: this.shutdownGate ? 'cancelled-by-shutdown' : input.operation === 'restart' ? 'restart-pending' : 'requested',
      phase: 'before-stop',
      recordGeneration: (existing?.recordGeneration ?? 0) + 1,
      attemptEpoch: 0,
      hasRetryOwner: false,
      enabled: true,
      oldProcessIdentity: input.oldProcessIdentity,
      operationContext: input.operationContext,
      subscribers: [input.subscriber],
      acknowledgedSubscribers: [],
      outcome: this.shutdownGate ? 'cancelled-by-shutdown' : undefined,
    };
    this.publish(initial);
    if (this.shutdownGate) {
      this.dispatchCompletion(input.agent);
      const record = this.require(input.agent);
      return { status: 'cancelled', receiptId, record };
    }
    input.custodyBlocked ? this.defer(initial) : this.requestCustody(initial);
    const record = this.require(input.agent);
    return { status: record.state === 'deferred-with-owner' ? 'deferred' : 'accepted', receiptId, record };
  }

  advance(agent: string, custodyBlocked: boolean): void {
    const record = this.require(agent);
    if (terminal.has(record.state) || this.shutdownGate || !record.enabled) return;
    if (custodyBlocked) {
      this.defer(record);
      return;
    }
    if (record.operation === 'restart' && (record.phase === 'before-stop' || record.state === 'stopping')) {
      const stopping = record.state === 'stopping'
        ? record
        : this.executeRow(record, {
          ...record, state: 'stopping', phase: 'stopping', hasRetryOwner: false,
        });
      if (!stopping.oldProcessIdentity) return this.fail(agent);
      this.emit(stopping, [{ type: 'stop-old', agent, identity: stopping.oldProcessIdentity }]);
      return;
    }
    this.beginSpawn(record);
  }

  oldProcessStopped(agent: string, custodyBlocked: boolean): void {
    const record = this.require(agent);
    if (record.state !== 'stopping') return;
    this.enterStartPending(record, {
      oldIdentity: 'absent', replacementIdentity: 'absent', custodyBlocked,
    }, !custodyBlocked);
  }

  retry(agent: string, generation: number, epoch: number, custodyBlocked: boolean): void {
    const record = this.require(agent);
    if (record.state !== 'deferred-with-owner' || record.recordGeneration !== generation || record.attemptEpoch !== epoch) return;
    if (this.shutdownGate || !record.enabled) return;
    if (custodyBlocked) {
      this.defer(record);
      return;
    }
    this.requestCustody(record);
  }

  /** The acquisition effect reports whether the protected row now owns custody. */
  custodyResolved(agent: string, generation: number, acquired: boolean): boolean {
    const record = this.records.get(agent);
    if (!record || terminal.has(record.state) || record.recordGeneration !== generation) return false;
    if (!acquired) {
      this.defer(record);
      return false;
    }
    this.advance(agent, false);
    return true;
  }

  setEnabled(agent: string, enabled: boolean): void {
    const record = this.records.get(agent);
    if (!record || terminal.has(record.state) || record.enabled === enabled) return;
    if (enabled) {
      this.executeRow(record, { ...record, enabled: true });
      return;
    }
    this.executeRow(record, {
      ...record,
      enabled: false,
      state: 'cancelled-by-stop',
      recordGeneration: record.recordGeneration + 1,
      hasRetryOwner: false,
      outcome: 'cancelled-by-stop',
    });
    this.dispatchCompletion(agent);
  }

  stop(agent: string, childCreated?: ChildBinding): void {
    const record = this.records.get(agent);
    if (!record || terminal.has(record.state)) return;
    const cancelled = this.executeRow(record, {
      ...record,
      state: 'cancelled-by-stop',
      recordGeneration: record.recordGeneration + 1,
      hasRetryOwner: false,
      enabled: false,
      childBinding: childCreated ?? record.childBinding,
      cancellationReapDisposition: (childCreated ?? record.childBinding) ? 'pending' : undefined,
      outcome: 'cancelled-by-stop',
    });
    if (cancelled.childBinding) this.enqueue({ type: 'reap-child', agent, binding: cancelled.childBinding });
    this.dispatchCompletion(agent);
  }

  shutdown(children: Readonly<Record<string, ChildBinding | undefined>> = {}): readonly DeferredOwner[] {
    this.shutdownGate = true;
    const owners: DeferredOwner[] = [];
    for (const [agent, record] of this.records) {
      owners.push(this.owner(agent)!);
      if (terminal.has(record.state)) continue;
      const cancelled = this.executeRow(record, {
        ...record,
        state: 'cancelled-by-shutdown',
        recordGeneration: record.recordGeneration + 1,
        hasRetryOwner: false,
        childBinding: children[agent] ?? record.childBinding,
        cancellationReapDisposition: (children[agent] ?? record.childBinding) ? 'pending' : undefined,
        outcome: 'cancelled-by-shutdown',
      });
      if (cancelled.childBinding) this.enqueue({ type: 'reap-child', agent, binding: cancelled.childBinding });
      this.dispatchCompletion(agent);
    }
    return owners;
  }

  cancellationChildReaped(agent: string, binding: ChildBinding): void {
    const record = this.require(agent);
    if ((record.state !== 'cancelled-by-stop' && record.state !== 'cancelled-by-shutdown')
      || record.childBinding?.token !== binding.token) return;
    this.executeRow(record, { ...record, cancellationReapDisposition: 'reaped' });
  }

  cancellationReapFailed(agent: string, binding: ChildBinding): void {
    const record = this.require(agent);
    if ((record.state !== 'cancelled-by-stop' && record.state !== 'cancelled-by-shutdown')
      || record.childBinding?.token !== binding.token) return;
    this.executeRow(record, { ...record, cancellationReapDisposition: 'reap-failed' });
  }

  childReapedForRelease(agent: string, binding: ChildBinding): void {
    const record = this.require(agent);
    if (record.childBinding?.token !== binding.token) return;
    this.executeRow(record, { ...record, childReleaseDisposition: 'reaped' });
  }

  pendingChildReaped(agent: string, binding: ChildBinding): void {
    const record = this.require(agent);
    const pending = { ...record.pendingReapBindings };
    const key = Object.keys(pending).find(candidate => pending[candidate]?.token === binding.token);
    if (!key) return;
    delete pending[key];
    this.executeRow(record, {
      ...record,
      pendingReapBindings: pending,
      childReleaseDisposition: Object.keys(pending).length === 0 ? 'reaped' : record.childReleaseDisposition,
    });
  }

  pendingChildReapFailed(agent: string, binding: ChildBinding): void {
    const record = this.require(agent);
    if (!Object.values(record.pendingReapBindings ?? {}).some(candidate => candidate.token === binding.token)) return;
    this.executeRow(record, { ...record, childReleaseDisposition: 'reap-failed' });
  }

  custodyReleaseRefused(agent: string): void {
    const record = this.require(agent);
    const hasPendingReaps = Object.keys(record.pendingReapBindings ?? {}).length > 0;
    if (!hasPendingReaps && (!record.childBinding || record.state === 'spawned'
      || record.childReleaseDisposition === 'reaped'
      || record.cancellationReapDisposition === 'reaped' || record.recoveryReapAccounted)) return;
    this.executeRow(record, {
      ...record,
      childReleaseDisposition: 'reap-failed',
      cancellationReapDisposition: record.cancellationReapDisposition ? 'reap-failed' : undefined,
    });
  }

  childPublished(agent: string, binding: ChildBinding, generation: number): ChildAdoptionVerdict {
    const record = this.require(agent);
    if (record.state !== 'spawning' || record.recordGeneration !== generation || this.shutdownGate || !record.enabled) {
      const key = `${generation}:${binding.token}`;
      this.executeRow(record, {
        ...record,
        pendingReapBindings: { ...record.pendingReapBindings, [key]: binding },
      });
      return 'reap-required';
    }
    if (record.intendedChildToken !== binding.token) {
      const key = `${generation}:${binding.token}`;
      this.executeRow(record, {
        ...record,
        pendingReapBindings: { ...record.pendingReapBindings, [key]: binding },
      });
      this.fail(agent);
      return 'reap-required';
    }
    this.executeRow(record, { ...record, state: 'spawned', childBinding: binding, outcome: 'spawned' });
    this.dispatchCompletion(agent);
    return 'adopted';
  }

  bindChildBeforeOnline(agent: string, binding: ChildBinding, generation: number): void {
    const record = this.require(agent);
    if (record.state !== 'spawning' || record.recordGeneration !== generation) {
      throw new Error(`child binding row is not current for ${agent}`);
    }
    if (record.intendedChildToken !== binding.token) {
      throw new Error(`child binding token mismatch for ${agent}`);
    }
    this.executeRow(record, { ...record, childBinding: binding });
  }

  fail(agent: string): void {
    const record = this.require(agent);
    if (terminal.has(record.state)) return;
    this.executeRow(record, { ...record, state: 'failed', hasRetryOwner: false, outcome: 'failed' });
    this.dispatchCompletion(agent);
  }

  acknowledge(agent: string, subscriberId: string): void {
    const record = this.require(agent);
    if (!record.outcome || record.acknowledgedSubscribers.includes(subscriberId)) return;
    const acknowledgedSubscribers = [...record.acknowledgedSubscribers, subscriberId];
    const next = this.executeRow(record, { ...record, acknowledgedSubscribers });
    if (next.subscribers.every(({ id }) => acknowledgedSubscribers.includes(id))) {
      this.executeRow(next, { ...next, state: 'completed-for-accounting' });
    }
  }

  reconstruct(agent: string, observation: ReconstructionObservation): void {
    const persisted = this.journal.latest(agent)?.value;
    if (!persisted) return;
    this.records.set(agent, structuredClone(persisted));
    for (const binding of Object.values(persisted.pendingReapBindings ?? {})) {
      this.enqueue({ type: 'reap-child', agent, binding });
    }
    if (persisted.outcome && persisted.state !== 'completed-for-accounting') {
      this.dispatchCompletion(agent);
      return;
    }
    if (persisted.state === 'deferred-with-owner' || persisted.state === 'requested') {
      this.defer(persisted);
    } else if (persisted.state === 'restart-pending' || persisted.state === 'stopping') {
      if (observation.oldIdentity === 'conflict' || observation.oldIdentity === 'unknown') return this.fail(agent);
      if (observation.oldIdentity === 'exact') {
        observation.custodyBlocked ? this.defer(persisted) : this.requestCustody(persisted);
      } else {
        this.enterStartPending(persisted, observation, false);
      }
    } else if (persisted.state === 'start-pending') {
      if (observation.replacementIdentity === 'exact' && observation.child) {
        const spawning = this.executeRow(persisted, {
          ...persisted, state: 'spawning', phase: 'spawning', hasRetryOwner: false,
        });
        if (this.childPublished(agent, observation.child, spawning.recordGeneration) === 'reap-required') {
          this.enqueue({ type: 'reap-child', agent, binding: observation.child });
        }
      } else {
        this.enterStartPending(persisted, observation);
      }
    } else if (persisted.state === 'spawning') {
      if (observation.child && observation.child.token === persisted.intendedChildToken) {
        if (this.childPublished(agent, observation.child, persisted.recordGeneration) === 'reap-required') {
          this.enqueue({ type: 'reap-child', agent, binding: observation.child });
        }
      } else {
        this.fail(agent);
      }
    }
  }

  private requestCustody(record: DeferredRecord): void {
    this.emit(record, [{ type: 'acquire-custody', agent: record.agent, generation: record.recordGeneration }]);
  }

  private defer(record: DeferredRecord): void {
    const deferred = this.executeRow(record, {
      ...record,
      state: 'deferred-with-owner',
      attemptEpoch: record.attemptEpoch + 1,
      hasRetryOwner: true,
    });
    this.emit(deferred, [{
      type: 'schedule-retry', agent: record.agent,
      generation: deferred.recordGeneration, epoch: deferred.attemptEpoch,
    }]);
  }

  private beginSpawn(record: DeferredRecord): void {
    const token = `${record.receiptId}:child:${++this.nextToken}`;
    const spawning = this.executeRow(record, {
      ...record, state: 'spawning', phase: 'spawning', hasRetryOwner: false,
      intendedChildToken: token,
    });
    this.emit(spawning, [{ type: 'spawn', agent: record.agent, token, generation: spawning.recordGeneration }]);
  }

  /**
   * L39's sole transition owner. Callers supply measured absence evidence;
   * this row owns the durable start-pending publication and its custody
   * continuation. Missing or ambiguous replacement evidence never means
   * absence and therefore cannot authorize a spawn.
   */
  private enterStartPending(
    record: DeferredRecord,
    evidence: Pick<ReconstructionObservation, 'oldIdentity' | 'replacementIdentity' | 'custodyBlocked'>,
    custodyOwned = false,
  ): void {
    const pending = this.executeRow(record, {
      ...record, state: 'start-pending', phase: 'after-stop',
    });
    if (evidence.oldIdentity !== 'absent') {
      if (evidence.oldIdentity !== 'unknown') this.fail(pending.agent);
      return;
    }
    if (evidence.replacementIdentity !== 'absent') {
      if (evidence.replacementIdentity !== 'unknown') this.fail(pending.agent);
      return;
    }
    if (evidence.custodyBlocked) this.defer(pending);
    else if (custodyOwned) this.beginSpawn(pending);
    else this.requestCustody(pending);
  }

  private dispatchCompletion(agent: string): void {
    const record = this.require(agent);
    if (!record.outcome) return;
    for (const subscriber of record.subscribers) {
      if (!record.acknowledgedSubscribers.includes(subscriber.id)) {
        this.enqueue({
          type: 'deliver', agent, subscriber,
          idempotencyKey: `${record.receiptId}:${subscriber.id}`,
          outcome: record.outcome,
        });
      }
    }
  }

  private publish(record: DeferredRecord): DeferredRecord {
    const published = structuredClone(this.journal.append(record).value);
    this.records.set(record.agent, published);
    return structuredClone(published);
  }

  /** One typed row boundary: conditional durable publication precedes effects. */
  private executeRow(current: DeferredRecord, target: DeferredRecord): DeferredRecord {
    const unchanged = JSON.stringify(current) === JSON.stringify(target);
    if (unchanged) {
      this.records.set(current.agent, structuredClone(current));
      return structuredClone(current);
    }
    return this.publish(target);
  }

  private emit(owner: DeferredRecord, effects: readonly DeferredEffect[]): void {
    for (const effect of effects) {
      if (effect.agent !== owner.agent) throw new Error('row effect owner mismatch');
      this.enqueue(effect);
    }
  }

  private enqueue(effect: DeferredEffect): void {
    const effects = this.effectsByAgent.get(effect.agent) ?? [];
    effects.push(effect);
    this.effectsByAgent.set(effect.agent, effects);
  }

  private require(agent: string): DeferredRecord {
    const record = this.records.get(agent);
    if (!record) throw new Error(`No deferred operation for ${agent}`);
    return structuredClone(record);
  }
}
