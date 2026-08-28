import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { BuzzRelayClient } from '../../../src/buzz/relay-client';
import { buildChannelMessageEvent, buildEvent } from '../../../src/buzz/event';

/**
 * Minimal fake WebSocket implementing just enough of the browser/Node
 * WebSocket surface (addEventListener/send/close) that relay-client.ts
 * uses, with manual test-driven triggering of open/message/close events —
 * no real network involved.
 */
class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  url: string;
  sent: unknown[] = [];
  closed = false;
  private listeners: Record<string, Array<(evt: any) => void>> = {};

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  addEventListener(type: string, handler: (evt: any) => void): void {
    (this.listeners[type] ||= []).push(handler);
  }

  send(data: string): void {
    this.sent.push(JSON.parse(data));
  }

  close(): void {
    this.closed = true;
    this.emit('close', {});
  }

  emit(type: string, evt: any): void {
    for (const handler of this.listeners[type] || []) handler(evt);
  }

  triggerOpen(): void {
    this.emit('open', {});
  }

  triggerMessage(frame: unknown): void {
    this.emit('message', { data: JSON.stringify(frame) });
  }

  lastSent(): unknown {
    return this.sent[this.sent.length - 1];
  }
}

describe('BuzzRelayClient', () => {
  let originalWebSocket: unknown;
  const secretKey = '0000000000000000000000000000000000000000000000000000000000000003';
  const pubkey = 'f9308a019258c31049344f85f89d5229b531c845836f99b08601f113bce036f9';

  beforeEach(() => {
    FakeWebSocket.instances = [];
    originalWebSocket = (globalThis as any).WebSocket;
    (globalThis as any).WebSocket = FakeWebSocket;
  });

  afterEach(() => {
    (globalThis as any).WebSocket = originalWebSocket;
    vi.useRealTimers();
  });

  /** Drives a client through connect -> AUTH challenge -> AUTH OK, returning the socket. */
  async function connectAndAuthenticate(client: BuzzRelayClient): Promise<FakeWebSocket> {
    const startPromise = client.start();
    // Let the microtask queue advance so connectAndRun() constructs the WebSocket.
    await Promise.resolve();
    await Promise.resolve();
    const ws = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
    ws.triggerOpen();
    await Promise.resolve();
    ws.triggerMessage(['AUTH', 'challenge-123']);
    await Promise.resolve();
    const authFrame = ws.lastSent() as [string, { id: string }];
    expect(authFrame[0]).toBe('AUTH');
    ws.triggerMessage(['OK', authFrame[1].id, true, '']);
    await Promise.resolve();
    void startPromise; // client.start() runs until stop(); don't await it here.
    return ws;
  }

  it('sends a signed AUTH event in response to the relay challenge', async () => {
    const client = new BuzzRelayClient('wss://relay.test', secretKey);
    const ws = await connectAndAuthenticate(client);
    const authFrame = ws.sent.find((f: any) => f[0] === 'AUTH') as [string, { kind: number; pubkey: string; tags: string[][] }];
    expect(authFrame[1].kind).toBe(22242);
    expect(authFrame[1].pubkey).toBe(pubkey);
    expect(authFrame[1].tags).toContainEqual(['challenge', 'challenge-123']);
    client.stop();
  });

  it('issues a REQ subscription for each subscribed channel after authentication', async () => {
    const client = new BuzzRelayClient('wss://relay.test', secretKey);
    client.subscribeChannels(['chan-1', 'chan-2']);
    const ws = await connectAndAuthenticate(client);
    const reqFrames = ws.sent.filter((f: any) => f[0] === 'REQ');
    expect(reqFrames).toHaveLength(2);
    const channelsRequested = reqFrames.map((f: any) => f[2]['#h'][0]).sort();
    expect(channelsRequested).toEqual(['chan-1', 'chan-2']);
    client.stop();
  });

  it('does not reopen existing subscriptions when a newly registered agent adds an overlapping channel', async () => {
    const client = new BuzzRelayClient('wss://relay.test', secretKey);
    client.subscribeChannels(['chan-1']);
    const ws = await connectAndAuthenticate(client);
    expect(ws.sent.filter((frame: any) => frame[0] === 'REQ')).toHaveLength(1);
    client.subscribeChannels(['chan-1', 'chan-2']);
    const reqFrames = ws.sent.filter((frame: any) => frame[0] === 'REQ');
    expect(reqFrames).toHaveLength(2);
    expect(reqFrames[1][2]['#h']).toEqual(['chan-2']);
    client.stop();
  });

  it('delivers a kind:9 EVENT to onMessage handlers only after EOSE for that subscription', async () => {
    const client = new BuzzRelayClient('wss://relay.test', secretKey);
    client.subscribeChannels(['chan-1']);
    const ws = await connectAndAuthenticate(client);
    const reqFrame = ws.sent.find((f: any) => f[0] === 'REQ') as [string, string, unknown];
    const subId = reqFrame[1];

    const received: unknown[] = [];
    client.onMessage((channelId, event) => received.push({ channelId, event }));

    const preEoseEvent = buildChannelMessageEvent('chan-1', 'backlog', secretKey);
    ws.triggerMessage(['EVENT', subId, preEoseEvent]);
    expect(received).toHaveLength(0); // historical backlog before EOSE must not be delivered

    ws.triggerMessage(['EOSE', subId]);
    const liveEvent = buildChannelMessageEvent('chan-1', 'live', secretKey);
    ws.triggerMessage(['EVENT', subId, liveEvent]);
    await Promise.resolve();
    await Promise.resolve();
    expect(received).toEqual([{ channelId: 'chan-1', event: liveEvent }]);
    client.stop();
  });

  it('drops invalid signatures and mismatched channel tags after EOSE', async () => {
    const logs: string[] = [];
    const client = new BuzzRelayClient('wss://relay.test', secretKey, (message) => logs.push(message));
    client.subscribeChannels(['chan-1']);
    const ws = await connectAndAuthenticate(client);
    const reqFrame = ws.sent.find((f: any) => f[0] === 'REQ') as [string, string, unknown];
    ws.triggerMessage(['EOSE', reqFrame[1]]);
    const received: unknown[] = [];
    client.onMessage((_channel, event) => received.push(event));

    const invalid = { ...buildChannelMessageEvent('chan-1', 'bad', secretKey), content: 'tampered' };
    ws.triggerMessage(['EVENT', reqFrame[1], invalid]);
    ws.triggerMessage(['EVENT', reqFrame[1], buildChannelMessageEvent('chan-2', 'wrong channel', secretKey)]);
    await Promise.resolve();
    expect(received).toEqual([]);
    expect(logs.some((line) => line.includes('dropping'))).toBe(true);
    client.stop();
  });

  it('rejects non-wss relay URLs before opening a socket', () => {
    expect(() => new BuzzRelayClient('ws://relay.test', secretKey)).toThrow(/wss/);
  });

  it('publish() sends a signed kind:9 event with the channel #h tag and resolves on OK', async () => {
    const client = new BuzzRelayClient('wss://relay.test', secretKey);
    const ws = await connectAndAuthenticate(client);

    const publishPromise = client.publish('chan-1', 'hello world');
    await Promise.resolve();
    const eventFrame = ws.sent.find((f: any) => f[0] === 'EVENT') as [string, { id: string; tags: string[][] }];
    expect(eventFrame[1].tags).toContainEqual(['h', 'chan-1']);
    ws.triggerMessage(['OK', eventFrame[1].id, true, '']);

    const result = await publishPromise;
    expect(result.content).toBe('hello world');
    client.stop();
  });

  it('publish() rejects when the relay responds with OK=false', async () => {
    const client = new BuzzRelayClient('wss://relay.test', secretKey);
    const ws = await connectAndAuthenticate(client);

    const publishPromise = client.publish('chan-1', 'hello world');
    await Promise.resolve();
    const eventFrame = ws.sent.find((f: any) => f[0] === 'EVENT') as [string, { id: string }];
    ws.triggerMessage(['OK', eventFrame[1].id, false, 'rate limited']);

    await expect(publishPromise).rejects.toThrow(/rate limited/);
    client.stop();
  });

  it('publish() throws immediately if not yet authenticated', async () => {
    const client = new BuzzRelayClient('wss://relay.test', secretKey);
    await expect(client.publish('chan-1', 'too early')).rejects.toThrow(/not connected/);
  });

  it('stop() marks lastExitReason as stopped-externally and prevents further sends', async () => {
    const client = new BuzzRelayClient('wss://relay.test', secretKey);
    await connectAndAuthenticate(client);
    client.stop();
    // Give start()'s loop a tick to observe running=false and return.
    await Promise.resolve();
    await Promise.resolve();
    expect(client.lastExitReason).toBe('stopped-externally');
  });

  it('a stale (superseded) connection frame does not deliver to handlers after reconnect (epoch guard)', async () => {
    const client = new BuzzRelayClient('wss://relay.test', secretKey);
    client.subscribeChannels(['chan-1']);
    const firstWs = await connectAndAuthenticate(client);

    const received: unknown[] = [];
    client.onMessage((channelId, event) => received.push({ channelId, event }));

    // Simulate the old socket closing and a new connection superseding it
    // by calling stop() (bumps epoch) then manually feeding the old socket
    // a frame — it must be ignored since it's no longer the current epoch.
    client.stop();
    const staleEvent = { id: 'stale', pubkey: 'x', created_at: 1, kind: 9, tags: [], content: 'stale', sig: 'z' };
    firstWs.triggerMessage(['EOSE', 'buzz-chan-1']);
    firstWs.triggerMessage(['EVENT', 'buzz-chan-1', staleEvent]);
    expect(received).toHaveLength(0);
  });
});

// Post-merge P1 (Codex 3878389291): verifyEvent proves the signature covers
// the payload, not that the payload is well-shaped — malformed tags on an
// otherwise-plausible kind-9 event must be DROPPED, never dereferenced.
describe('BuzzRelayClient malformed-tags hardening', () => {
  const secretKey = '0000000000000000000000000000000000000000000000000000000000000003';

  beforeEach(() => {
    FakeWebSocket.instances = [];
    (globalThis as any).WebSocket = FakeWebSocket;
  });

  async function eoseReadyClient(logs: string[]): Promise<{ client: BuzzRelayClient; ws: FakeWebSocket; subId: string }> {
    const client = new BuzzRelayClient('wss://relay.test', secretKey, (m) => logs.push(m));
    client.subscribeChannels(['chan-1']);
    const startPromise = client.start();
    await Promise.resolve();
    await Promise.resolve();
    const ws = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
    ws.triggerOpen();
    await Promise.resolve();
    ws.triggerMessage(['AUTH', 'challenge-x']);
    await Promise.resolve();
    const authFrame = ws.lastSent() as [string, { id: string }];
    ws.triggerMessage(['OK', authFrame[1].id, true, '']);
    await Promise.resolve();
    void startPromise;
    const reqFrame = ws.sent.find((f: any) => f[0] === 'EVENT' ? false : f[0] === 'REQ') as [string, string, unknown];
    ws.triggerMessage(['EOSE', reqFrame[1]]);
    return { client, ws, subId: reqFrame[1] };
  }

  it('drops (never throws on) VALIDLY-SIGNED events whose tags are null, an object, or contain non-arrays', async () => {
    const logs: string[] = [];
    const { client, ws, subId } = await eoseReadyClient(logs);
    const received: unknown[] = [];
    client.onMessage((_c, e) => received.push(e));

    // These are SIGNED over the malformed tags (computeEventId serializes tags
    // with JSON.stringify, so null/{}/[null] all hash and sign cleanly) — so
    // verifyEvent PASSES and the shape gate is the ONLY thing standing between
    // the attacker's payload and the `.tags.find(...)` dereference. If the
    // shape gate is removed, each of these THROWS synchronously out of
    // triggerMessage (null.find / {}.find / null[0]) and fails the expect.
    const malformed: unknown[] = [null, {}, [null]];
    for (const tags of malformed) {
      const evt = buildEvent(9, 'hi', tags as never, secretKey);
      expect(() => ws.triggerMessage(['EVENT', subId, evt])).not.toThrow();
    }
    await Promise.resolve();
    expect(received).toEqual([]);
    expect(logs.filter((l) => l.includes('dropping unverifiable')).length).toBe(malformed.length);
    client.stop();
  });

  it('CONTROL: those same malformed-tags events genuinely PASS verifyEvent (so the shape gate, not the signature check, is what drops them)', async () => {
    const { verifyEvent } = await import('../../../src/buzz/event');
    for (const tags of [null, {}, [null]] as unknown[]) {
      const evt = buildEvent(9, 'hi', tags as never, secretKey);
      expect(verifyEvent(evt)).toBe(true);
    }
  });

  it('POLARITY: a well-shaped valid event still delivers after the hardening', async () => {
    const logs: string[] = [];
    const { client, ws, subId } = await eoseReadyClient(logs);
    const received: unknown[] = [];
    client.onMessage((_c, e) => received.push(e));
    const good = buildChannelMessageEvent('chan-1', 'still works', secretKey);
    ws.triggerMessage(['EVENT', subId, good]);
    await Promise.resolve();
    await Promise.resolve();
    expect(received).toEqual([good]);
    client.stop();
  });
});

// Post-merge P2 (Codex 3878389310): a connect-timeout rejection must CLOSE
// the failed socket before the loop opens another — otherwise dead sockets
// accumulate across reconnect attempts.
describe('BuzzRelayClient failed-socket cleanup', () => {
  const secretKey = '0000000000000000000000000000000000000000000000000000000000000003';

  beforeEach(() => {
    FakeWebSocket.instances = [];
    (globalThis as any).WebSocket = FakeWebSocket;
  });

  it('closes the socket when the connect times out, before reconnecting', async () => {
    vi.useFakeTimers();
    const client = new BuzzRelayClient('wss://relay.test', secretKey);
    const startPromise = client.start();
    await Promise.resolve();
    await Promise.resolve();
    const ws = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
    expect(ws.closed).toBe(false);
    // Never triggerOpen — let the 20s connect timeout fire.
    await vi.advanceTimersByTimeAsync(20_000);
    expect(ws.closed).toBe(true);
    client.stop();
    await vi.runAllTimersAsync();
    await startPromise;
    vi.useRealTimers();
  });
});
