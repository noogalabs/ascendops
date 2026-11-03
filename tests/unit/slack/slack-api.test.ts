import { describe, it, expect, vi, afterEach } from 'vitest';
import { SlackAPI } from '../../../src/slack/api.js';

function okResponse(body: unknown) {
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    json: async () => body,
  };
}

function httpError(status: number, retryAfter?: string) {
  return {
    ok: false,
    status,
    headers: {
      get: (name: string) =>
        retryAfter && name.toLowerCase() === 'retry-after' ? retryAfter : null,
    },
    // Transport-level errors are often NOT JSON (proxy HTML, empty bodies) —
    // parsing must never be reached for them.
    json: async () => {
      throw new SyntaxError('Unexpected token < in JSON');
    },
  };
}

describe('SlackAPI — transport hardening', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('every call carries an abort signal (bounded timeout — a hung call must not stall the fast-checker loop)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse({ ok: true, messages: [], user: {}, user_id: 'U1' }));
    vi.stubGlobal('fetch', fetchMock);
    const api = new SlackAPI('xoxb-test');

    await api.postMessage('C1', 'hi');
    await api.getHistory('C1', '0');
    await api.getUserName('U1');
    await api.getUserInfo('U1');
    await api.getBotUserId();

    expect(fetchMock).toHaveBeenCalledTimes(5);
    for (const call of fetchMock.mock.calls) {
      const init = call[1] as RequestInit;
      expect(init.signal).toBeInstanceOf(AbortSignal);
    }
  });

  it('getHistory surfaces HTTP 429 with the Retry-After value instead of an opaque JSON parse error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(httpError(429, '12')));
    const api = new SlackAPI('xoxb-test');

    await expect(api.getHistory('C1', '0')).rejects.toThrow(/rate limited.*429.*retry after 12s/i);
  });

  it('getHistory surfaces a non-OK HTTP status descriptively (5xx/proxy pages are not JSON)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(httpError(502)));
    const api = new SlackAPI('xoxb-test');

    await expect(api.getHistory('C1', '0')).rejects.toThrow(/HTTP 502/);
  });

  it('postMessage throws the Slack app-level error on ok:false (HTTP 200)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(okResponse({ ok: false, error: 'channel_not_found' })));
    const api = new SlackAPI('xoxb-test');

    await expect(api.postMessage('C1', 'hi')).rejects.toThrow(/channel_not_found/);
  });

  it('postMessage surfaces HTTP 429 as a rate-limit error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(httpError(429, '30')));
    const api = new SlackAPI('xoxb-test');

    await expect(api.postMessage('C1', 'hi')).rejects.toThrow(/rate limited/i);
  });

  it('sends a thread parent as the original string and still redacts message content', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);

    await new SlackAPI('xoxb-test').postMessage('D1', 'Case SSN 123-45-6789', undefined, {
      thread_ts: '1762182234.000001',
    });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.channel).toBe('D1');
    expect(body.thread_ts).toBe('1762182234.000001');
    expect(body.text).not.toContain('123-45-6789');
    expect(body).not.toHaveProperty('reply_broadcast');
  });

  it('keeps existing top-level calls unchanged', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);
    await new SlackAPI('xoxb-test').postMessage('C1', 'status');
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ channel: 'C1', text: 'status' });
  });

  it('returns the posted timestamp string and conversation for a durable new case parent', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(okResponse({
      ok: true, ts: '1762182234.000001', channel: 'D12345',
    })));
    await expect(new SlackAPI('xoxb-test').postMessage('D12345', 'New case')).resolves.toEqual({
      ts: '1762182234.000001', channel: 'D12345',
    });
  });

  it('does not emit malformed receipt fields returned by the API', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(okResponse({
      ok: true, ts: 1762182234.000001, channel: 'unsafe\nchannel',
    })));
    await expect(new SlackAPI('xoxb-test').postMessage('D12345', 'New case')).resolves.toEqual({});
  });

  it.each(['1e9', '1762182234', '1762182234.1', '1762182234.000001\n', '1762182234.000001;other', 1762182234.000001, null])(
    'rejects an invalid thread timestamp before sending: %j', async (thread_ts) => {
      const fetchMock = vi.fn();
      vi.stubGlobal('fetch', fetchMock);
      await expect(new SlackAPI('xoxb-test').postMessage('D1', 'status', undefined, {
        thread_ts: thread_ts as string,
      })).rejects.toThrow(/thread timestamp/i);
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it('getUserInfo never throws: HTTP failure -> null', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(httpError(500)));
    const api = new SlackAPI('xoxb-test');

    await expect(api.getUserInfo('U1')).resolves.toBeNull();
  });

  it('getBotUserId never throws: network rejection -> null', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('socket hang up')));
    const api = new SlackAPI('xoxb-test');

    await expect(api.getBotUserId()).resolves.toBeNull();
  });

  it('getUserName never throws: rejection -> falls back to the user id', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('timeout')));
    const api = new SlackAPI('xoxb-test');

    await expect(api.getUserName('U42')).resolves.toBe('U42');
  });

  it('getHistory returns newest-last (reversed) on success', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        okResponse({
          ok: true,
          messages: [
            { ts: '2.0', type: 'message', text: 'newest' },
            { ts: '1.0', type: 'message', text: 'oldest' },
          ],
        }),
      ),
    );
    const api = new SlackAPI('xoxb-test');

    const messages = await api.getHistory('C1', '0');
    expect(messages.map((m) => m.ts)).toEqual(['1.0', '2.0']);
  });
});
