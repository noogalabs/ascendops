import { DeferredStartMachine, type ChildBinding, type DeferredEffect } from '../../src/daemon/deferred-start-machine';
import { MemoryDeferredStartJournal } from '../../src/daemon/deferred-start-journal';

export type DeferredScenarioName =
  | 'disable-while-deferred'
  | 'explicit-stop-cancels-deferred'
  | 'individual-restart-notification'
  | 'ordinary-ipc-start-retries'
  | 'direct-restart-owns-retry'
  | 'ipc-restart-single-entry'
  | 'shutdown-cancels-and-gates'
  | 'fleet-accounting-after-spawn'
  | 'daemon-crash-reconstructs-operation'
  | 'stop-during-spawning-reaps-child'
  | 'shutdown-during-spawning-reaps-child'
  | 'restart-phase-single-replacement'
  | 'restart-boot-reconstruction'
  | 'child-receipt-kernel-binding'
  | 'restart-receipt-continuity'
  | 'completion-outbox-crash-windows'
  | 'concurrent-request-dedupe-and-in-flight';

const subscriber = (id: string, kind: 'individual' | 'fleet' = 'individual') => ({ id, kind } as const);
const exactChild = (effect: Extract<DeferredEffect, { type: 'spawn' }>, pid = 101): ChildBinding => ({
  token: effect.token,
  pid,
  kernelIdentity: `kernel:${pid}:start`,
});
const invariant = (condition: unknown, message: string): asserts condition => {
  if (!condition) throw new Error(`PR267 scenario invariant failed: ${message}`);
};
const spawnEffect = (effects: DeferredEffect[]) => {
  const effect = effects.find((candidate): candidate is Extract<DeferredEffect, { type: 'spawn' }> => candidate.type === 'spawn');
  invariant(effect, 'expected one spawn effect');
  return effect;
};
const retryEffect = (effects: DeferredEffect[]) => {
  const effect = effects.find((candidate): candidate is Extract<DeferredEffect, { type: 'schedule-retry' }> => candidate.type === 'schedule-retry');
  invariant(effect, 'expected a retry owner');
  return effect;
};

/** The frozen-v6 scenario driver models the production lifecycle's successful
 * acquire-custody effect while keeping every scenario focused on its own row. */
const withGrantedCustody = (machine: DeferredStartMachine): DeferredStartMachine => {
  const rawDrain = machine.drainEffects.bind(machine);
  const buffered = new Map<string, DeferredEffect[]>();
  const flush = (agent: string) => {
    const owner = machine.owner(agent);
    if (!owner) return;
    const visible = buffered.get(agent) ?? [];
    let effects = rawDrain(owner);
    while (effects.length > 0) {
      let acquired = false;
      for (const effect of effects) {
        if (effect.type === 'acquire-custody') {
          machine.custodyResolved(effect.agent, effect.generation, true);
          acquired = true;
        } else {
          visible.push(effect);
        }
      }
      if (!acquired) break;
      effects = rawDrain(owner);
    }
    buffered.set(agent, visible);
  };
  const rawRequest = machine.request.bind(machine);
  machine.request = (input) => {
    const result = rawRequest(input);
    flush(input.agent);
    return result;
  };
  const rawRetry = machine.retry.bind(machine);
  machine.retry = (agent, generation, epoch, custodyBlocked) => {
    rawRetry(agent, generation, epoch, custodyBlocked);
    flush(agent);
  };
  const rawReconstruct = machine.reconstruct.bind(machine);
  machine.reconstruct = (agent, observation) => {
    rawReconstruct(agent, observation);
    flush(agent);
  };
  machine.drainEffects = (owner) => {
    flush(owner.agent);
    const visible = buffered.get(owner.agent) ?? [];
    buffered.delete(owner.agent);
    return visible;
  };
  return machine;
};

export async function runDeferredStartScenario(scenario: DeferredScenarioName): Promise<{ scenario: DeferredScenarioName; observed: true }> {
  const journal = new MemoryDeferredStartJournal<import('../../src/daemon/deferred-start-machine').DeferredRecord>();
  const machine = withGrantedCustody(new DeferredStartMachine(journal));
  const request = (operation: 'start' | 'restart', blocked: boolean, id = 'one', kind: 'individual' | 'fleet' = 'individual') =>
    machine.request({ agent: 'alpha', operation, custodyBlocked: blocked, subscriber: subscriber(id, kind), oldProcessIdentity: operation === 'restart' ? 'old:1' : undefined });

  switch (scenario) {
    case 'disable-while-deferred': {
      request('start', true);
      const retry = retryEffect(machine.drainEffects(machine.owner('alpha')!));
      machine.setEnabled('alpha', false);
      machine.retry('alpha', retry.generation, retry.epoch, false);
      invariant(machine.observe('alpha')?.state === 'cancelled-by-stop', 'registry disable must terminally cancel the held operation');
      invariant(!machine.drainEffects(machine.owner('alpha')!).some(({ type }) => type === 'spawn'), 'release after disable must not spawn');
      break;
    }
    case 'explicit-stop-cancels-deferred': {
      request('start', true);
      const retry = retryEffect(machine.drainEffects(machine.owner('alpha')!));
      machine.stop('alpha');
      machine.retry('alpha', retry.generation, retry.epoch, false);
      invariant(machine.observe('alpha')?.state === 'cancelled-by-stop', 'stop must cancel held operation');
      invariant(!machine.drainEffects(machine.owner('alpha')!).some(({ type }) => type === 'spawn'), 'release after cancellation must not spawn');
      break;
    }
    case 'individual-restart-notification': {
      request('restart', true);
      const retry = retryEffect(machine.drainEffects(machine.owner('alpha')!));
      machine.retry('alpha', retry.generation, retry.epoch, false);
      invariant(machine.drainEffects(machine.owner('alpha')!).filter(({ type }) => type === 'stop-old').length === 1, 'restart stops old identity once');
      machine.oldProcessStopped('alpha', false);
      const spawn = spawnEffect(machine.drainEffects(machine.owner('alpha')!));
      machine.childPublished('alpha', exactChild(spawn), spawn.generation);
      const deliveries = machine.drainEffects(machine.owner('alpha')!).filter((effect): effect is Extract<DeferredEffect, { type: 'deliver' }> => effect.type === 'deliver');
      invariant(deliveries.length === 1 && deliveries[0].subscriber.kind === 'individual', 'individual completion only');
      break;
    }
    case 'ordinary-ipc-start-retries':
    case 'direct-restart-owns-retry':
    case 'ipc-restart-single-entry': {
      const operation = scenario === 'ordinary-ipc-start-retries' ? 'start' : 'restart';
      const accepted = request(operation, true);
      invariant(accepted.status === 'deferred' && accepted.record.hasRetryOwner, 'every caller owns retry when deferred');
      const retry = retryEffect(machine.drainEffects(machine.owner('alpha')!));
      machine.retry('alpha', retry.generation, retry.epoch, false);
      if (operation === 'restart') {
        invariant(machine.observe('alpha')?.state === 'stopping', 'restart resumes before-stop phase');
        machine.drainEffects(machine.owner('alpha')!);
        machine.oldProcessStopped('alpha', false);
      }
      invariant(machine.drainEffects(machine.owner('alpha')!).some(({ type }) => type === 'spawn'), 'release automatically progresses to spawn');
      break;
    }
    case 'shutdown-cancels-and-gates': {
      request('start', true);
      const retry = retryEffect(machine.drainEffects(machine.owner('alpha')!));
      machine.shutdown();
      machine.retry('alpha', retry.generation, retry.epoch, false);
      const late = machine.request({ agent: 'beta', operation: 'start', custodyBlocked: false, subscriber: subscriber('late') });
      invariant(machine.observe('alpha')?.state === 'cancelled-by-shutdown', 'snapshot member cancelled');
      invariant(late.status === 'cancelled', 'admission gate rejects late request');
      invariant(!machine.drainEffects(machine.owner('alpha')!).some(({ type }) => type === 'spawn'), 'no post-gate spawn');
      break;
    }
    case 'fleet-accounting-after-spawn': {
      request('start', true, 'fleet', 'fleet');
      invariant(!machine.drainEffects(machine.owner('alpha')!).some(({ type }) => type === 'deliver'), 'deferred fleet member is incomplete');
      const retry = machine.observe('alpha')!;
      machine.retry('alpha', retry.recordGeneration, retry.attemptEpoch, false);
      const spawn = spawnEffect(machine.drainEffects(machine.owner('alpha')!));
      invariant(!machine.drainEffects(machine.owner('alpha')!).some(({ type }) => type === 'deliver'), 'spawning is incomplete');
      machine.childPublished('alpha', exactChild(spawn), spawn.generation);
      invariant(machine.drainEffects(machine.owner('alpha')!).some(({ type }) => type === 'deliver'), 'receipt-bound spawn completes fleet member');
      break;
    }
    case 'daemon-crash-reconstructs-operation': {
      const original = request('start', true);
      machine.drainEffects(machine.owner('alpha')!);
      const recovered = withGrantedCustody(new DeferredStartMachine(journal));
      recovered.reconstruct('alpha', { oldIdentity: 'absent', custodyBlocked: false });
      const retry = retryEffect(recovered.drainEffects(recovered.owner('alpha')!));
      recovered.retry('alpha', retry.generation, retry.epoch, false);
      invariant(spawnEffect(recovered.drainEffects(recovered.owner('alpha')!)).token.startsWith(original.receiptId), 'recovery retains original receipt');
      break;
    }
    case 'stop-during-spawning-reaps-child':
    case 'shutdown-during-spawning-reaps-child': {
      request('start', false);
      const spawn = spawnEffect(machine.drainEffects(machine.owner('alpha')!));
      const child = exactChild(spawn);
      scenario === 'stop-during-spawning-reaps-child' ? machine.stop('alpha') : machine.shutdown();
      const adoption = machine.childPublished('alpha', child, spawn.generation);
      invariant(adoption === 'reap-required', 'late created child is returned to its caller for reap');
      invariant(machine.observe('alpha')?.outcome !== 'spawned', 'cancelled spawn never counts online');
      break;
    }
    case 'restart-phase-single-replacement': {
      const receipt = request('restart', false).receiptId;
      invariant(machine.observe('alpha')?.state === 'stopping', 'restart enters stopping');
      machine.drainEffects(machine.owner('alpha')!);
      machine.oldProcessStopped('alpha', true);
      const held = machine.observe('alpha')!;
      invariant(held.receiptId === receipt && held.phase === 'after-stop', 'custody after stop preserves restart receipt and phase');
      machine.retry('alpha', held.recordGeneration, held.attemptEpoch, false);
      invariant(machine.drainEffects(machine.owner('alpha')!).filter(({ type }) => type === 'spawn').length === 1, 'one replacement spawn');
      break;
    }
    case 'restart-boot-reconstruction': {
      request('restart', false);
      machine.drainEffects(machine.owner('alpha')!);
      const recovered = withGrantedCustody(new DeferredStartMachine(journal));
      recovered.reconstruct('alpha', { oldIdentity: 'exact', custodyBlocked: false });
      invariant(recovered.drainEffects(recovered.owner('alpha')!).filter(({ type }) => type === 'stop-old').length === 1, 'reissues idempotent stop for exact identity');
      recovered.oldProcessStopped('alpha', false);
      invariant(recovered.drainEffects(recovered.owner('alpha')!).filter(({ type }) => type === 'spawn').length === 1, 'reconstructed restart spawns once');
      break;
    }
    case 'child-receipt-kernel-binding': {
      request('start', false);
      const spawn = spawnEffect(machine.drainEffects(machine.owner('alpha')!));
      const recovered = withGrantedCustody(new DeferredStartMachine(journal));
      recovered.reconstruct('alpha', { oldIdentity: 'absent', custodyBlocked: false, child: { token: 'stranger-token', pid: 101, kernelIdentity: 'kernel:101:start' } });
      invariant(recovered.observe('alpha')?.state === 'failed', 'same-name/PID stranger is not adopted');
      invariant(!recovered.drainEffects(recovered.owner('alpha')!).some(({ type }) => type === 'spawn'), 'spawning recovery never blind-respawns');
      invariant(spawn.token !== 'stranger-token', 'test exercises token mismatch');
      break;
    }
    case 'restart-receipt-continuity': {
      const first = request('restart', false);
      machine.drainEffects(machine.owner('alpha')!);
      machine.oldProcessStopped('alpha', true);
      const held = machine.observe('alpha')!;
      machine.retry('alpha', held.recordGeneration, held.attemptEpoch, false);
      const spawn = spawnEffect(machine.drainEffects(machine.owner('alpha')!));
      const final = machine.observe('alpha')!;
      invariant(final.receiptId === first.receiptId && final.operation === 'restart' && final.subscribers[0].id === 'one', 'receipt fields survive after-stop deferral');
      invariant(spawn.token.startsWith(first.receiptId), 'child token binds original restart receipt');
      break;
    }
    case 'completion-outbox-crash-windows': {
      request('start', false);
      const spawn = spawnEffect(machine.drainEffects(machine.owner('alpha')!));
      machine.childPublished('alpha', exactChild(spawn), spawn.generation);
      const first = machine.drainEffects(machine.owner('alpha')!).find((effect): effect is Extract<DeferredEffect, { type: 'deliver' }> => effect.type === 'deliver');
      invariant(first, 'terminal result enters outbox');
      const recovered = withGrantedCustody(new DeferredStartMachine(journal));
      recovered.reconstruct('alpha', { oldIdentity: 'absent', custodyBlocked: false, child: exactChild(spawn) });
      // Producer crash before acknowledgement may redeliver, but the stable key
      // lets the durable consumer suppress a second observable effect.
      const redelivered = recovered.drainEffects(recovered.owner('alpha')!).find((effect): effect is Extract<DeferredEffect, { type: 'deliver' }> => effect.type === 'deliver');
      invariant(redelivered?.idempotencyKey === first.idempotencyKey, 'crash redelivery retains durable idempotency key');
      recovered.acknowledge('alpha', first.subscriber.id);
      invariant(recovered.observe('alpha')?.state === 'completed-for-accounting', 'ack closes accounting');
      invariant(first.idempotencyKey === `${first.agent}:operation:1:one`, 'stable receipt/subscriber idempotency key');
      break;
    }
    case 'concurrent-request-dedupe-and-in-flight': {
      const first = request('start', true, 'one');
      const second = request('start', true, 'two');
      const conflict = request('restart', true, 'three');
      invariant(first.receiptId === second.receiptId && second.record.subscribers.length === 2, 'identical callers share record and retain subscribers');
      invariant(conflict.status === 'in-flight', 'conflicting operation rejected');
      const effects = machine.drainEffects(machine.owner('alpha')!);
      invariant(effects.filter(({ type }) => type === 'schedule-retry').length === 1, 'dedupe does not install a second timer');
      const firstRetry = retryEffect(effects);
      machine.retry('alpha', firstRetry.generation, firstRetry.epoch, true);
      const replacement = retryEffect(machine.drainEffects(machine.owner('alpha')!));
      invariant(replacement.epoch > firstRetry.epoch, 'replacement timer increments the attempt epoch');
      machine.retry('alpha', firstRetry.generation, firstRetry.epoch, false);
      invariant(!machine.drainEffects(machine.owner('alpha')!).some(({ type }) => type === 'spawn'), 'stale epoch callback no-ops');
      machine.retry('alpha', replacement.generation, replacement.epoch, false);
      invariant(machine.drainEffects(machine.owner('alpha')!).filter(({ type }) => type === 'spawn').length === 1, 'current epoch claims one spawn');
      break;
    }
  }
  return { scenario, observed: true };
}
