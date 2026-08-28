import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { AgentManager } from '../../../src/daemon/agent-manager';
import { BuzzDispatcher } from '../../../src/buzz/dispatcher';
import type { BuzzChannelConfig } from '../../../src/buzz/identity';

/**
 * Post-merge P1 (Codex 3878389296): a Buzz agent must be unregistered from the
 * dispatcher on EVERY path its entry leaves the registry — stopAgent AND the
 * startAgent stale-entry eviction. The original fix only covered stopAgent, so
 * an evicted-then-restarted agent kept a stale registration and the relay kept
 * routing its events. These casualties drive BOTH paths through the real
 * manager and assert the dispatcher stops routing to the torn-down agent.
 */

const CONFIG: BuzzChannelConfig = {
  pubkey: 'agent-pubkey',
  display_name: 'buzzy',
  channels: ['chan-1'],
  allowed_pubkeys: ['sender-1'],
};

function eventForChan1() {
  return {
    id: 'e1', pubkey: 'sender-1', created_at: 1, kind: 9,
    tags: [['h', 'chan-1']], content: 'hi', sig: 'sig',
  };
}

describe('AgentManager Buzz teardown on both registry-exit paths', () => {
  let root = '';
  afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }); });

  /** Wire a manager with a registered Buzz agent whose entry has buzzOrg set. */
  function wire(alive: boolean) {
    root = mkdtempSync(join(tmpdir(), 'buzz-teardown-'));
    const manager = new AgentManager('test', root, root, 'acme') as any;
    const dispatcher = new BuzzDispatcher();
    dispatcher.register('buzzy', CONFIG);
    manager.buzzClients.set('acme', {
      client: { subscribeChannels() {}, async start() {}, stop() {} },
      dispatcher, relayUrl: 'wss://relay.example.com', authPubkey: 'x', started: true,
    });
    const entry = {
      process: {
        getStatus: () => ({ status: alive ? 'running' : 'exited' }),
        stop: vi.fn(async () => {}),
      },
      checker: { stop: vi.fn() },
      buzzOrg: 'acme',
    };
    manager.agents.set('buzzy', entry);
    // Precondition: the dispatcher routes to buzzy right now.
    expect(dispatcher.dispatch('chan-1', eventForChan1() as any).map((t: any) => t.agentName))
      .toEqual(['buzzy']);
    return { manager, dispatcher };
  }

  it('stopAgent unregisters the agent from the dispatcher', async () => {
    const { manager, dispatcher } = wire(true);
    await manager.stopAgent('buzzy');
    expect(dispatcher.dispatch('chan-1', eventForChan1() as any)).toEqual([]);
  });

  it('stale-entry eviction (real startAgent path) unregisters the agent from the dispatcher', async () => {
    const { manager, dispatcher } = wire(false);
    // Drive the REAL startAgent: a mapped-but-not-alive entry triggers the
    // eviction block, then startAgent bails at "agent directory not found"
    // (bogus dir, and the discovered path under the temp root does not exist)
    // — so no process is spawned, but the eviction teardown has already run.
    // This guards the WIRING (the eviction block calling the helper), which a
    // direct helper call would not: removing that call must fail this test.
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    await manager.startAgent('buzzy', join(root, 'does-not-exist'), undefined, 'acme');
    expect(manager.agents.has('buzzy')).toBe(false); // evicted
    expect(dispatcher.dispatch('chan-1', eventForChan1() as any)).toEqual([]);
    vi.restoreAllMocks();
  });
});
