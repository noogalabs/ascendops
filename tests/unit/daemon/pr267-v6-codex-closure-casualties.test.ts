import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IPCRequest, IPCResponse } from '../../../src/types/index.js';
import { DeferredAgentLifecycle } from '../../../src/daemon/deferred-agent-lifecycle';
import { MemoryDeferredStartJournal } from '../../../src/daemon/deferred-start-journal';
import { DeferredStartMachine, type DeferredRecord } from '../../../src/daemon/deferred-start-machine';
import { measurePeerCredentials } from '../../../src/daemon/peer-credentials';
import {
  WorktreeLeaseArbiter,
  type LeasePersistence,
  type LeaseRecord,
} from '../../../src/daemon/worktree-lease-arbiter';

vi.mock('../../../src/daemon/agent-process.js', () => ({
  AgentProcess: class {
    readonly name: string;
    private status: 'stopped' | 'running' = 'stopped';
    private pid?: number;
    constructor(name: string) { this.name = name; }
    adoptExternalProcess(binding: { pid: number }) { this.pid = binding.pid; this.status = 'running'; }
    getStatus() { return { name: this.name, status: this.status, pid: this.pid }; }
    async stop() { this.status = 'stopped'; this.pid = undefined; }
    getAgentDir() { return ''; }
    getConfig() { return {}; }
    injectMessageDetailed() { return { ok: false, code: 'ADMISSION_FAILED', message: 'adopted child has no PTY' }; }
  },
}));
vi.mock('../../../src/daemon/worker-process.js', () => ({ WorkerProcess: class {} }));
vi.mock('../../../src/daemon/fast-checker.js', () => ({
  FastChecker: class { start() { return Promise.resolve(); } stop() {} },
}));
vi.mock('../../../src/daemon/slack-socket-listener.js', () => ({ SlackSocketListener: class {} }));
vi.mock('../../../src/telegram/api.js', () => ({ TelegramAPI: class {} }));
vi.mock('../../../src/telegram/poller.js', () => ({ TelegramPoller: class {} }));

const { AgentManager } = await import('../../../src/daemon/agent-manager.js');
const { IPCServer, IPC_ADMISSION_BUDGET_MS } = await import('../../../src/daemon/ipc-server.js');

const requestA = '00000000-0000-4000-8000-000000000001';
const requestB = '00000000-0000-4000-8000-000000000002';
const scope = 'repo:/canonical/repo';
const roots: string[] = [];

class MemoryLeaseStore implements LeasePersistence {
  record?: LeaseRecord;
  withScopeLock<T>(_scopeKey: string, operation: () => T): T { return operation(); }
  publish(record: LeaseRecord) { this.record = record; }
  remove() { this.record = undefined; }
  load() { return this.record; }
}

function peer(pid: number) {
  return measurePeerCredentials(9, {
    readPeerCredentials: () => ({ pid, platform: 'linux' }),
  }, { readStartIdentity: () => `boot:start:${pid}` });
}

type Harness = {
  manager: InstanceType<typeof AgentManager>;
  lifecycle: DeferredAgentLifecycle;
  journal: MemoryDeferredStartJournal<DeferredRecord>;
  setHeld(value: boolean): void;
  callbacks: Array<() => void>;
  starts: string[];
  startDirs: string[];
  startFleet: Array<boolean | undefined>;
  agents: Map<string, unknown>;
};

function record(agent: string, state: DeferredRecord['state']): DeferredRecord {
  return {
    agent,
    receiptId: `${agent}:persisted:1`,
    operation: 'restart',
    state,
    phase: state === 'restart-pending' ? 'before-stop' : 'after-stop',
    recordGeneration: 1,
    attemptEpoch: 0,
    hasRetryOwner: false,
    enabled: true,
    oldProcessIdentity: 'pid:42',
    subscribers: [{ id: `boot:${agent}`, kind: 'fleet' }],
    acknowledgedSubscribers: [],
  };
}

function managerHarness(
  initialHeld: boolean,
  persisted?: DeferredRecord,
  identityObserver: (pid: number) => string = pid => `kernel:${pid}`,
): Harness {
  const root = mkdtempSync(join(tmpdir(), 'pr267-codex-closure-'));
  roots.push(root);
  const ctxRoot = join(root, 'instance');
  const frameworkRoot = join(root, 'framework');
  mkdirSync(join(ctxRoot, 'config'), { recursive: true });
  mkdirSync(join(frameworkRoot, 'orgs', 'acme', 'agents'), { recursive: true });
  const manager = new AgentManager('test', ctxRoot, frameworkRoot, 'acme');
  const agents = (manager as unknown as { agents: Map<string, unknown> }).agents;
  const journal = new MemoryDeferredStartJournal<DeferredRecord>();
  if (persisted) journal.append(persisted);
  const machine = new DeferredStartMachine(journal);
  let held = initialHeld;
  const callbacks: Array<() => void> = [];
  const starts: string[] = [];
  const startDirs: string[] = [];
  const startFleet: Array<boolean | undefined> = [];

  vi.spyOn(manager, 'startAgent').mockImplementation(async (name, agentDir, _config, _org, options) => {
    starts.push(name);
    startDirs.push(agentDir);
    startFleet.push(options.partOfFleetStart);
    const pid = name === 'alpha' ? 101 : 202;
    await options.deferredBeforeOnline?.(pid);
    agents.set(name, {
      process: { getStatus: () => ({ name, status: 'running', pid }) },
      checker: {},
    });
  });
  vi.spyOn(manager, 'stopAgent').mockImplementation(async (name) => { agents.delete(name); });

  const lifecycle = new DeferredAgentLifecycle(machine, {
    custodyVerdict: () => held === undefined ? 'unknown' : held ? 'blocked' : 'clear',
    acquireCustody: () => held === false,
    enabled: name => manager.isAgentEnabledForDeferred(name),
    stopOld: (name, identity) => manager.executeDeferredStop(name, identity),
    spawn: (name, token, generation) => manager.executeDeferredSpawn(name, token, generation),
    reapChild: (name, binding) => manager.reapDeferredChild(name, binding),
    deliver: effect => manager.completeDeferredSubscriber(effect),
    scheduleRetry: callback => {
      const handle = { callback, cancelled: false };
      callbacks.push(() => { if (!handle.cancelled) handle.callback(); });
      return handle;
    },
    cancelRetry: handle => { (handle as { cancelled: boolean }).cancelled = true; },
  });
  manager.configureDeferredLifecycle(lifecycle, identityObserver);
  return { manager, lifecycle, journal, setHeld: value => { held = value; }, callbacks, starts, startDirs, startFleet, agents };
}

async function dispatchStart(manager: InstanceType<typeof AgentManager>, agent: string): Promise<IPCResponse> {
  const socket = { write: vi.fn(), end: vi.fn() };
  const server = new IPCServer(manager);
  await (server as unknown as {
    handleRequest(request: IPCRequest, socket: typeof socket): Promise<void>;
  }).handleRequest({ type: 'start-agent', agent, source: 'test' }, socket);
  return JSON.parse(socket.write.mock.calls[0][0]) as IPCResponse;
}

describe('PR267 exact-head Codex closure casualties', () => {
  it('deferred-shutdown-failure-does-not-abort-stop-all-agent-markers-and-stops', async () => {
    const h = managerHarness(false);
    h.agents.set('alpha', {
      process: { getStatus: () => ({ name: 'alpha', status: 'running', pid: 101 }) }, checker: {},
    });
    vi.spyOn(h.lifecycle, 'shutdown').mockRejectedValueOnce(new Error('reap failed'));
    await expect(h.manager.stopAll()).resolves.toBeUndefined();
    expect(h.manager.stopAgent).toHaveBeenCalledWith('alpha');
  });

  it('persisted-boot-deferral-is-accounted-so-the-next-fleet-batch-can-open', async () => {
    const persisted = {
      ...record('alpha', 'deferred-with-owner'),
      operation: 'start' as const,
      subscribers: [{ id: 'individual:alpha:old', kind: 'individual' as const }],
      hasRetryOwner: true,
    };
    const h = managerHarness(true, persisted);
    const agentDir = join(
      (h.manager as unknown as { frameworkRoot: string }).frameworkRoot,
      'orgs', 'acme', 'agents', 'alpha',
    );
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(join(agentDir, 'config.json'), JSON.stringify({ enabled: true }));
    await h.manager.discoverAndStart();
    expect((h.manager as unknown as { fleetStartBatch: unknown }).fleetStartBatch).toBeNull();
  });

  it('deferred-restart-all-opens-the-fleet-batch-before-any-completion', async () => {
    const h = managerHarness(true);
    await h.manager.admitRestartAgent('alpha', {
      partOfFleetStart: true,
      fleetTotal: 2,
      fleetIndex: 0,
    });
    expect((h.manager as unknown as {
      fleetStartBatch: { expected: number; source: string } | null;
    }).fleetStartBatch).toMatchObject({ expected: 2, source: 'restart-all' });
  });

  it('refused-deferred-fleet-admission-is-accounted-and-the-next-batch-opens', async () => {
    const h = managerHarness(undefined as never);
    const agentDir = join(
      (h.manager as unknown as { frameworkRoot: string }).frameworkRoot,
      'orgs', 'acme', 'agents', 'alpha',
    );
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(join(agentDir, 'config.json'), JSON.stringify({ enabled: true }));

    await h.manager.discoverAndStart();
    expect((h.manager as unknown as { fleetStartBatch: unknown }).fleetStartBatch).toBeNull();

    h.setHeld(false);
    await h.manager.discoverAndStart();
    await h.lifecycle.settled('alpha');
    expect(h.starts).toEqual(['alpha']);
    expect((h.manager as unknown as { fleetStartBatch: unknown }).fleetStartBatch).toBeNull();
  });

  it('boot-reconstruction-rejection-is-not-memoized-across-later-admission', async () => {
    const h = managerHarness(false, record('alpha', 'restart-pending'));
    const agentDir = join(
      (h.manager as unknown as { frameworkRoot: string }).frameworkRoot,
      'orgs', 'acme', 'agents', 'alpha',
    );
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(join(agentDir, 'config.json'), JSON.stringify({ enabled: true }));
    const settled = vi.spyOn(h.lifecycle, 'settled');
    settled.mockRejectedValueOnce(new Error('boot drain failed'));
    await expect(h.manager.discoverAndStart()).rejects.toThrow('boot drain failed');
    await h.manager.discoverAndStart();
    await h.lifecycle.settled('alpha');
    expect(h.starts.length).toBeGreaterThan(0);
  });

  it('reconstruction-removes-a-dead-binding-without-signalling-a-reused-pid', async () => {
    const h = managerHarness(false, undefined, () => 'kernel:reused-stranger');
    h.agents.set('alpha', {
      process: { getStatus: () => ({ name: 'alpha', status: 'running', pid: 83 }) }, checker: {},
    });
    await h.manager.reapDeferredChild('alpha', {
      token: 'old-child', pid: 83, kernelIdentity: 'kernel:original-child',
    });
    expect(h.manager.stopAgent).not.toHaveBeenCalled();
    expect(h.agents.has('alpha')).toBe(true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it('custody-acquisition-is-a-row-effect-and-unwinds-on-any-non-completion before durable publish', () => {
    let acquisitions = 0;
    const journal = {
      keys: () => [] as string[],
      latest: () => undefined,
      append: () => { throw new Error('publish failed'); },
    } as unknown as MemoryDeferredStartJournal<DeferredRecord>;
    const machine = new DeferredStartMachine(journal);
    const lifecycle = new DeferredAgentLifecycle(machine, {
      custodyVerdict: () => 'clear',
      acquireCustody: () => { acquisitions += 1; return true; },
      releaseCustody: vi.fn(),
      stopOld: vi.fn(), spawn: vi.fn(), reapChild: vi.fn(), deliver: vi.fn(),
      scheduleRetry: vi.fn(), cancelRetry: vi.fn(),
    });
    expect(() => lifecycle.request({
      agent: 'alpha', operation: 'start',
      subscriber: { id: 'alpha:one', kind: 'individual' },
    })).toThrow(/publish failed/);
    expect(acquisitions).toBe(0);
  });

  it('custody-acquisition-is-a-row-effect-and-unwinds-on-any-non-completion for in-flight verdicts', () => {
    const machine = new DeferredStartMachine(new MemoryDeferredStartJournal<DeferredRecord>());
    machine.request({
      agent: 'alpha', operation: 'start', custodyBlocked: true,
      subscriber: { id: 'alpha:first', kind: 'individual' },
    });
    let held = false;
    const lifecycle = new DeferredAgentLifecycle(machine, {
      custodyVerdict: () => held ? 'blocked' : 'clear',
      acquireCustody: () => { if (held) return false; held = true; return true; },
      releaseCustody: () => { held = false; },
      stopOld: vi.fn(), spawn: vi.fn(), reapChild: vi.fn(), deliver: vi.fn(),
      scheduleRetry: vi.fn(), cancelRetry: vi.fn(),
    });
    expect(lifecycle.request({
      agent: 'alpha', operation: 'restart',
      subscriber: { id: 'alpha:second', kind: 'individual' },
    }).status).toBe('in-flight');
    expect(held).toBe(false);
    expect(lifecycle.request({
      agent: 'beta', operation: 'start',
      subscriber: { id: 'beta:first', kind: 'individual' },
    }).status).not.toBe('refused');
  });

  it('terminal reconstruction emits no custody acquisition effect', () => {
    const journal = new MemoryDeferredStartJournal<DeferredRecord>();
    journal.append({
      ...record('alpha', 'completed-for-accounting'),
      outcome: 'spawned',
    });
    let held = false;
    const lifecycle = new DeferredAgentLifecycle(new DeferredStartMachine(journal), {
      custodyVerdict: () => held ? 'blocked' : 'clear',
      acquireCustody: () => { held = true; return true; },
      releaseCustody: () => { held = false; },
      stopOld: vi.fn(), spawn: vi.fn(), reapChild: vi.fn(), deliver: vi.fn(),
      scheduleRetry: vi.fn(), cancelRetry: vi.fn(),
    });
    lifecycle.reconstruct('alpha', {
      oldIdentity: 'absent', replacementIdentity: 'absent', custodyBlocked: false,
    });
    expect(held).toBe(false);
  });

  it('custody-acquisition-is-a-row-effect-and-unwinds-on-any-non-completion when the row is cancelled before acquisition drains', async () => {
    const machine = new DeferredStartMachine(new MemoryDeferredStartJournal<DeferredRecord>());
    let held = false;
    let releases = 0;
    const lifecycle = new DeferredAgentLifecycle(machine, {
      custodyVerdict: () => 'clear',
      acquireCustody: () => { held = true; return true; },
      releaseCustody: () => { held = false; releases += 1; },
      stopOld: vi.fn(), spawn: vi.fn(), reapChild: vi.fn(), deliver: vi.fn(),
      scheduleRetry: vi.fn(), cancelRetry: vi.fn(),
    });
    lifecycle.request({
      agent: 'alpha', operation: 'start',
      subscriber: { id: 'alpha:one', kind: 'individual' },
    });
    lifecycle.stop('alpha');
    await lifecycle.settled('alpha');
    expect(held).toBe(false);
    expect(releases).toBe(1);
  });

  it('each operation owns the spawn context used by its completion', async () => {
    const h = managerHarness(false);
    await h.manager.admitStartAgent('alpha', '/fleet-dir', undefined, undefined, { partOfFleetStart: true });
    await h.lifecycle.settled('alpha');
    await h.manager.admitRestartAgent('alpha', { partOfFleetStart: false });
    await h.lifecycle.settled('alpha');
    expect(h.startFleet).toEqual([true, false]);
  });

  it('completed historical records never satisfy a fresh enabled boot admission', async () => {
    const historical: DeferredRecord = {
      ...record('alpha', 'completed-for-accounting'),
      operation: 'start',
      outcome: 'spawned',
    };
    const h = managerHarness(false, historical);
    const agentDir = join((h.manager as unknown as { frameworkRoot: string }).frameworkRoot, 'orgs', 'acme', 'agents', 'alpha');
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(join(agentDir, 'config.json'), JSON.stringify({ enabled: true }));
    await h.manager.discoverAndStart();
    await h.lifecycle.settled('alpha');
    expect(h.starts).toEqual(['alpha']);
    expect(h.lifecycle.observe('alpha')?.recordGeneration).toBe(2);
  });

  for (const terminalState of ['failed', 'cancelled-by-stop', 'cancelled-by-shutdown'] as const) {
    it(`recovered-${terminalState}-receipt-delivers-history-then-allows-fresh-enabled-boot-admission`, async () => {
      const persisted: DeferredRecord = {
        ...record('alpha', terminalState),
        operation: 'start',
        state: terminalState,
        outcome: terminalState,
      };
      const h = managerHarness(false, persisted);
      await h.manager.admitStartAgent('alpha', '/alpha');
      await h.lifecycle.settled('alpha');
      expect(h.starts).toEqual(['alpha']);
      expect(h.lifecycle.observe('alpha')).toMatchObject({ outcome: 'spawned' });
      expect(h.lifecycle.observe('alpha')!.recordGeneration).toBeGreaterThan(persisted.recordGeneration);
    });
  }

  it('C1 retained live state requires fresh holder observation', () => {
    const store = new MemoryLeaseStore();
    let holderLive = true;
    const arbiter = new WorktreeLeaseArbiter({
      persistence: store,
      observeIdentity: () => holderLive ? 'matching-live' : 'dead-or-reused',
      createToken: () => store.record ? 'token-next' : 'token-first',
    });
    expect(arbiter.acquire({ scopeKey: scope, requestId: requestA, owner: 'first', peer: peer(101) }).kind)
      .toBe('granted');
    holderLive = false;
    expect(arbiter.acquire({ scopeKey: scope, requestId: requestB, owner: 'next', peer: peer(202) }))
      .toMatchObject({ kind: 'granted', recovered: false });
    expect(store.record).toMatchObject({ requestId: requestB, pid: 202 });
  });

  it('C1 live same-request recovery preserves the exact token without a second allocation', () => {
    const store = new MemoryLeaseStore();
    let publishCount = 0;
    store.publish = (lease) => { publishCount += 1; store.record = lease; };
    const arbiter = new WorktreeLeaseArbiter({
      persistence: store,
      observeIdentity: () => 'matching-live',
      createToken: () => 'exact-token',
    });
    expect(arbiter.acquire({ scopeKey: scope, requestId: requestA, owner: 'first', peer: peer(101) }))
      .toMatchObject({ kind: 'granted', token: 'exact-token', recovered: false });
    expect(arbiter.acquire({ scopeKey: scope, requestId: requestA, owner: 'first', peer: peer(101) }))
      .toEqual({ kind: 'granted', token: 'exact-token', recovered: true });
    expect(publishCount).toBe(1);
  });

  it('C2 reconstruction cannot spawn without a clear custody verdict', async () => {
    const h = managerHarness(true, { ...record('alpha', 'start-pending'), operation: 'start' });
    mkdirSync(join((h.manager as unknown as { frameworkRoot: string }).frameworkRoot, 'orgs', 'acme', 'agents', 'alpha'), { recursive: true });
    const response = await dispatchStart(h.manager, 'alpha');
    expect(h.starts).toEqual([]);
    expect(response).toMatchObject({ success: false, code: 'ADMISSION_FAILED' });
    expect(h.callbacks).toHaveLength(1);
    h.setHeld(false);
    h.callbacks[0]();
    await h.lifecycle.settled('alpha');
    expect(h.starts).toEqual(['alpha']);
  });

  it('C3 held boot reconstruction owns one retry and reaches one running replacement', async () => {
    const h = managerHarness(true, record('alpha', 'restart-pending'));
    const agentDir = join((h.manager as unknown as { frameworkRoot: string }).frameworkRoot, 'orgs', 'acme', 'agents', 'alpha');
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(join(agentDir, 'config.json'), JSON.stringify({ enabled: true }));
    await h.manager.discoverAndStart();
    expect(h.starts).toEqual([]);
    expect(h.callbacks).toHaveLength(1);
    h.setHeld(false);
    h.callbacks[0]();
    await h.lifecycle.settled('alpha');
    expect(h.starts).toEqual(['alpha']);
    expect(h.manager.getAgentStatus('alpha')).toMatchObject({ status: 'running' });
    expect(h.lifecycle.observe('alpha')?.state).toBe('completed-for-accounting');
  });

  it('reconstructed-retry-reloads-persisted-source-config-and-cancels-a-disabled-agent', async () => {
    const agentDir = mkdtempSync(join(tmpdir(), 'pr267-disabled-retry-'));
    roots.push(agentDir);
    writeFileSync(join(agentDir, 'config.json'), JSON.stringify({ enabled: false }));
    const persisted: DeferredRecord = {
      ...record('alpha', 'deferred-with-owner'),
      operation: 'start',
      hasRetryOwner: true,
      operationContext: { agentDir, config: { enabled: true } },
    };
    const h = managerHarness(true, persisted);
    const result = await h.manager.admitStartAgent('alpha', agentDir);
    expect(result?.status).toBe('deferred');
    expect(h.callbacks).toHaveLength(1);
    h.setHeld(false);
    h.callbacks[0]();
    await h.lifecycle.settled('alpha');
    expect(h.starts).toEqual([]);
    expect(h.lifecycle.observe('alpha')).toMatchObject({
      state: 'completed-for-accounting', outcome: 'cancelled-by-stop', enabled: false,
    });
  });

  it('C4 per-agent pumps isolate pending and rejected effects across agents', async () => {
    const h = managerHarness(false);
    h.agents.set('alpha', {
      process: { getStatus: () => ({ name: 'alpha', status: 'running', pid: 42 }) },
      checker: {},
    });
    let rejectAlpha!: (error: Error) => void;
    let alphaPending!: () => void;
    const pending = new Promise<void>((_resolve, reject) => { rejectAlpha = reject; });
    const entered = new Promise<void>((resolve) => { alphaPending = resolve; });
    vi.mocked(h.manager.stopAgent).mockImplementationOnce(async () => {
      alphaPending();
      await pending;
    });
    const first = h.manager.admitRestartAgent('alpha');
    // Queue beta before either pump can drain. A shared effect splice can otherwise
    // transfer beta onto alpha's pending chain while still eventually executing it.
    const beta = h.manager.admitStartAgent('beta', '');
    await entered;
    let nextError: unknown;
    try { await beta; } catch (error) { nextError = error; }
    await h.lifecycle.settled('beta');
    expect(nextError).toBeUndefined();
    expect(h.starts).toContain('beta');
    expect(h.manager.getAgentStatus('beta')).toMatchObject({ status: 'running' });
    rejectAlpha(new Error('stopOld rejected'));
    let firstError: unknown;
    try { await first; } catch (error) { firstError = error; }
    await h.lifecycle.settled('alpha');
    expect(firstError).toBeUndefined();
    expect(h.lifecycle.observe('alpha')?.outcome).toBe('failed');
  });

  it('C4 effect ownership forbids an unscoped drain across agents', () => {
    const machine = new DeferredStartMachine(new MemoryDeferredStartJournal<DeferredRecord>());
    machine.request({
      agent: 'alpha', operation: 'start', custodyBlocked: true,
      subscriber: { id: 'alpha:one', kind: 'individual' },
    });
    machine.request({
      agent: 'beta', operation: 'start', custodyBlocked: true,
      subscriber: { id: 'beta:one', kind: 'individual' },
    });

    const partitions = (machine as unknown as {
      effectsByAgent: Map<string, unknown[]>;
    }).effectsByAgent;
    expect(partitions).toBeInstanceOf(Map);
    expect([...partitions.keys()].sort()).toEqual(['alpha', 'beta']);
    const unscopedDrain = machine.drainEffects.bind(machine) as () => unknown;
    expect(() => unscopedDrain()).toThrow(/agent|scope|owner/i);
  });

  it('cancellation-effects-reach-the-agent-they-cancel', async () => {
    const h = managerHarness(true);
    await h.manager.admitStartAgent('alpha', '');
    await h.manager.admitStartAgent('beta', '');
    expect(h.callbacks).toHaveLength(2);
    h.lifecycle.stop('alpha');
    await h.lifecycle.settled('alpha');
    h.setHeld(false);
    for (const callback of h.callbacks) callback();
    await h.lifecycle.settled('beta');
    expect(h.starts).toEqual(['beta']);
    expect(h.lifecycle.observe('alpha')?.outcome).toBe('cancelled-by-stop');
    expect(h.manager.getAgentStatus('beta')).toMatchObject({ status: 'running' });
  });

  it('one-agent-fleet-accounting-cannot-complete-or-fail-another', async () => {
    const h = managerHarness(false);
    const batch = {
      expected: 2,
      completed: new Set<string>(),
      online: new Set<string>(),
      notifyHandle: null,
      source: 'daemon-boot' as const,
    };
    (h.manager as unknown as { fleetStartBatch: typeof batch }).fleetStartBatch = batch;
    const complete = h.manager.completeDeferredSubscriber.bind(h.manager);
    vi.spyOn(h.manager, 'completeDeferredSubscriber').mockImplementation(async (effect) => {
      if (effect.agent === 'alpha') throw new Error('alpha completion failed');
      await complete(effect);
    });
    await h.manager.admitStartAgent('alpha', '', undefined, undefined, { partOfFleetStart: true });
    await h.manager.admitStartAgent('beta', '', undefined, undefined, { partOfFleetStart: true });
    const outcomes = await Promise.allSettled([
      h.lifecycle.settled('alpha'), h.lifecycle.settled('beta'),
    ]);
    expect(outcomes.map(outcome => outcome.status)).toEqual(['rejected', 'fulfilled']);
    expect([...batch.completed]).toEqual(['beta']);
    expect([...batch.online]).toEqual(['beta']);
    expect(h.lifecycle.observe('beta')?.state).toBe('completed-for-accounting');
  });

  it('deduped-request-cannot-replace-the-admitted-operation-inputs', async () => {
    const h = managerHarness(true);
    const first = h.manager.admitStartAgent('alpha', '/canonical/first');
    await first;
    const duplicate = h.manager.admitStartAgent('alpha', '/attacker/replacement');
    await duplicate;
    expect(h.starts).toEqual([]);
    h.setHeld(false);
    h.callbacks[0]();
    await h.lifecycle.settled('alpha');
    expect(h.startDirs).toEqual(['/canonical/first']);
  });

  it('live-restart-records-a-measured-old-process-identity', async () => {
    const h = managerHarness(true);
    h.agents.set('alpha', {
      process: { getStatus: () => ({ name: 'alpha', status: 'running', pid: 101 }) },
      checker: {},
    });
    await h.manager.admitRestartAgent('alpha');
    expect(h.journal.latest('alpha')?.value.oldProcessIdentity).toBe('kernel:101');
  });

  it('ipc-surfaces-each-admission-verdict-distinctly', async () => {
    const admitted = managerHarness(false);
    expect(await dispatchStart(admitted.manager, 'admitted')).toMatchObject({
      success: true, data: { verdict: 'admitted' },
    });
    await admitted.lifecycle.settled('admitted');

    const deferred = managerHarness(true);
    expect(await dispatchStart(deferred.manager, 'deferred')).toMatchObject({
      success: false, code: 'ADMISSION_FAILED', data: { verdict: 'deferred-with-owner' },
    });

    const refused = managerHarness(true);
    (refused.setHeld as unknown as (value: undefined) => void)(undefined);
    expect(await dispatchStart(refused.manager, 'refused')).toMatchObject({
      success: false, code: 'REFUSED', data: { verdict: 'refused', reason: 'UNKNOWN_GUARD' },
    });

    const inFlight = managerHarness(true);
    inFlight.agents.set('alpha', {
      process: { getStatus: () => ({ name: 'alpha', status: 'running', pid: 101 }) },
      checker: {},
    });
    await inFlight.manager.admitStartAgent('alpha', '/first');
    const socket = { write: vi.fn(), end: vi.fn() };
    const server = new IPCServer(inFlight.manager);
    await (server as unknown as {
      handleRequest(request: IPCRequest, socket: typeof socket): Promise<void>;
    }).handleRequest({ type: 'restart-agent', agent: 'alpha', source: 'test' }, socket);
    const response = JSON.parse(socket.write.mock.calls[0][0]) as IPCResponse;
    expect(response).toMatchObject({ success: false, code: 'IN_FLIGHT', data: { verdict: 'in-flight' } });
  });

  it('ipc-admission-verdict-arrives-within-its-own-budget', async () => {
    expect(IPC_ADMISSION_BUDGET_MS).toBeLessThanOrEqual(1_000);
    expect(IPC_ADMISSION_BUDGET_MS).toBeLessThan(5_000);
    const h = managerHarness(false);
    let finishSpawn!: () => void;
    vi.mocked(h.manager.startAgent).mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => { finishSpawn = resolve; });
    });
    const socket = { write: vi.fn(), end: vi.fn() };
    const server = new IPCServer(h.manager);
    const dispatch = (server as unknown as {
      handleRequest(request: IPCRequest, socket: typeof socket): Promise<void>;
    }).handleRequest({ type: 'start-agent', agent: 'alpha', source: 'test' }, socket);
    await new Promise(resolve => setTimeout(resolve, 25));
    expect(socket.write).toHaveBeenCalledOnce();
    finishSpawn();
    await dispatch;
  });

  it('ipc-admission-budget-is-enforced-when-the-production-admitter-never-settles', async () => {
    vi.useFakeTimers();
    try {
      const h = managerHarness(false);
      vi.spyOn(h.manager, 'inspectAgentOp').mockReturnValue({ ok: true });
      vi.spyOn(h.manager, 'admitRestartAgent').mockImplementation(() => new Promise(() => {}));
      const socket = { write: vi.fn(), end: vi.fn() };
      const server = new IPCServer(h.manager);
      void (server as unknown as {
        handleRequest(request: IPCRequest, socket: typeof socket): Promise<void>;
      }).handleRequest({ type: 'restart-agent', agent: 'alpha', source: 'test' }, socket);
      await vi.advanceTimersByTimeAsync(IPC_ADMISSION_BUDGET_MS + 1);
      expect(socket.write).toHaveBeenCalledOnce();
      expect(JSON.parse(socket.write.mock.calls[0][0])).toMatchObject({
        success: false,
        code: 'ADMISSION_TIMEOUT',
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('operator-disable-resolves-cancelled-by-stop-not-failed', async () => {
    const h = managerHarness(true);
    await h.manager.admitStartAgent('alpha', '/alpha');
    const ctxRoot = (h.manager as unknown as { ctxRoot: string }).ctxRoot;
    writeFileSync(join(ctxRoot, 'config', 'enabled-agents.json'), JSON.stringify({ alpha: { enabled: false } }));
    h.setHeld(false);
    h.callbacks[0]();
    await h.lifecycle.settled('alpha');
    expect(h.lifecycle.observe('alpha')).toMatchObject({
      state: 'completed-for-accounting',
      outcome: 'cancelled-by-stop',
    });
    expect(h.starts).toEqual([]);
  });

  it('shutdown-drains-every-affected-owner-before-completion', async () => {
    const h = managerHarness(true);
    await h.manager.admitStartAgent('alpha', '/alpha');
    await h.manager.admitStartAgent('beta', '/beta');
    const releases = new Map<string, () => void>();
    vi.spyOn(h.manager, 'completeDeferredSubscriber').mockImplementation(effect => (
      new Promise<void>(resolve => { releases.set(effect.agent, resolve); })
    ));
    let stopped = false;
    const stop = h.manager.stopAll().then(() => { stopped = true; });
    await vi.waitFor(() => expect([...releases.keys()].sort()).toEqual(['alpha', 'beta']));
    expect(stopped).toBe(false);
    releases.get('alpha')!();
    await Promise.resolve();
    expect(stopped).toBe(false);
    releases.get('beta')!();
    await stop;
    expect(h.lifecycle.observe('alpha')?.state).toBe('completed-for-accounting');
    expect(h.lifecycle.observe('beta')?.state).toBe('completed-for-accounting');
  });

  it('boot-reconstructs-every-durable-record-before-admission', async () => {
    const persisted = { ...record('orphaned', 'requested'), operation: 'start' as const };
    const h = managerHarness(true, persisted);
    await h.manager.discoverAndStart();
    expect(h.lifecycle.observe('orphaned')).toMatchObject({
      receiptId: persisted.receiptId,
      state: 'deferred-with-owner',
    });
    expect(h.callbacks).toHaveLength(1);
  });

  it('production-reconstruction-identifies-a-stranger-and-never-stops-it', async () => {
    const persisted = { ...record('alpha', 'restart-pending'), oldProcessIdentity: 'kernel:original' };
    const h = managerHarness(false, persisted);
    h.agents.set('alpha', {
      process: { getStatus: () => ({ name: 'alpha', status: 'running', pid: 42 }) },
      checker: {},
    });
    const stop = vi.spyOn(h.manager, 'executeDeferredStop');
    await h.manager.admitRestartAgent('alpha');
    expect(stop).not.toHaveBeenCalled();
    expect(h.lifecycle.observe('alpha')?.outcome).toBe('failed');
  });

  it('production-unreadable-identity-is-unknown-and-never-spawns', async () => {
    const persisted: DeferredRecord = {
      ...record('alpha', 'start-pending'),
      operation: 'start',
      phase: 'after-stop',
      intendedChildToken: 'alpha:intended',
    };
    const h = managerHarness(false, persisted, () => { throw new Error('identity unreadable'); });
    h.agents.set('alpha', {
      process: { getStatus: () => ({ name: 'alpha', status: 'running', pid: 101 }) },
      checker: {},
    });
    await h.manager.admitStartAgent('alpha', '/alpha');
    expect(h.starts).toEqual([]);
    expect(h.lifecycle.observe('alpha')).toMatchObject({
      receiptId: persisted.receiptId,
      state: 'start-pending',
    });
    expect(h.lifecycle.observe('alpha')?.outcome).toBeUndefined();
  });

  it('production-spawning-reconstruction-reaps-the-exact-receipt-bound-child-and-starts-one-managed-replacement', async () => {
    const persisted: DeferredRecord = {
      ...record('alpha', 'spawning'),
      operation: 'start',
      phase: 'spawning',
      intendedChildToken: 'alpha:intended',
      childBinding: { token: 'alpha:intended', pid: 101, kernelIdentity: 'kernel:101' },
    };
    const h = managerHarness(false, persisted);
    const reap = vi.spyOn(h.manager as never, 'reapReceiptBoundChild' as never);
    await h.manager.admitStartAgent('alpha', '/alpha');
    await h.lifecycle.settled('alpha');
    expect(reap).toHaveBeenCalledOnce();
    expect(h.starts).toEqual(['alpha']);
    expect(h.journal.entries('alpha').some(({ value }) =>
      value.recoveryDisposition === 'reap-before-replacement' && value.recoveryReapAccounted === false,
    )).toBe(true);
    expect(h.journal.entries('alpha').some(({ value }) => value.recoveryReapAccounted === true)).toBe(true);
    expect(h.lifecycle.observe('alpha')).toMatchObject({
      outcome: 'spawned',
    });
    expect(h.manager.getAgentStatus('alpha')).toMatchObject({ status: 'running', pid: 101 });
  });

  it('spawned-receipt-with-a-vanished-child-reopens-boot-admission-for-one-managed-replacement', async () => {
    const persisted: DeferredRecord = {
      ...record('alpha', 'spawning'),
      operation: 'start', phase: 'spawning', intendedChildToken: 'alpha:intended',
      childBinding: { token: 'alpha:intended', pid: 101, kernelIdentity: 'kernel:101' },
    };
    let observations = 0;
    const h = managerHarness(false, persisted, pid => {
      observations += 1;
      if (observations === 1) throw new Error('child process identity vanished');
      return `kernel:${pid}`;
    });
    await h.manager.admitStartAgent('alpha', '/alpha');
    await h.lifecycle.settled('alpha');
    expect(h.starts).toEqual(['alpha']);
    expect(h.journal.entries('alpha').some(({ value }) => value.recoveryReapAccounted === true)).toBe(true);
    expect(h.manager.getAgentStatus('alpha')).toMatchObject({ status: 'running', pid: 101 });
  });

  it('completed-receipt-with-a-surviving-child-reaps-before-starting-a-new-generation', async () => {
    const persisted: DeferredRecord = {
      ...record('alpha', 'completed-for-accounting'),
      operation: 'start', phase: 'spawning', intendedChildToken: 'alpha:intended',
      childBinding: { token: 'alpha:intended', pid: 101, kernelIdentity: 'kernel:101' },
      outcome: 'spawned',
    };
    const h = managerHarness(false, persisted);
    const reap = vi.spyOn(h.manager as never, 'reapReceiptBoundChild' as never);
    await h.manager.admitStartAgent('alpha', '/alpha');
    await h.lifecycle.settled('alpha');
    expect(reap).toHaveBeenCalledOnce();
    expect(h.starts).toEqual(['alpha']);
    expect(h.journal.entries('alpha').some(({ value }) => value.recoveryReapAccounted === true)).toBe(true);
    expect(h.lifecycle.observe('alpha')?.recordGeneration).toBeGreaterThan(1);
  });

  it('recovered-child-conflict-refuses-and-preserves-the-unaccounted-durable-decision', async () => {
    const persisted: DeferredRecord = {
      ...record('alpha', 'completed-for-accounting'),
      operation: 'start', phase: 'spawning', intendedChildToken: 'alpha:intended',
      childBinding: { token: 'alpha:intended', pid: 101, kernelIdentity: 'kernel:original' },
      outcome: 'spawned',
    };
    const h = managerHarness(false, persisted, () => 'kernel:stranger');
    const result = await h.manager.admitStartAgent('alpha', '/alpha');
    expect(result).toEqual({ status: 'refused', reason: 'UNKNOWN_GUARD' });
    expect(h.starts).toEqual([]);
    expect(h.lifecycle.observe('alpha')).toMatchObject({
      receiptId: persisted.receiptId,
      recoveryDisposition: 'reap-before-replacement',
      recoveryReapAccounted: false,
    });
  });

  it('recovered-child-unknown-refuses-and-preserves-the-unaccounted-durable-decision', async () => {
    const persisted: DeferredRecord = {
      ...record('alpha', 'completed-for-accounting'),
      operation: 'start', phase: 'spawning', intendedChildToken: 'alpha:intended',
      childBinding: { token: 'alpha:intended', pid: 101, kernelIdentity: 'kernel:101' },
      outcome: 'spawned',
    };
    const h = managerHarness(false, persisted, () => { throw new Error('identity unreadable'); });
    const result = await h.manager.admitStartAgent('alpha', '/alpha');
    expect(result).toEqual({ status: 'refused', reason: 'UNKNOWN_GUARD' });
    expect(h.starts).toEqual([]);
    expect(h.lifecycle.observe('alpha')).toMatchObject({
      receiptId: persisted.receiptId,
      recoveryDisposition: 'reap-before-replacement',
      recoveryReapAccounted: false,
    });
  });

  it('start-pending-exact-child-is-reaped-before-one-managed-replacement-spawns', async () => {
    const persisted: DeferredRecord = {
      ...record('alpha', 'start-pending'),
      operation: 'start',
      phase: 'after-stop',
      intendedChildToken: 'alpha:intended',
      childBinding: { token: 'alpha:intended', pid: 101, kernelIdentity: 'kernel:101' },
    };
    const h = managerHarness(false, persisted);
    await h.manager.admitStartAgent('alpha', '/alpha');
    await h.lifecycle.settled('alpha');
    expect(h.starts).toEqual(['alpha']);
    expect(h.lifecycle.observe('alpha')?.outcome).toBe('spawned');
  });

  it('child-binding-is-durable-before-the-child-can-report-online', async () => {
    const h = managerHarness(false);
    vi.mocked(h.manager.startAgent).mockImplementationOnce(async (name, _dir, _config, _org, options) => {
      await options.deferredBeforeOnline?.(101);
      const visible = h.journal.latest(name)?.value;
      expect(visible?.childBinding).toMatchObject({ token: visible?.intendedChildToken });
      h.agents.set(name, {
        process: { getStatus: () => ({ name, status: 'running', pid: 101 }) },
        checker: {},
      });
    });
    await h.manager.admitStartAgent('alpha', '/alpha');
    await h.lifecycle.settled('alpha');
    expect(h.lifecycle.observe('alpha')?.outcome).toBe('spawned');
  });

  it('row-guard-input-cannot-default', async () => {
    const h = managerHarness(true);
    (h.setHeld as unknown as (value: undefined) => void)(undefined);
    const result = await h.manager.admitStartAgent('alpha', '/alpha');
    expect(h.starts).toEqual([]);
    expect(result).toMatchObject({ status: 'refused', reason: 'UNKNOWN_GUARD' });
  });

  it('all-row-transitions-use-one-durable-executor', () => {
    const persisted: DeferredRecord = {
      ...record('alpha', 'start-pending'),
      operation: 'start',
      phase: 'after-stop',
      intendedChildToken: 'alpha:intended',
    };
    const h = managerHarness(false, persisted);
    const before = h.journal.entries('alpha');
    (h.manager as unknown as { reconstructedDeferredAgents: Set<string> })
      .reconstructedDeferredAgents.delete('alpha');
    (h.manager as unknown as { reconstructDeferredAgent(name: string): void })
      .reconstructDeferredAgent('alpha');
    const after = h.journal.entries('alpha');
    expect(after).toHaveLength(before.length);
    expect(after.at(-1)?.value.receiptId).toBe(persisted.receiptId);
  });
});
