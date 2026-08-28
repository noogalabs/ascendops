import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  validateSlackEnvelope,
  isTimestampValid,
  shouldDeliverSlackMessage,
  SlackSocketClient,
  SLACK_PERMANENT_AUTH_ERRORS,
} from '../../../src/slack/slack-socket.js';
import { redactTokens } from '../../../src/slack/slack-redact.js';

describe('validateSlackEnvelope', () => {
  // Regression guard for the lifted-code bug: Slack's `hello` control frame
  // carries NO envelope_id, so requiring envelope_id for every type rejected
  // it and the connection never authenticated.
  it('accepts a hello frame that has no envelope_id', () => {
    const hello = {
      type: 'hello',
      num_connections: 1,
      connection_info: { app_id: 'A123' },
      debug_info: { host: 'applink-1' },
    };
    expect(validateSlackEnvelope(hello)).toEqual({ valid: true });
  });

  it('accepts a disconnect frame that has no envelope_id', () => {
    const disconnect = { type: 'disconnect', reason: 'warning', debug_info: {} };
    expect(validateSlackEnvelope(disconnect)).toEqual({ valid: true });
  });

  it('still requires envelope_id for events_api frames (must be acked)', () => {
    const eventNoId = {
      type: 'events_api',
      payload: { event: { type: 'message', channel: 'C1', user: 'U1', text: 'hi', ts: '1.1' } },
    };
    const result = validateSlackEnvelope(eventNoId);
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/envelope_id/i);
  });

  it('accepts a well-formed events_api frame with envelope_id and payload', () => {
    const good = {
      envelope_id: 'env-1',
      type: 'events_api',
      payload: { event: { type: 'message', channel: 'C1', user: 'U1', text: 'hi', ts: '1.1' } },
    };
    expect(validateSlackEnvelope(good)).toEqual({ valid: true });
  });

  it('rejects events_api frame missing its payload', () => {
    const noPayload = { envelope_id: 'env-1', type: 'events_api' };
    const result = validateSlackEnvelope(noPayload);
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/payload/i);
  });

  it('rejects an unknown envelope type', () => {
    const result = validateSlackEnvelope({ envelope_id: 'x', type: 'bogus' });
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/unknown envelope type/i);
  });

  it('rejects a frame with no type', () => {
    const result = validateSlackEnvelope({ envelope_id: 'x' });
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/type/i);
  });

  it('rejects a non-object', () => {
    expect(validateSlackEnvelope(null).valid).toBe(false);
    expect(validateSlackEnvelope('str' as unknown).valid).toBe(false);
  });
});

describe('isTimestampValid (sanity — replay window)', () => {
  it('accepts a current timestamp', () => {
    const now = Math.floor(Date.now() / 1000).toString();
    expect(isTimestampValid(now)).toBe(true);
  });

  it('rejects a stale timestamp beyond the 5-minute window', () => {
    const stale = (Math.floor(Date.now() / 1000) - 600).toString();
    expect(isTimestampValid(stale)).toBe(false);
  });

  it('rejects a non-numeric timestamp', () => {
    expect(isTimestampValid('not-a-number')).toBe(false);
  });
});

describe('shouldDeliverSlackMessage (parity with the legacy poll)', () => {
  it('delivers a plain text message (no subtype)', () => {
    expect(shouldDeliverSlackMessage({ type: 'message', text: 'hello team' })).toBe(true);
  });

  // THE regression guard: the poll delivered file shares (non-bot subtype with
  // text); the socket must too, or human file/photo shares are silently dropped.
  it('delivers a file_share message that has text (not dropped)', () => {
    expect(
      shouldDeliverSlackMessage({ type: 'message', subtype: 'file_share', text: 'here is the leak photo' }),
    ).toBe(true);
  });

  it('delivers a thread_broadcast message that has text', () => {
    expect(
      shouldDeliverSlackMessage({ type: 'message', subtype: 'thread_broadcast', text: 'reposting to channel' }),
    ).toBe(true);
  });

  it('drops bot_message (self-wake prevention preserved)', () => {
    expect(
      shouldDeliverSlackMessage({ type: 'message', subtype: 'bot_message', text: 'i am a bot' }),
    ).toBe(false);
  });

  // A photo/file shared with NO caption has empty text — the poll woke on these,
  // so the socket must deliver them too (else captionless photo shares vanish).
  it('delivers a captionless file_share (empty text)', () => {
    expect(shouldDeliverSlackMessage({ type: 'message', subtype: 'file_share', text: '' })).toBe(true);
    expect(shouldDeliverSlackMessage({ type: 'message', subtype: 'file_share' })).toBe(true);
  });

  it('drops a contentless event with no text and not a file_share (edit/delete/join)', () => {
    expect(shouldDeliverSlackMessage({ type: 'message' })).toBe(false);
    expect(shouldDeliverSlackMessage({ type: 'message', subtype: 'message_deleted', text: '' })).toBe(false);
    expect(shouldDeliverSlackMessage({ type: 'message', subtype: 'channel_join', text: '' })).toBe(false);
  });

  it('drops non-message event types', () => {
    expect(shouldDeliverSlackMessage({ type: 'reaction_added', text: 'x' })).toBe(false);
  });

  // Self-echo guard: a message the agent posts via its own bot token arrives as
  // a NORMAL message (no bot_message subtype) but carries bot_id — it must be
  // dropped, or our own outbound reply loops back into our inbox.
  it('drops a bot-authored message carrying bot_id (self-echo, no subtype)', () => {
    expect(
      shouldDeliverSlackMessage({ type: 'message', bot_id: 'B0123', text: 'my own reply' }),
    ).toBe(false);
  });

  it('drops a bot_id message even if it also looks like a file_share', () => {
    expect(
      shouldDeliverSlackMessage({ type: 'message', subtype: 'file_share', bot_id: 'B0123', text: 'echo' }),
    ).toBe(false);
  });
});

describe('SlackSocketClient — shutdown race on the restart path', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  // Regression guard: if stop() lands while apps.connections.open is in flight,
  // the resumed success path must NOT create a WebSocket (ghost listener that
  // authenticates post-shutdown). The fix re-checks isShuttingDown after the
  // fetch await.
  it('stop() during in-flight connections.open -> no WebSocket created', async () => {
    let resolveFetch!: (value: unknown) => void;
    const fetchPromise = new Promise((resolve) => {
      resolveFetch = resolve;
    });
    const fetchMock = vi.fn().mockReturnValue(fetchPromise);
    vi.stubGlobal('fetch', fetchMock);

    let wsConstructed = 0;
    class MockWebSocket {
      static OPEN = 1;
      readyState = 0;
      constructor() {
        wsConstructed++;
      }
      addEventListener(): void {}
      removeEventListener(): void {}
      close(): void {}
      send(): void {}
    }
    vi.stubGlobal('WebSocket', MockWebSocket as unknown as typeof WebSocket);

    const client = new SlackSocketClient(
      { appToken: 'xapp-1', botToken: 'xoxb-1', channelId: 'C1' },
      () => {},
      () => {},
    );

    // start() kicks off connect(), which awaits the open fetch.
    const startPromise = client.start();
    // A restart lands mid-fetch.
    client.stop();
    // The open fetch now resolves successfully (URL returned).
    resolveFetch({ ok: true, status: 200, json: async () => ({ ok: true, url: 'wss://example.test/link' }) });
    await startPromise;
    await Promise.resolve();

    expect(wsConstructed).toBe(0);
    expect(client.getConnectionState().getState()).toBe('disconnected');
  });

  it('clean open (no stop) DOES create a WebSocket — guard does not over-block', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: true, status: 200, json: async () => ({ ok: true, url: 'wss://example.test/link' }) });
    vi.stubGlobal('fetch', fetchMock);

    let wsConstructed = 0;
    class MockWebSocket {
      static OPEN = 1;
      readyState = 0;
      constructor() {
        wsConstructed++;
      }
      addEventListener(): void {}
      removeEventListener(): void {}
      close(): void {}
      send(): void {}
    }
    vi.stubGlobal('WebSocket', MockWebSocket as unknown as typeof WebSocket);

    const client = new SlackSocketClient(
      { appToken: 'xapp-1', botToken: 'xoxb-1', channelId: 'C1' },
      () => {},
      () => {},
    );
    await client.start();
    await Promise.resolve();
    expect(wsConstructed).toBe(1);
    client.stop();
  });
});

// Shared no-op WebSocket mock for reconnection tests.
function makeMockWebSocket(counters: { constructed: number; closed: number }) {
  return class MockWebSocket {
    static OPEN = 1;
    readyState = 0;
    constructor() {
      counters.constructed++;
    }
    addEventListener(): void {}
    removeEventListener(): void {}
    close(): void {
      counters.closed++;
    }
    send(): void {}
  } as unknown as typeof WebSocket;
}

describe('SlackSocketClient — reconnection robustness', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  // THE dropped-websocket recovery guard: the old code returned permanently
  // once maxReconnectAttempts (10) was reached — the backoff ladder exhausts in
  // ~3 minutes, so any longer Slack/network outage silently killed real-time
  // inbound until a daemon restart (poll dormant while Socket Mode is primary).
  it('keeps reconnecting past the soft max instead of giving up forever', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockRejectedValue(new Error('network down'));
    vi.stubGlobal('fetch', fetchMock);
    const counters = { constructed: 0, closed: 0 };
    vi.stubGlobal('WebSocket', makeMockWebSocket(counters));

    const logs: string[] = [];
    const client = new SlackSocketClient(
      { appToken: 'xapp-1', botToken: 'xoxb-1', channelId: 'C1' },
      () => {},
      (m) => logs.push(m),
    );
    await client.start(); // initial connect fails -> schedules attempt 1

    // Walk well past the 10-attempt ladder (1+2+4+8+16+30*5 ≈ 181s, then 30s each).
    for (let i = 0; i < 14; i++) {
      await vi.advanceTimersByTimeAsync(30_000);
    }

    // Old behavior: exactly 11 fetch calls (initial + 10 retries), then dead.
    expect(fetchMock.mock.calls.length).toBeGreaterThan(11);
    expect(logs.some((l) => l.includes('exceeds soft max'))).toBe(true);
    client.stop();
  });

  it('stop() ends the persistent reconnect loop', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockRejectedValue(new Error('network down'));
    vi.stubGlobal('fetch', fetchMock);
    const counters = { constructed: 0, closed: 0 };
    vi.stubGlobal('WebSocket', makeMockWebSocket(counters));

    const client = new SlackSocketClient(
      { appToken: 'xapp-1', botToken: 'xoxb-1', channelId: 'C1' },
      () => {},
      () => {},
    );
    await client.start();
    await vi.advanceTimersByTimeAsync(5_000);
    const callsAtStop = fetchMock.mock.calls.length;
    client.stop();
    await vi.advanceTimersByTimeAsync(300_000);
    expect(fetchMock.mock.calls.length).toBe(callsAtStop);
  });

  it('honors a 429 Retry-After as the floor for the next reconnect delay', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
      headers: { get: (name: string) => (name.toLowerCase() === 'retry-after' ? '7' : null) },
      json: async () => ({}),
    });
    vi.stubGlobal('fetch', fetchMock);
    const counters = { constructed: 0, closed: 0 };
    vi.stubGlobal('WebSocket', makeMockWebSocket(counters));

    const logs: string[] = [];
    const client = new SlackSocketClient(
      { appToken: 'xapp-1', botToken: 'xoxb-1', channelId: 'C1' },
      () => {},
      (m) => logs.push(m),
    );
    await client.start();

    // First backoff would be 1000ms; the Retry-After floor lifts it to 7000ms.
    expect(logs.some((l) => l.includes('reconnecting in 7000ms'))).toBe(true);
    // No reconnect before the floor elapses...
    await vi.advanceTimersByTimeAsync(6_000);
    expect(fetchMock.mock.calls.length).toBe(1);
    // ...and the retry fires once it does.
    await vi.advanceTimersByTimeAsync(1_500);
    expect(fetchMock.mock.calls.length).toBe(2);
    client.stop();
  });

  // Half-open guard: a socket whose 'open' never fires (black-holed TCP) emits
  // NO event at all — the watchdog must recycle it and re-enter backoff.
  it('recycles a WebSocket that never reaches open and reconnects', async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: true, status: 200, json: async () => ({ ok: true, url: 'wss://example.test/link' }) });
    vi.stubGlobal('fetch', fetchMock);
    const counters = { constructed: 0, closed: 0 };
    vi.stubGlobal('WebSocket', makeMockWebSocket(counters));

    const client = new SlackSocketClient(
      { appToken: 'xapp-1', botToken: 'xoxb-1', channelId: 'C1' },
      () => {},
      () => {},
    );
    await client.start();
    expect(counters.constructed).toBe(1);

    // Open-timeout fires: socket closed, reconnect scheduled (attempt 1 = 1s).
    await vi.advanceTimersByTimeAsync(15_000);
    expect(counters.closed).toBe(1);
    await vi.advanceTimersByTimeAsync(1_500);
    expect(counters.constructed).toBe(2);
    client.stop();
  });

  // stop() latches isShuttingDown; without resetting it in start(), a restarted
  // client would silently no-op every connect forever.
  it('start() after stop() connects again (client is restartable)', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: true, status: 200, json: async () => ({ ok: true, url: 'wss://example.test/link' }) });
    vi.stubGlobal('fetch', fetchMock);
    const counters = { constructed: 0, closed: 0 };
    vi.stubGlobal('WebSocket', makeMockWebSocket(counters));

    const client = new SlackSocketClient(
      { appToken: 'xapp-1', botToken: 'xoxb-1', channelId: 'C1' },
      () => {},
      () => {},
    );
    await client.start();
    expect(counters.constructed).toBe(1);
    client.stop();
    await client.start();
    expect(counters.constructed).toBe(2);
    client.stop();
  });
});

describe('SlackSocketClient — permanent auth failure classification (Moss medium)', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  // The auth-class set itself: a dead token must be classified PERMANENT.
  it('the permanent set covers all six auth-class codes', () => {
    for (const code of [
      'invalid_auth',
      'account_inactive',
      'token_revoked',
      'token_expired',
      'not_authed',
      'no_permission',
    ]) {
      expect(SLACK_PERMANENT_AUTH_ERRORS.has(code)).toBe(true);
    }
    // ...and does NOT swallow transient ok:false codes.
    expect(SLACK_PERMANENT_AUTH_ERRORS.has('internal_error')).toBe(false);
    expect(SLACK_PERMANENT_AUTH_ERRORS.has('fatal_error')).toBe(false);
  });

  // THE regression guard for the Moss finding: an invalid/revoked token
  // returns HTTP 200 ok:false — the old code threw, caught, and retried every
  // 30s FOREVER, log-spamming while masking a config error that never
  // self-heals. It must STOP reconnecting and latch a loud, visible state.
  it.each([
    'invalid_auth',
    'account_inactive',
    'token_revoked',
    'token_expired',
    'not_authed',
    'no_permission',
  ])('ok:false %s STOPS reconnection, latches fatal state, fires the alert once', async (code) => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ok: false, error: code }),
    });
    vi.stubGlobal('fetch', fetchMock);
    const counters = { constructed: 0, closed: 0 };
    vi.stubGlobal('WebSocket', makeMockWebSocket(counters));

    const logs: string[] = [];
    const onFatal = vi.fn();
    const client = new SlackSocketClient(
      { appToken: 'xapp-1', botToken: 'xoxb-1', channelId: 'C1' },
      () => {},
      (m) => logs.push(m),
      onFatal,
    );
    await client.start();

    // No matter how long we wait, NO reconnect fires (old code: one every 30s).
    for (let i = 0; i < 20; i++) {
      await vi.advanceTimersByTimeAsync(30_000);
    }
    expect(fetchMock.mock.calls.length).toBe(1);
    expect(counters.constructed).toBe(0);

    // Persistent, queryable error state (heartbeat-surfaceable).
    expect(client.getFatalAuthError()).toBe(code);
    expect(client.getConnectionState().getState()).toBe('disconnected');

    // Loud ERROR log naming operator action — not a scroll-past reconnect line.
    expect(
      logs.some((l) => l.startsWith('ERROR:') && l.includes('PERMANENT auth failure') && l.includes(code)),
    ).toBe(true);

    // One-shot operator alert callback.
    expect(onFatal).toHaveBeenCalledTimes(1);
    expect(onFatal).toHaveBeenCalledWith(code);
    client.stop();
  });

  // Transient failures must KEEP the retry-forever availability win — the
  // permanent classification must not regress PR-base behavior.
  it.each([
    [
      'non-auth ok:false (internal_error)',
      () => ({ ok: true, status: 200, json: async () => ({ ok: false, error: 'internal_error' }) }),
    ],
    [
      'HTTP 500',
      () => ({ ok: false, status: 500, headers: { get: () => null }, json: async () => ({}) }),
    ],
    [
      'HTTP 429 (no Retry-After)',
      () => ({ ok: false, status: 429, headers: { get: () => null }, json: async () => ({}) }),
    ],
  ])('%s STILL schedules reconnect (transient path unchanged)', async (_label, makeResp) => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockImplementation(async () => makeResp());
    vi.stubGlobal('fetch', fetchMock);
    const counters = { constructed: 0, closed: 0 };
    vi.stubGlobal('WebSocket', makeMockWebSocket(counters));

    const onFatal = vi.fn();
    const client = new SlackSocketClient(
      { appToken: 'xapp-1', botToken: 'xoxb-1', channelId: 'C1' },
      () => {},
      () => {},
      onFatal,
    );
    await client.start();

    // Retries keep coming — well past the soft max would too (see the
    // reconnection suite); a handful is enough to prove the loop is alive.
    for (let i = 0; i < 6; i++) {
      await vi.advanceTimersByTimeAsync(30_000);
    }
    expect(fetchMock.mock.calls.length).toBeGreaterThan(3);
    expect(client.getFatalAuthError()).toBeNull();
    expect(onFatal).not.toHaveBeenCalled();
    client.stop();
  });

  it('a network error (fetch rejects) STILL schedules reconnect', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockRejectedValue(new Error('network down'));
    vi.stubGlobal('fetch', fetchMock);
    const counters = { constructed: 0, closed: 0 };
    vi.stubGlobal('WebSocket', makeMockWebSocket(counters));

    const onFatal = vi.fn();
    const client = new SlackSocketClient(
      { appToken: 'xapp-1', botToken: 'xoxb-1', channelId: 'C1' },
      () => {},
      () => {},
      onFatal,
    );
    await client.start();
    for (let i = 0; i < 6; i++) {
      await vi.advanceTimersByTimeAsync(30_000);
    }
    expect(fetchMock.mock.calls.length).toBeGreaterThan(3);
    expect(client.getFatalAuthError()).toBeNull();
    expect(onFatal).not.toHaveBeenCalled();
    client.stop();
  });

  // Operator recovery path: fix the token, restart the agent. start() must
  // clear the fatal latch and connect fresh — otherwise the latch would make
  // the client permanently dead even with a good token.
  it('start() after a fatal auth error clears the latch and connects again', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ ok: false, error: 'invalid_auth' }) })
      .mockResolvedValue({ ok: true, status: 200, json: async () => ({ ok: true, url: 'wss://example.test/link' }) });
    vi.stubGlobal('fetch', fetchMock);
    const counters = { constructed: 0, closed: 0 };
    vi.stubGlobal('WebSocket', makeMockWebSocket(counters));

    const client = new SlackSocketClient(
      { appToken: 'xapp-1', botToken: 'xoxb-1', channelId: 'C1' },
      () => {},
      () => {},
    );
    await client.start();
    expect(client.getFatalAuthError()).toBe('invalid_auth');
    expect(counters.constructed).toBe(0);

    // Operator fixed the token and restarted.
    await client.start();
    expect(client.getFatalAuthError()).toBeNull();
    expect(counters.constructed).toBe(1);
    client.stop();
  });

  // Belt-and-suspenders: even a direct scheduleReconnect entry point (e.g. a
  // straggler ws close event) cannot restart the loop while the latch is set.
  it('no reconnect path can sneak past the fatal latch', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ok: false, error: 'token_revoked' }),
    });
    vi.stubGlobal('fetch', fetchMock);
    const counters = { constructed: 0, closed: 0 };
    vi.stubGlobal('WebSocket', makeMockWebSocket(counters));

    const client = new SlackSocketClient(
      { appToken: 'xapp-1', botToken: 'xoxb-1', channelId: 'C1' },
      () => {},
      () => {},
    );
    await client.start();
    expect(client.getFatalAuthError()).toBe('token_revoked');

    // Force the private entry point a stray close/watchdog event would hit.
    (client as unknown as { scheduleReconnect: () => void }).scheduleReconnect();
    await vi.advanceTimersByTimeAsync(300_000);
    expect(fetchMock.mock.calls.length).toBe(1);
    client.stop();
  });
});

describe('redactTokens — Slack secret coverage (used by the socket log wrapper)', () => {
  it('masks bot and app tokens', () => {
    expect(redactTokens('using xoxb-12345-abcde now')).toBe('using xoxb-**** now');
    expect(redactTokens('using xapp-1-A123-xyz now')).toBe('using xapp-**** now');
  });

  it('masks session, client, and refresh token families (previously unredacted)', () => {
    expect(redactTokens('leak xoxs-1234-abcd end')).toBe('leak xoxs-**** end');
    expect(redactTokens('leak xoxc-1234-abcd end')).toBe('leak xoxc-**** end');
    expect(redactTokens('leak xoxr-1234-abcd end')).toBe('leak xoxr-**** end');
  });

  it('masks incoming-webhook URLs (path segments are the secret)', () => {
    expect(
      redactTokens('posting to https://hooks.slack.com/services/T0001/B0002/supersecretpath now'),
    ).toBe('posting to https://hooks.slack.com/services/**** now');
  });

  it('leaves non-secret text untouched', () => {
    const text = 'Slack Socket Mode reconnecting in 7000ms (attempt 1/10)';
    expect(redactTokens(text)).toBe(text);
  });
});
