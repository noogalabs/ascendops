import {
  DeferredStartMachine,
  type ChildBinding,
  type DeferredEffect,
  type DeferredOperationContext,
  type DeferredOperation,
  type DeferredOwner,
  type DeferredSubscriber,
  type RequestResult,
} from './deferred-start-machine';

export type DeferredLifecycleDependencies = {
  custodyVerdict(agent: string): 'clear' | 'blocked' | 'unknown';
  acquireCustody(agent: string): boolean;
  releaseCustody?(agent: string): void;
  enabled?(agent: string): boolean;
  stopOld(agent: string, identity: string): Promise<void>;
  spawn(agent: string, token: string, generation: number): Promise<ChildBinding>;
  reapChild(agent: string, binding: ChildBinding): Promise<void>;
  deliver(effect: Extract<DeferredEffect, { type: 'deliver' }>): Promise<void>;
  scheduleRetry(callback: () => void, delayMs: number): unknown;
  cancelRetry(handle: unknown): void;
  retryDelayMs?: number;
};

/**
 * The single caller-independent owner of deferred start/restart progress.
 * Every custody-blocked request receives a retry owner here; callers never
 * create their own timers or infer completion from a deferred return.
 */
export class DeferredAgentLifecycle {
  private readonly retryHandles = new Map<string, unknown>();
  /** Recovered scheduling predecessors: these never remain rejected. */
  private readonly pumpChains = new Map<string, Promise<void>>();
  /** The latest caller-visible operation outcome, including its failure. */
  private readonly pumpOutcomes = new Map<string, Promise<void>>();
  private readonly custodyOwners = new Set<string>();
  private readonly retryDelayMs: number;

  constructor(
    private readonly machine: DeferredStartMachine,
    private readonly dependencies: DeferredLifecycleDependencies,
  ) {
    this.retryDelayMs = dependencies.retryDelayMs ?? 250;
  }

  request(input: {
    agent: string;
    operation: DeferredOperation;
    subscriber: DeferredSubscriber;
    oldProcessIdentity?: string;
    operationContext?: DeferredOperationContext;
  }): RequestResult {
    const verdict = this.dependencies.custodyVerdict(input.agent);
    if (verdict !== 'clear' && verdict !== 'blocked') {
      return { status: 'refused', reason: 'UNKNOWN_GUARD' };
    }
    const custodyBlocked = verdict === 'blocked';
    let result: RequestResult;
    try {
      result = this.machine.request({ ...input, custodyBlocked });
    } catch (error) {
      try { this.machine.fail(input.agent); } catch { /* retain the original publication error */ }
      throw error;
    }
    void this.pump(this.requireOwner(input.agent));
    return result;
  }

  stop(agent: string, child?: ChildBinding): void {
    this.cancelScheduled(agent);
    this.machine.stop(agent, child);
    void this.pump(this.requireOwner(agent));
  }

  setEnabled(agent: string, enabled: boolean): void {
    if (!enabled) this.cancelScheduled(agent);
    this.machine.setEnabled(agent, enabled);
    void this.pump(this.requireOwner(agent));
  }

  async shutdown(children: Readonly<Record<string, ChildBinding | undefined>> = {}): Promise<void> {
    for (const agent of this.retryHandles.keys()) this.cancelScheduled(agent);
    const owners = this.machine.shutdown(children);
    await Promise.all(owners.map(owner => this.pump(owner)));
  }

  observe(agent: string) { return this.machine.observe(agent); }

  persistedAgents(): readonly string[] { return this.machine.persistedAgents(); }

  persistedRecord(agent: string) { return this.machine.persistedRecord(agent); }

  beginRecoveredChildReplacement(agent: string, generation: number) {
    return this.machine.beginRecoveredChildReplacement(agent, generation);
  }

  completeRecoveredChildReap(agent: string, generation: number) {
    return this.machine.completeRecoveredChildReap(agent, generation);
  }

  custodyBlocked(agent: string): boolean {
    const verdict = this.dependencies.custodyVerdict(agent);
    return verdict !== 'clear';
  }

  reconstruct(agent: string, observation: Parameters<DeferredStartMachine['reconstruct']>[1]): void {
    const verdict = this.dependencies.custodyVerdict(agent);
    const custodyBlocked = observation.custodyBlocked || verdict !== 'clear';
    this.machine.reconstruct(agent, { ...observation, custodyBlocked });
    const owner = this.machine.owner(agent);
    if (owner) void this.pump(owner);
  }

  bindChildBeforeOnline(agent: string, binding: ChildBinding, generation: number): void {
    this.machine.bindChildBeforeOnline(agent, binding, generation);
  }

  settled(agent: string): Promise<void> {
    if (!this.machine.owner(agent)) return Promise.reject(new Error(`unknown effect owner: ${agent}`));
    return this.pumpOutcomes.get(agent) ?? Promise.resolve();
  }

  private pump(owner: DeferredOwner): Promise<void> {
    const previous = this.pumpChains.get(owner.agent) ?? Promise.resolve();
    const next = previous.then(async () => {
      let effects = this.machine.drainEffects(owner);
      while (effects.length > 0) {
        for (const effect of effects) {
          try {
            await this.apply(effect);
          } catch (error) {
            if (effect.type === 'reap-child') {
              // Cancellation completion cannot outrun its child. Persist the
              // failed reap, retain custody, and abort this agent's drain so
              // the queued deliver cannot acknowledge/release the record.
              this.machine.cancellationReapFailed(effect.agent, effect.binding);
              throw error;
            }
            this.machine.fail(effect.agent);
            // Delivery rejection is a caller-visible operation failure. Its
            // durable completion remains queued for consumer-deduped retry,
            // while the recovered scheduling tail permits later progress.
            if (error instanceof AggregateError || effect.type === 'deliver') throw error;
          }
        }
        effects = this.machine.drainEffects(owner);
      }
    });
    this.pumpOutcomes.set(owner.agent, next);
    // Keep failure observable through settled(), but never reuse a rejected
    // promise as the scheduling predecessor for the next operation.
    this.pumpChains.set(owner.agent, next.catch(() => undefined));
    return next;
  }

  private async apply(effect: DeferredEffect): Promise<void> {
    switch (effect.type) {
      case 'acquire-custody': {
        const verdict = this.dependencies.custodyVerdict(effect.agent);
        if (verdict !== 'clear') {
          this.machine.custodyResolved(effect.agent, effect.generation, false);
          return;
        }
        const acquired = this.dependencies.acquireCustody(effect.agent);
        if (!acquired) {
          this.machine.custodyResolved(effect.agent, effect.generation, false);
          return;
        }
        this.custodyOwners.add(effect.agent);
        try {
          const owned = this.machine.custodyResolved(effect.agent, effect.generation, true);
          if (!owned) this.releaseCustody(effect.agent);
        } catch (error) {
          this.releaseCustody(effect.agent);
          throw error;
        }
        return;
      }
      case 'schedule-retry': {
        if (this.retryHandles.has(effect.agent)) return;
        const callback = () => {
          this.retryHandles.delete(effect.agent);
          try {
            if (this.dependencies.enabled && !this.dependencies.enabled(effect.agent)) {
              this.machine.setEnabled(effect.agent, false);
              void this.pump(this.requireOwner(effect.agent));
              return;
            }
            this.machine.retry(
              effect.agent,
              effect.generation,
              effect.epoch,
              this.custodyBlocked(effect.agent),
            );
            void this.pump(this.requireOwner(effect.agent));
          } catch (error) {
            // The durable deferred row still owns retry. A callback failure
            // therefore installs a replacement timer instead of losing the
            // only live retry owner or throwing into the timer runtime.
            console.error(`[deferred-lifecycle] retry callback failed for ${effect.agent}: ${error}`);
            const replacement = this.dependencies.scheduleRetry(callback, this.retryDelayMs);
            this.retryHandles.set(effect.agent, replacement);
          }
        };
        const handle = this.dependencies.scheduleRetry(callback, this.retryDelayMs);
        this.retryHandles.set(effect.agent, handle);
        return;
      }
      case 'stop-old':
        await this.dependencies.stopOld(effect.agent, effect.identity);
        this.machine.oldProcessStopped(effect.agent, false);
        return;
      case 'spawn': {
        const current = this.machine.observe(effect.agent);
        if (current?.state !== 'spawning' || current.recordGeneration !== effect.generation) {
          this.releaseCustody(effect.agent);
          return;
        }
        try {
          const binding = await this.dependencies.spawn(effect.agent, effect.token, effect.generation);
          const adoption = this.machine.childPublished(effect.agent, binding, effect.generation);
          if (adoption === 'reap-required') {
            try {
              await this.dependencies.reapChild(effect.agent, binding);
              this.machine.pendingChildReaped(effect.agent, binding);
            } catch (reapError) {
              this.machine.pendingChildReapFailed(effect.agent, binding);
              try {
                this.releaseCustody(effect.agent);
              } catch (releaseError) {
                throw new AggregateError([reapError, releaseError], 'rejected child reap failed and custody was retained', { cause: reapError });
              }
              throw reapError;
            }
          }
          // A successful spawn hands the child to normal agent management;
          // the repository writer span ends even though that managed child
          // remains live.
          this.releaseCustody(effect.agent);
        } catch (error) {
          const failed = this.machine.observe(effect.agent);
          if (failed?.childBinding) {
            // A child durable enough to survive daemon loss is also durable
            // enough to require measured reap before repository custody can
            // be released to another writer.
            try {
              await this.dependencies.reapChild(effect.agent, failed.childBinding);
            } catch (reapError) {
              throw new AggregateError([error, reapError], 'spawn failed and bound-child reap failed', { cause: error });
            }
            this.machine.childReapedForRelease(effect.agent, failed.childBinding);
          }
          this.machine.fail(effect.agent);
          try {
            this.releaseCustody(effect.agent);
          } catch (releaseError) {
            throw new AggregateError([error, releaseError], 'spawn failed and custody release was refused', { cause: error });
          }
        }
        return;
      }
      case 'reap-child':
        await this.dependencies.reapChild(effect.agent, effect.binding);
        this.machine.pendingChildReaped(effect.agent, effect.binding);
        this.machine.cancellationChildReaped(effect.agent, effect.binding);
        return;
      case 'deliver':
        await this.dependencies.deliver(effect);
        if (effect.outcome !== 'spawned') this.releaseCustody(effect.agent);
        this.machine.acknowledge(effect.agent, effect.subscriber.id);
    }
  }

  private cancelScheduled(agent: string): void {
    const handle = this.retryHandles.get(agent);
    if (handle !== undefined) this.dependencies.cancelRetry(handle);
    this.retryHandles.delete(agent);
  }

  private requireOwner(agent: string): DeferredOwner {
    const owner = this.machine.owner(agent);
    if (!owner) throw new Error(`unknown effect owner: ${agent}`);
    return owner;
  }

  private releaseCustody(agent: string): void {
    if (!this.custodyOwners.has(agent)) return;
    const record = this.machine.observe(agent);
    const noPendingReaps = Object.keys(record?.pendingReapBindings ?? {}).length === 0;
    const releaseProven = noPendingReaps && (!record?.childBinding
      || record.state === 'spawned'
      || record.childReleaseDisposition === 'reaped'
      || record.cancellationReapDisposition === 'reaped'
      || record.recoveryReapAccounted === true);
    if (!releaseProven) {
      this.machine.custodyReleaseRefused(agent);
      throw new Error(`custody release refused while bound child may be live: ${agent}`);
    }
    this.dependencies.releaseCustody?.(agent);
    this.custodyOwners.delete(agent);
  }

}
