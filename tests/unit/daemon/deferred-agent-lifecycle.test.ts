import { describe, expect, it, vi } from 'vitest';
import { DeferredAgentLifecycle } from '../../../src/daemon/deferred-agent-lifecycle';
import { DeferredStartMachine } from '../../../src/daemon/deferred-start-machine';
import { MemoryDeferredStartJournal } from '../../../src/daemon/deferred-start-journal';
import type { DeferredRecord } from '../../../src/daemon/deferred-start-machine';
import { WorktreeLeaseArbiter, type LeaseRecord } from '../../../src/daemon/worktree-lease-arbiter';
import { InternalWorktreeWriterLease } from '../../../src/daemon/internal-worktree-writer-lease';
import { measurePeerCredentials } from '../../../src/daemon/peer-credentials';

class ThrowingJournal extends MemoryDeferredStartJournal<DeferredRecord> {
  override append(): void {
    throw new Error('ENOSPC: durable publication failed');
  }
}

class SecondAppendThrowsJournal extends MemoryDeferredStartJournal<DeferredRecord> {
  calls = 0;
  override append(value: DeferredRecord) {
    this.calls += 1;
    if (this.calls === 2) throw new Error('ENOSPC: transition publication failed');
    return super.append(value);
  }
}

function fixture(blocked = true) {
  let held = blocked;
  let enabled = true;
  const callbacks: Array<() => void> = [];
  const events: string[] = [];
  let releases = 0;
  const lifecycle = new DeferredAgentLifecycle(
    new DeferredStartMachine(new MemoryDeferredStartJournal<DeferredRecord>()),
    {
      custodyVerdict: () => held ? 'blocked' : 'clear',
      acquireCustody: () => !held,
      releaseCustody: () => { releases += 1; },
      enabled: () => enabled,
      stopOld: async agent => { events.push(`stop:${agent}`); },
      spawn: async (agent, token) => {
        events.push(`spawn:${agent}`);
        return { token, pid: 77, kernelIdentity: 'kernel:77:start' };
      },
      reapChild: async agent => { events.push(`reap:${agent}`); },
      deliver: async effect => { events.push(`deliver:${effect.subscriber.id}:${effect.outcome}`); },
      scheduleRetry: callback => { callbacks.push(callback); return callback; },
      cancelRetry: vi.fn(),
      retryDelayMs: 1,
    },
  );
  return {
    lifecycle, callbacks, events,
    release: () => { held = false; },
    disable: () => { enabled = false; },
    releases: () => releases,
  };
}

describe('deferred agent lifecycle integration', () => {
  it('rejected-drain-resets-the-agent-tail-so-the-next-pump-drains', async () => {
    let blocked = true;
    let reapFails = true;
    const events: string[] = [];
    const machine = new DeferredStartMachine(new MemoryDeferredStartJournal<DeferredRecord>());
    const lifecycle = new DeferredAgentLifecycle(machine, {
      custodyVerdict: () => blocked ? 'blocked' : 'clear',
      acquireCustody: () => true,
      releaseCustody: () => {},
      stopOld: async () => {},
      spawn: async (_agent, token) => {
        events.push('spawn:second');
        return { token, pid: 92, kernelIdentity: 'kernel:92' };
      },
      reapChild: async () => {
        events.push('reap:first');
        if (reapFails) throw new Error('first drain rejected');
      },
      deliver: async effect => { events.push(`deliver:${effect.subscriber.id}`); },
      scheduleRetry: callback => callback,
      cancelRetry: () => {},
    });
    lifecycle.request({
      agent: 'alpha', operation: 'start', subscriber: { id: 'first', kind: 'individual' },
    });
    await lifecycle.settled('alpha');
    (lifecycle as unknown as { custodyOwners: Set<string> }).custodyOwners.add('alpha');
    lifecycle.stop('alpha', { token: 'first-child', pid: 91, kernelIdentity: 'kernel:91' });
    await expect(lifecycle.settled('alpha')).rejects.toThrow('first drain rejected');

    blocked = false;
    reapFails = false;
    lifecycle.request({
      agent: 'alpha', operation: 'start', subscriber: { id: 'second', kind: 'individual' },
    });
    await lifecycle.settled('alpha');
    expect(events).toContain('spawn:second');
    expect(events).toContain('deliver:second');
  });

  it('release-custody-failure-retains-owner-and-a-later-pump-retries-release', () => {
    let attempts = 0;
    const machine = new DeferredStartMachine(new MemoryDeferredStartJournal<DeferredRecord>());
    machine.request({
      agent: 'alpha', operation: 'start', custodyBlocked: true,
      subscriber: { id: 'one', kind: 'individual' },
    });
    machine.fail('alpha');
    const lifecycle = new DeferredAgentLifecycle(machine, {
      custodyVerdict: () => 'clear', acquireCustody: () => true,
      releaseCustody: () => {
        attempts += 1;
        if (attempts === 1) throw new Error('transient release failure');
      },
      stopOld: async () => {},
      spawn: async (_agent, token) => ({ token, pid: 1, kernelIdentity: 'kernel:1' }),
      reapChild: async () => {}, deliver: async () => {},
      scheduleRetry: callback => callback, cancelRetry: () => {},
    });
    (lifecycle as unknown as { custodyOwners: Set<string> }).custodyOwners.add('alpha');
    const release = () => (lifecycle as unknown as { releaseCustody(agent: string): void }).releaseCustody('alpha');
    expect(release).toThrow('transient release failure');
    expect(release).not.toThrow();
    expect(attempts).toBe(2);
  });

  it('retry-callback-rejection-keeps-a-live-retry-owner-and-eventually-drains', async () => {
    let blocked = true;
    const callbacks: Array<() => void> = [];
    const events: string[] = [];
    const machine = new DeferredStartMachine(new MemoryDeferredStartJournal<DeferredRecord>());
    const retry = vi.spyOn(machine, 'retry');
    retry.mockImplementationOnce(() => { throw new Error('retry publication failed'); });
    const lifecycle = new DeferredAgentLifecycle(machine, {
      custodyVerdict: () => blocked ? 'blocked' : 'clear', acquireCustody: () => true,
      releaseCustody: () => {}, stopOld: async () => {},
      spawn: async (_agent, token) => {
        events.push('spawn');
        return { token, pid: 4, kernelIdentity: 'kernel:4' };
      },
      reapChild: async () => {}, deliver: async () => {},
      scheduleRetry: callback => { callbacks.push(callback); return callback; },
      cancelRetry: () => {},
    });
    lifecycle.request({ agent: 'alpha', operation: 'start', subscriber: { id: 'one', kind: 'individual' } });
    await lifecycle.settled('alpha');
    blocked = false;
    expect(() => callbacks[0]()).not.toThrow();
    expect(callbacks).toHaveLength(2);
    callbacks[1]();
    await lifecycle.settled('alpha');
    expect(events).toEqual(['spawn']);
  });

  it('deliver-consumer-rejection-does-not-poison-the-next-operation', async () => {
    const events: string[] = [];
    let consumerFails = true;
    const machine = new DeferredStartMachine(new MemoryDeferredStartJournal<DeferredRecord>());
    const lifecycle = new DeferredAgentLifecycle(machine, {
      custodyVerdict: () => 'clear', acquireCustody: () => true, releaseCustody: () => {},
      stopOld: async () => {},
      spawn: async (_agent, token) => {
        events.push('spawn');
        return { token, pid: 5, kernelIdentity: 'kernel:5' };
      },
      reapChild: async () => {},
      deliver: async effect => {
        if (consumerFails) throw new Error('consumer unavailable');
        events.push(`deliver:${effect.subscriber.id}`);
      },
      scheduleRetry: callback => callback, cancelRetry: () => {},
    });
    lifecycle.request({ agent: 'alpha', operation: 'start', subscriber: { id: 'first', kind: 'individual' } });
    await expect(lifecycle.settled('alpha')).rejects.toThrow('consumer unavailable');
    consumerFails = false;
    lifecycle.request({ agent: 'alpha', operation: 'start', subscriber: { id: 'second', kind: 'individual' } });
    await lifecycle.settled('alpha');
    expect(events).toContain('deliver:second');
  });

  for (const reapFails of [true, false]) {
    it(`${reapFails ? 'failed' : 'successful'}-cancellation-reap-${reapFails ? 'retains-custody-blocks-delivery-and-marks-reap-failed' : 'delivers-and-releases-after-proven-reap'}`, async () => {
      const events: string[] = [];
      let releases = 0;
      const machine = new DeferredStartMachine(new MemoryDeferredStartJournal<DeferredRecord>());
      const lifecycle = new DeferredAgentLifecycle(machine, {
        custodyVerdict: () => 'blocked',
        acquireCustody: () => false,
        releaseCustody: () => { releases += 1; },
        stopOld: async () => {},
        spawn: async (_agent, token) => ({ token, pid: 77, kernelIdentity: 'kernel:77' }),
        reapChild: async () => {
          events.push('reap');
          if (reapFails) throw new Error('child still observed live after escalation');
        },
        deliver: async () => { events.push('deliver'); },
        scheduleRetry: () => ({ retry: true }),
        cancelRetry: () => {},
      });
      lifecycle.request({
        agent: 'alpha', operation: 'start', subscriber: { id: 'individual:alpha', kind: 'individual' },
      });
      await lifecycle.settled('alpha');
      // Model the already-owned repository custody of an in-flight row.
      (lifecycle as unknown as { custodyOwners: Set<string> }).custodyOwners.add('alpha');
      lifecycle.stop('alpha', { token: 'bound-child', pid: 77, kernelIdentity: 'kernel:77' });
      if (reapFails) {
        await expect(lifecycle.settled('alpha')).rejects.toThrow('child still observed live');
        expect(events).toEqual(['reap']);
        expect(releases).toBe(0);
        expect(lifecycle.observe('alpha')).toMatchObject({
          state: 'cancelled-by-stop',
          cancellationReapDisposition: 'reap-failed',
          acknowledgedSubscribers: [],
        });
        const contender = lifecycle.request({
          agent: 'beta', operation: 'start', subscriber: { id: 'individual:beta', kind: 'individual' },
        });
        expect(contender.status).toBe('deferred');
      } else {
        await lifecycle.settled('alpha');
        expect(events).toEqual(['reap', 'deliver']);
        expect(releases).toBe(1);
        expect(lifecycle.observe('alpha')).toMatchObject({
          state: 'completed-for-accounting', cancellationReapDisposition: 'reaped',
        });
      }
    });
  }

  it('spawn-failure-after-durable-binding-reaps-before-releasing-custody-and-publishing-failed', async () => {
    const events: string[] = [];
    const machine = new DeferredStartMachine(new MemoryDeferredStartJournal<DeferredRecord>());
    const lifecycle = new DeferredAgentLifecycle(machine, {
      custodyVerdict: () => 'clear',
      acquireCustody: () => true,
      releaseCustody: () => { events.push('release'); },
      stopOld: async () => {},
      spawn: async (agent, token, generation) => {
        machine.bindChildBeforeOnline(agent, { token, pid: 77, kernelIdentity: 'kernel:77' }, generation);
        events.push('bound');
        throw new Error('poller wiring failed');
      },
      reapChild: async () => { events.push('reap'); },
      deliver: async effect => { events.push(`deliver:${effect.outcome}`); },
      scheduleRetry: callback => callback,
      cancelRetry: () => {},
    });
    const result = lifecycle.request({
      agent: 'alpha', operation: 'start', subscriber: { id: 'individual:alpha', kind: 'individual' },
      operationContext: { agentDir: '/alpha' },
    });
    await lifecycle.settled('alpha');
    expect(result.status).toBe('accepted');
    expect(events.slice(0, 3)).toEqual(['bound', 'reap', 'release']);
    expect(machine.observe('alpha')?.outcome).toBe('failed');
  });

  for (const rejection of ['disabled', 'shutdown', 'token-mismatch'] as const) {
    it(`non-adopted-${rejection}-child-is-reaped-before-custody-release`, async () => {
      const events: string[] = [];
      const machine = new DeferredStartMachine(new MemoryDeferredStartJournal<DeferredRecord>());
      const refusedRelease = vi.spyOn(machine, 'custodyReleaseRefused');
      const lifecycle = new DeferredAgentLifecycle(machine, {
        custodyVerdict: () => 'clear', acquireCustody: () => true,
        releaseCustody: () => { events.push('release'); }, stopOld: async () => {},
        spawn: async (agent, token) => {
          events.push('spawn');
          if (rejection === 'disabled') machine.setEnabled(agent, false);
          if (rejection === 'shutdown') machine.shutdown();
          return {
            token: rejection === 'token-mismatch' ? 'wrong-token' : token,
            pid: 88, kernelIdentity: 'kernel:88',
          };
        },
        reapChild: async () => { events.push('reap'); },
        deliver: async effect => { events.push(`deliver:${effect.outcome}`); },
        scheduleRetry: callback => callback, cancelRetry: () => {},
      });
      lifecycle.request({
        agent: 'alpha', operation: 'start', subscriber: { id: 'one', kind: 'individual' },
      });
      await lifecycle.settled('alpha');
      expect(events.indexOf('reap')).toBeGreaterThan(events.indexOf('spawn'));
      expect(events.indexOf('release')).toBeGreaterThan(events.indexOf('reap'));
      expect(events.filter(event => event === 'reap')).toHaveLength(1);
      expect(refusedRelease).not.toHaveBeenCalled();
      expect(machine.observe('alpha')).toMatchObject({
        pendingReapBindings: {}, childReleaseDisposition: 'reaped',
      });
    });
  }

  it('release-refused-while-a-prior-generation-reap-is-pending-then-releases-after-proof', () => {
    for (const order of [[1, 2], [2, 1]]) {
      const machine = new DeferredStartMachine(new MemoryDeferredStartJournal<DeferredRecord>());
      let releases = 0;
      const lifecycle = new DeferredAgentLifecycle(machine, {
        custodyVerdict: () => 'clear', acquireCustody: () => true,
        releaseCustody: () => { releases += 1; }, stopOld: async () => {},
        spawn: async (_agent, token) => ({ token, pid: 1, kernelIdentity: 'kernel:1' }),
        reapChild: async () => {}, deliver: async () => {}, scheduleRetry: callback => callback, cancelRetry: () => {},
      });
      machine.request({
        agent: 'alpha', operation: 'start', custodyBlocked: false,
        subscriber: { id: 'one', kind: 'individual' },
      });
      const first = machine.observe('alpha')!;
      machine.setEnabled('alpha', false);
      const binding1 = { token: 'late-one', pid: 81, kernelIdentity: 'kernel:81' };
      const binding2 = { token: 'late-two', pid: 82, kernelIdentity: 'kernel:82' };
      expect(machine.childPublished('alpha', binding1, first.recordGeneration)).toBe('reap-required');
      expect(machine.childPublished('alpha', binding2, first.recordGeneration + 1)).toBe('reap-required');
      expect(Object.keys(machine.observe('alpha')!.pendingReapBindings ?? {})).toHaveLength(2);

      const bindings = [binding1, binding2];
      machine.pendingChildReaped('alpha', bindings[order[0] - 1]);
      expect(Object.keys(machine.observe('alpha')!.pendingReapBindings ?? {})).toHaveLength(1);
      expect(machine.observe('alpha')?.childReleaseDisposition).not.toBe('reaped');
      (lifecycle as unknown as { custodyOwners: Set<string> }).custodyOwners.add('alpha');
      expect(() => (lifecycle as unknown as { releaseCustody(agent: string): void }).releaseCustody('alpha'))
        .toThrow('bound child may be live');
      expect(releases).toBe(0);
      machine.pendingChildReaped('alpha', bindings[order[1] - 1]);
      expect(machine.observe('alpha')).toMatchObject({
        pendingReapBindings: {}, childReleaseDisposition: 'reaped',
      });
      expect(() => (lifecycle as unknown as { releaseCustody(agent: string): void }).releaseCustody('alpha'))
        .not.toThrow();
      expect(releases).toBe(1);
    }
  });

  it('rejected-child-reap-failure-retains-custody-and-persists-reap-failed', async () => {
    let releases = 0;
    const machine = new DeferredStartMachine(new MemoryDeferredStartJournal<DeferredRecord>());
    const lifecycle = new DeferredAgentLifecycle(machine, {
      custodyVerdict: () => 'clear', acquireCustody: () => true,
      releaseCustody: () => { releases += 1; }, stopOld: async () => {},
      spawn: async (agent, token) => {
        machine.setEnabled(agent, false);
        return { token, pid: 83, kernelIdentity: 'kernel:83' };
      },
      reapChild: async () => { throw new Error('reap failed'); },
      deliver: async () => {}, scheduleRetry: callback => callback, cancelRetry: () => {},
    });
    lifecycle.request({ agent: 'alpha', operation: 'start', subscriber: { id: 'one', kind: 'individual' } });
    await expect(lifecycle.settled('alpha')).rejects.toBeInstanceOf(AggregateError);
    expect(releases).toBe(0);
    expect(machine.observe('alpha')).toMatchObject({ childReleaseDisposition: 'reap-failed' });
    expect(Object.keys(machine.observe('alpha')!.pendingReapBindings ?? {})).toHaveLength(1);
  });

  it('deliver-gates-release-before-acknowledging-a-terminal-outcome', async () => {
    const machine = new DeferredStartMachine(new MemoryDeferredStartJournal<DeferredRecord>());
    const lifecycle = new DeferredAgentLifecycle(machine, {
      custodyVerdict: () => 'clear', acquireCustody: () => true,
      releaseCustody: () => { throw new Error('release refused'); }, stopOld: async () => {},
      spawn: async (_agent, token) => ({ token, pid: 91, kernelIdentity: 'kernel:91' }),
      reapChild: async () => {}, deliver: async () => {}, scheduleRetry: callback => callback, cancelRetry: () => {},
    });
    machine.request({
      agent: 'alpha', operation: 'start', custodyBlocked: true,
      subscriber: { id: 'one', kind: 'individual' },
    });
    machine.fail('alpha');
    const owner = machine.owner('alpha')!;
    const deliver = machine.drainEffects(owner).find(effect => effect.type === 'deliver')!;
    (lifecycle as unknown as { custodyOwners: Set<string> }).custodyOwners.add('alpha');
    await expect((lifecycle as unknown as { apply(effect: typeof deliver): Promise<void> }).apply(deliver))
      .rejects.toThrow('release refused');
    expect(machine.observe('alpha')?.acknowledgedSubscribers).toEqual([]);
  });

  it('spawn-and-release-failures-are-surfaced-together-with-the-spawn-error-as-cause', async () => {
    const machine = new DeferredStartMachine(new MemoryDeferredStartJournal<DeferredRecord>());
    const lifecycle = new DeferredAgentLifecycle(machine, {
      custodyVerdict: () => 'clear', acquireCustody: () => true,
      releaseCustody: () => { throw new Error('release refusal'); }, stopOld: async () => {},
      spawn: async () => { throw new Error('original spawn failure'); },
      reapChild: async () => {}, deliver: async () => {}, scheduleRetry: callback => callback, cancelRetry: () => {},
    });
    lifecycle.request({ agent: 'alpha', operation: 'start', subscriber: { id: 'one', kind: 'individual' } });
    const failure = await lifecycle.settled('alpha').catch(error => error as AggregateError);
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure.cause as Error).message).toBe('original spawn failure');
    expect(failure.errors.map(error => (error as Error).message)).toEqual([
      'original spawn failure', 'release refusal',
    ]);
  });

  it('release-gate-retains-custody-when-spawn-failure-path-local-reap-is-removed', async () => {
    let releases = 0;
    const machine = new DeferredStartMachine(new MemoryDeferredStartJournal<DeferredRecord>());
    vi.spyOn(machine, 'childReapedForRelease').mockImplementation(() => {});
    const lifecycle = new DeferredAgentLifecycle(machine, {
      custodyVerdict: () => 'clear', acquireCustody: () => true,
      releaseCustody: () => { releases += 1; }, stopOld: async () => {},
      spawn: async (agent, token, generation) => {
        machine.bindChildBeforeOnline(agent, { token, pid: 77, kernelIdentity: 'kernel:77' }, generation);
        throw new Error('post-binding setup failed');
      },
      reapChild: async () => {},
      deliver: async () => {}, scheduleRetry: callback => callback, cancelRetry: () => {},
    });
    lifecycle.request({ agent: 'alpha', operation: 'start', subscriber: { id: 'one', kind: 'individual' } });
    await expect(lifecycle.settled('alpha')).rejects.toBeInstanceOf(AggregateError);
    expect(releases).toBe(0);
    expect(machine.observe('alpha')).toMatchObject({
      childBinding: { pid: 77 }, childReleaseDisposition: 'reap-failed',
    });
  });

  it('a-guard-evaluation-acquires-nothing', () => {
    let persisted: LeaseRecord | undefined;
    let publications = 0;
    const arbiter = new WorktreeLeaseArbiter({
      persistence: {
        publish(record) { publications += 1; persisted = record; },
        remove() { persisted = undefined; },
        load() { return persisted; },
      },
      observeIdentity: () => 'matching-live',
      createToken: () => 'opaque-token',
    });
    const peer = measurePeerCredentials(3, {
      readPeerCredentials: () => ({ pid: 101, platform: 'linux' }),
    }, { readStartIdentity: () => 'kernel:101' });
    const writer = new InternalWorktreeWriterLease({
      scopeKey: 'repo:/canonical/repo',
      arbiter,
      peer: () => peer,
      createRequest: () => ({
        loadOrCreate: () => '00000000-0000-4000-8000-000000000001',
        removeAfterRelease: () => {},
      } as never),
    });
    const lifecycle = new DeferredAgentLifecycle(
      new DeferredStartMachine(new MemoryDeferredStartJournal<DeferredRecord>()),
      {
        custodyVerdict: agent => writer.custodyVerdict(agent),
        acquireCustody: agent => writer.acquire(agent),
        releaseCustody: agent => writer.release(agent),
        stopOld: async () => {},
        spawn: async (_agent, token) => ({ token, pid: 1, kernelIdentity: 'kernel:1' }),
        reapChild: async () => {},
        deliver: async () => {},
        scheduleRetry: callback => callback,
        cancelRetry: () => {},
      },
    );

    expect(lifecycle.custodyBlocked('alpha')).toBe(false);
    expect(publications).toBe(0);
  });

  it('row-failure-unwinds-what-its-effect-acquired', async () => {
    const journal = new SecondAppendThrowsJournal();
    let releases = 0;
    const lifecycle = new DeferredAgentLifecycle(new DeferredStartMachine(journal), {
      custodyVerdict: () => 'clear',
      acquireCustody: () => true,
      releaseCustody: () => { releases += 1; },
      stopOld: async () => {},
      spawn: async (_agent, token) => ({ token, pid: 1, kernelIdentity: 'kernel:1' }),
      reapChild: async () => {},
      deliver: async () => {},
      scheduleRetry: callback => callback,
      cancelRetry: () => {},
    });
    lifecycle.request({
      agent: 'alpha', operation: 'start', subscriber: { id: 'one', kind: 'individual' },
    });
    await lifecycle.settled('alpha');
    expect(releases).toBe(1);
    expect(journal.latest('alpha')?.value).toMatchObject({ state: 'completed-for-accounting', outcome: 'failed' });
  });

  it('a-drain-cannot-be-named-for-a-non-owner', async () => {
    const f = fixture(true);
    f.lifecycle.request({ agent: 'alpha', operation: 'start', subscriber: { id: 'one', kind: 'individual' } });
    await expect(f.lifecycle.settled('shutdown')).rejects.toThrow(/owner/i);
  });

  it('a-forged-owner-cannot-drain-an-agent-effect-queue', () => {
    const machine = new DeferredStartMachine(new MemoryDeferredStartJournal<DeferredRecord>());
    machine.request({
      agent: 'alpha', operation: 'start', custodyBlocked: true,
      subscriber: { id: 'one', kind: 'individual' },
    });
    expect(() => machine.drainEffects({ agent: 'alpha' } as never)).toThrow(/owner/i);
    expect(machine.drainEffects(machine.owner('alpha')!)).toHaveLength(1);
  });

  it('shutdown-completes-only-after-every-agent-owned-effect-drains', async () => {
    const deliveries = new Map<string, () => void>();
    const lifecycle = new DeferredAgentLifecycle(
      new DeferredStartMachine(new MemoryDeferredStartJournal<DeferredRecord>()),
      {
        custodyVerdict: () => 'blocked',
        acquireCustody: () => false,
        stopOld: async () => {},
        spawn: async (_agent, token) => ({ token, pid: 1, kernelIdentity: 'kernel:1' }),
        reapChild: async () => {},
        deliver: effect => new Promise<void>(resolve => { deliveries.set(effect.agent, resolve); }),
        scheduleRetry: callback => callback,
        cancelRetry: () => {},
      },
    );
    lifecycle.request({ agent: 'alpha', operation: 'start', subscriber: { id: 'a', kind: 'fleet' } });
    lifecycle.request({ agent: 'beta', operation: 'start', subscriber: { id: 'b', kind: 'fleet' } });
    await Promise.all([lifecycle.settled('alpha'), lifecycle.settled('beta')]);

    let shutdownComplete = false;
    const shutdown = lifecycle.shutdown().then(() => { shutdownComplete = true; });
    await vi.waitFor(() => expect([...deliveries.keys()].sort()).toEqual(['alpha', 'beta']));
    expect(shutdownComplete).toBe(false);
    deliveries.get('alpha')!();
    await Promise.resolve();
    expect(shutdownComplete).toBe(false);
    deliveries.get('beta')!();
    await shutdown;
    expect(shutdownComplete).toBe(true);
  });

  it('request-publication failure occurs before custody acquisition', () => {
    let custodyHeld = false;
    let releases = 0;
    const lifecycle = new DeferredAgentLifecycle(
      new DeferredStartMachine(new ThrowingJournal()),
      {
        custodyVerdict: () => 'clear',
        acquireCustody: () => { custodyHeld = true; return true; },
        releaseCustody: () => {
          custodyHeld = false;
          releases += 1;
        },
        stopOld: async () => {},
        spawn: async (_agent, token) => ({ token, pid: 77, kernelIdentity: 'kernel:77:start' }),
        reapChild: async () => {},
        deliver: async () => {},
        scheduleRetry: callback => callback,
        cancelRetry: () => {},
      },
    );

    expect(() => lifecycle.request({
      agent: 'alpha', operation: 'start', subscriber: { id: 'ipc:1', kind: 'individual' },
    })).toThrow(/ENOSPC/);
    expect(custodyHeld).toBe(false);
    expect(releases).toBe(0);
  });

  it('gives an ordinary IPC-style start a retry owner and spawns after release', async () => {
    const f = fixture();
    const result = f.lifecycle.request({
      agent: 'alpha', operation: 'start', subscriber: { id: 'ipc:1', kind: 'individual' },
    });
    expect(result.status).toBe('deferred');
    await f.lifecycle.settled('alpha');
    expect(f.callbacks).toHaveLength(1);
    f.release(); f.callbacks[0]();
    await f.lifecycle.settled('alpha');
    expect(f.events).toEqual(['spawn:alpha', 'deliver:ipc:1:spawned']);
    expect(f.releases()).toBe(1);
    expect(f.lifecycle.observe('alpha')?.state).toBe('completed-for-accounting');
  });

  it('successful-spawn-handoff-releases-custody-so-another-agent-can-acquire', async () => {
    const f = fixture(false);
    f.lifecycle.request({
      agent: 'alpha', operation: 'start', subscriber: { id: 'alpha:start', kind: 'individual' },
    });
    await f.lifecycle.settled('alpha');
    f.lifecycle.request({
      agent: 'beta', operation: 'start', subscriber: { id: 'beta:start', kind: 'individual' },
    });
    await f.lifecycle.settled('beta');
    expect(f.events).toEqual([
      'spawn:alpha', 'deliver:alpha:start:spawned',
      'spawn:beta', 'deliver:beta:start:spawned',
    ]);
    expect(f.releases()).toBe(2);
  });

  it('keeps restart stop and start phases in one receipt and reports completion only after spawn', async () => {
    const f = fixture(false);
    const result = f.lifecycle.request({
      agent: 'alpha', operation: 'restart', oldProcessIdentity: 'old:alpha',
      subscriber: { id: 'fleet:alpha', kind: 'fleet' },
    });
    await f.lifecycle.settled('alpha');
    expect(result.record.operation).toBe('restart');
    expect(f.events).toEqual(['stop:alpha', 'spawn:alpha', 'deliver:fleet:alpha:spawned']);
  });

  it('explicit stop cancels the retry before custody release can spawn', async () => {
    const f = fixture();
    f.lifecycle.request({ agent: 'alpha', operation: 'start', subscriber: { id: 'one', kind: 'individual' } });
    await f.lifecycle.settled('alpha');
    f.lifecycle.stop('alpha');
    f.release(); f.callbacks[0]();
    await f.lifecycle.settled('alpha');
    expect(f.events).not.toContain('spawn:alpha');
    expect(f.lifecycle.observe('alpha')?.state).toBe('completed-for-accounting');
  });

  it('rechecks registry enablement before a custody retry can spawn', async () => {
    const f = fixture();
    f.lifecycle.request({ agent: 'alpha', operation: 'start', subscriber: { id: 'one', kind: 'individual' } });
    await f.lifecycle.settled('alpha');
    f.disable(); f.release(); f.callbacks[0]();
    await f.lifecycle.settled('alpha');
    expect(f.events).not.toContain('spawn:alpha');
    expect(f.lifecycle.observe('alpha')?.outcome).toBe('cancelled-by-stop');
  });
});
