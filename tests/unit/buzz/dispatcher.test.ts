import { describe, it, expect, beforeEach } from 'vitest';
import { BuzzDispatcher } from '../../../src/buzz/dispatcher';
import type { BuzzChannelConfig } from '../../../src/buzz/identity';
import type { NostrEvent } from '../../../src/buzz/event';

function makeConfig(overrides: Partial<BuzzChannelConfig> = {}): BuzzChannelConfig {
  return {
    pubkey: 'agent-pubkey',
    display_name: 'test-agent',
    channels: ['chan-1'],
    allowed_pubkeys: ['sender-1'],
    ...overrides,
  };
}

function makeEvent(overrides: Partial<NostrEvent> = {}): NostrEvent {
  return {
    id: 'event-1',
    pubkey: 'sender-1',
    created_at: Math.floor(Date.now() / 1000),
    kind: 9,
    tags: [['h', 'chan-1']],
    content: 'hello',
    sig: 'sig',
    ...overrides,
  };
}

describe('BuzzDispatcher', () => {
  let dispatcher: BuzzDispatcher;

  beforeEach(() => {
    dispatcher = new BuzzDispatcher();
  });

  it('dispatches to a registered agent when both channel and pubkey match', () => {
    dispatcher.register('agent-a', makeConfig());
    const results = dispatcher.dispatch('chan-1', makeEvent());
    expect(results).toEqual([{ agentName: 'agent-a', event: makeEvent(), channelId: 'chan-1' }]);
  });

  it('does not dispatch when the channel does not match', () => {
    dispatcher.register('agent-a', makeConfig({ channels: ['other-chan'] }));
    const results = dispatcher.dispatch('chan-1', makeEvent());
    expect(results).toEqual([]);
  });

  it('does not dispatch when the sender pubkey is not allowlisted (channel match alone is insufficient)', () => {
    dispatcher.register('agent-a', makeConfig({ allowed_pubkeys: ['someone-else'] }));
    const results = dispatcher.dispatch('chan-1', makeEvent());
    expect(results).toEqual([]);
  });

  it('fail-closed: does not dispatch when allowed_pubkeys is empty, even with correct channel', () => {
    dispatcher.register('agent-a', makeConfig({ allowed_pubkeys: [] }));
    const results = dispatcher.dispatch('chan-1', makeEvent());
    expect(results).toEqual([]);
  });

  it('dispatches to multiple agents in the same channel (N:1, unlike Telegram 1:1)', () => {
    dispatcher.register('agent-a', makeConfig({ allowed_pubkeys: ['sender-1'] }));
    dispatcher.register('agent-b', makeConfig({ allowed_pubkeys: ['sender-1'] }));
    const results = dispatcher.dispatch('chan-1', makeEvent());
    expect(results.map((r) => r.agentName).sort()).toEqual(['agent-a', 'agent-b']);
  });

  it('delivers independent message ids and deduplicates per event and agent', async () => {
    dispatcher.register('agent-a', makeConfig());
    dispatcher.register('agent-b', makeConfig());
    const writes: string[] = [];
    const first = await dispatcher.deliver('chan-1', makeEvent(), ({ agentName }) => {
      writes.push(agentName);
      return `msg-${agentName}`;
    });
    expect(first.map(({ agentName, status, messageId }) => ({ agentName, status, messageId }))).toEqual([
      { agentName: 'agent-a', status: 'delivered', messageId: 'msg-agent-a' },
      { agentName: 'agent-b', status: 'delivered', messageId: 'msg-agent-b' },
    ]);
    const second = await dispatcher.deliver('chan-1', makeEvent(), () => 'must-not-write');
    expect(second.map((result) => result.status)).toEqual(['deduped', 'deduped']);
    expect(writes).toEqual(['agent-a', 'agent-b']);
  });

  it('keeps sibling delivery successful and retries only the failed agent', async () => {
    dispatcher.register('agent-a', makeConfig());
    dispatcher.register('agent-b', makeConfig());
    const logs: string[] = [];
    const first = await dispatcher.deliver('chan-1', makeEvent(), ({ agentName }) => {
      if (agentName === 'agent-a') throw new Error('disk full');
      return 'msg-b';
    }, (message) => logs.push(message));
    expect(first.map(({ agentName, status }) => ({ agentName, status }))).toEqual([
      { agentName: 'agent-a', status: 'deliveryFailed' },
      { agentName: 'agent-b', status: 'delivered' },
    ]);
    expect(logs[0]).toContain('event=event-1 agent=agent-a');

    const retried: string[] = [];
    const second = await dispatcher.deliver('chan-1', makeEvent(), ({ agentName }) => {
      retried.push(agentName);
      return 'msg-a';
    });
    expect(second.map(({ agentName, status }) => ({ agentName, status }))).toEqual([
      { agentName: 'agent-a', status: 'delivered' },
      { agentName: 'agent-b', status: 'deduped' },
    ]);
    expect(retried).toEqual(['agent-a']);
  });

  // Post-merge P1 (Codex 3878389303): the dedup key was marked only after the
  // awaited write, so a relay redelivery arriving mid-write passed the check
  // twice (TOCTOU double delivery). Dedup is now AWAIT-THE-WINNER: a duplicate
  // awaits the in-flight write and dedups only against a SUCCESSFUL winner.
  it('MUST-DIE (double-delivery): concurrent redelivery whose winner SUCCEEDS collapses to ONE durable write', async () => {
    dispatcher.register('agent-a', makeConfig());
    let release!: (id: string) => void;
    const writes: string[] = [];
    // First copy: its write stalls until we release it.
    const first = dispatcher.deliver('chan-1', makeEvent(), ({ agentName }) => {
      writes.push(agentName);
      return new Promise<string>((resolve) => { release = (id) => resolve(id); });
    });
    // Second copy arrives while the first write is still in flight. Do NOT
    // await it yet — under await-the-winner it BLOCKS on the first write.
    const second = dispatcher.deliver('chan-1', makeEvent(), ({ agentName }) => {
      writes.push(agentName);
      return 'msg-dup';
    });
    await Promise.resolve(); // let the second reach its await on the in-flight write
    release('msg-1');        // first write succeeds
    const [r1, r2] = await Promise.all([first, second]);
    expect(r1.map((r) => r.status)).toEqual(['delivered']);
    expect(r2.map((r) => r.status)).toEqual(['deduped']);
    expect(writes).toEqual(['agent-a']); // the duplicate never wrote
  });

  // Post-merge P1 v2 (Codex on 1af148e8): the reserve-and-discard fix closed
  // double-delivery but opened LOST-delivery — a duplicate discarded on sight
  // while the winner's write was in flight was gone if that write then FAILED,
  // so nothing retried. Await-the-winner must instead RETRY the duplicate when
  // the winner fails: the message is delivered, not lost.
  it('MUST-DIE (lost-delivery): when the winner write FAILS, a concurrent redelivery still delivers', async () => {
    dispatcher.register('agent-a', makeConfig());
    let failFirst!: (err: Error) => void;
    const writes: string[] = [];
    // First copy: its write will FAIL (stalled until we reject it).
    const first = dispatcher.deliver('chan-1', makeEvent(), ({ agentName }) => {
      writes.push(`fail:${agentName}`);
      return new Promise<string>((_resolve, reject) => { failFirst = (e) => reject(e); });
    });
    // Redelivery arrives while the first (doomed) write is in flight.
    const second = dispatcher.deliver('chan-1', makeEvent(), ({ agentName }) => {
      writes.push(`ok:${agentName}`);
      return 'msg-retry';
    });
    await Promise.resolve(); // second blocks on the in-flight write
    failFirst(new Error('disk full')); // the winner FAILS
    const [r1, r2] = await Promise.all([first, second]);
    expect(r1.map((r) => r.status)).toEqual(['deliveryFailed']);
    // The redelivery is NOT lost: it retried its own write and delivered.
    expect(r2.map((r) => r.status)).toEqual(['delivered']);
    expect(writes).toEqual(['fail:agent-a', 'ok:agent-a']);
  });

  it('sequential redelivery after a SUCCESSFUL write dedups (durable window)', async () => {
    dispatcher.register('agent-a', makeConfig());
    const first = await dispatcher.deliver('chan-1', makeEvent(), () => 'msg-1');
    expect(first.map((r) => r.status)).toEqual(['delivered']);
    const second = await dispatcher.deliver('chan-1', makeEvent(), () => 'must-not-write');
    expect(second.map((r) => r.status)).toEqual(['deduped']);
  });

  it('sequential redelivery after a FAILED write retries (no durable mark on failure)', async () => {
    dispatcher.register('agent-a', makeConfig());
    const first = await dispatcher.deliver('chan-1', makeEvent(), () => { throw new Error('disk full'); });
    expect(first.map((r) => r.status)).toEqual(['deliveryFailed']);
    const second = await dispatcher.deliver('chan-1', makeEvent(), () => 'msg-retry');
    expect(second.map((r) => r.status)).toEqual(['delivered']);
  });

  it('only dispatches to agents whose allowlist matches this specific sender, not just any member', () => {
    dispatcher.register('agent-a', makeConfig({ allowed_pubkeys: ['sender-1'] }));
    dispatcher.register('agent-b', makeConfig({ allowed_pubkeys: ['someone-else'] }));
    const results = dispatcher.dispatch('chan-1', makeEvent());
    expect(results.map((r) => r.agentName)).toEqual(['agent-a']);
  });

  it('unregister removes an agent from future dispatch', () => {
    dispatcher.register('agent-a', makeConfig());
    dispatcher.unregister('agent-a');
    const results = dispatcher.dispatch('chan-1', makeEvent());
    expect(results).toEqual([]);
  });

  it('unregister is a harmless no-op for an agent that was never registered', () => {
    expect(() => dispatcher.unregister('never-registered')).not.toThrow();
  });

  it('re-registering an agent overwrites its previous config (e.g. after buzz.json changes)', () => {
    dispatcher.register('agent-a', makeConfig({ allowed_pubkeys: ['old-sender'] }));
    dispatcher.register('agent-a', makeConfig({ allowed_pubkeys: ['sender-1'] }));
    const results = dispatcher.dispatch('chan-1', makeEvent());
    expect(results.map((r) => r.agentName)).toEqual(['agent-a']);
  });

  describe('allChannels', () => {
    it('returns the union of channels across all registered agents', () => {
      dispatcher.register('agent-a', makeConfig({ channels: ['c1', 'c2'] }));
      dispatcher.register('agent-b', makeConfig({ channels: ['c2', 'c3'] }));
      expect(dispatcher.allChannels().sort()).toEqual(['c1', 'c2', 'c3']);
    });

    it('returns an empty array when no agents are registered', () => {
      expect(dispatcher.allChannels()).toEqual([]);
    });
  });
});
