import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { HostawayAPI } from '../../../src/hostaway/api.js';

/**
 * Mocked-fetch tests for the read-only Hostaway connector: client-credentials
 * token exchange, GET-only resource fetch, limit/offset pagination, row caps,
 * and error mapping. Nothing hits the network.
 */

const realFetch = global.fetch;

function jsonResponse(body: unknown, init: { status?: number } = {}) {
  const status = init.status ?? 200;
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    json: async () => body,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  } as unknown as Response;
}

const tokenOk = () => jsonResponse({ access_token: 'tok_abc', token_type: 'Bearer', expires_in: 999 });

describe('HostawayAPI', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
    vi.useFakeTimers();
  });

  afterEach(() => {
    global.fetch = realFetch;
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('exchanges account id + api key for a Bearer token, then sends it', async () => {
    fetchMock
      .mockResolvedValueOnce(tokenOk())
      .mockResolvedValueOnce(jsonResponse({ status: 'success', result: [{ id: 1 }] }));

    const api = new HostawayAPI('99', 'key');
    await api.fetchResource('listings');

    // First call is the token exchange (POST form body).
    const [tokenUrl, tokenInit] = fetchMock.mock.calls[0];
    expect(tokenUrl).toBe('https://api.hostaway.com/v1/accessTokens');
    expect(tokenInit.method).toBe('POST');
    expect(String(tokenInit.body)).toContain('grant_type=client_credentials');
    expect(String(tokenInit.body)).toContain('client_id=99');

    // Second call is the GET with the bearer token.
    const [getUrl, getInit] = fetchMock.mock.calls[1];
    expect(getUrl).toContain('https://api.hostaway.com/v1/listings');
    expect(getInit.method).toBe('GET');
    expect((getInit.headers as Record<string, string>).Authorization).toBe('Bearer tok_abc');
  });

  it('throws when account id or api key is missing', () => {
    expect(() => new HostawayAPI('', 'key')).toThrow(/accountId/);
    expect(() => new HostawayAPI('99', '')).toThrow(/accountId|apiKey/);
  });

  it('rejects an invalid resource name before any request', async () => {
    const api = new HostawayAPI('99', 'key');
    await expect(api.fetchResource('http://evil.com')).rejects.toThrow(/Invalid Hostaway resource/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('paginates by limit/offset until a short page', async () => {
    const fullPage = Array.from({ length: 100 }, (_, i) => ({ id: i }));
    fetchMock
      .mockResolvedValueOnce(tokenOk())
      .mockResolvedValueOnce(jsonResponse({ status: 'success', result: fullPage }))
      .mockResolvedValueOnce(jsonResponse({ status: 'success', result: [{ id: 100 }] }));

    const api = new HostawayAPI('99', 'key');
    const promise = api.fetchResource('reservations');
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result.rows).toHaveLength(101);
    expect(result.pagesFetched).toBe(2);
    expect(result.truncated).toBe(false);
    // offset advanced to 100 on the second GET.
    expect(fetchMock.mock.calls[2][0]).toContain('offset=100');
  });

  it('reuses one token across pages (single token exchange)', async () => {
    const fullPage = Array.from({ length: 100 }, (_, i) => ({ id: i }));
    fetchMock
      .mockResolvedValueOnce(tokenOk())
      .mockResolvedValueOnce(jsonResponse({ status: 'success', result: fullPage }))
      .mockResolvedValueOnce(jsonResponse({ status: 'success', result: [] }));
    const api = new HostawayAPI('99', 'key');
    const promise = api.fetchResource('listings');
    await vi.runAllTimersAsync();
    await promise;
    const tokenCalls = fetchMock.mock.calls.filter((c) => String(c[0]).endsWith('/accessTokens'));
    expect(tokenCalls).toHaveLength(1);
  });

  it('stops at maxRows and marks truncated', async () => {
    const fullPage = Array.from({ length: 100 }, (_, i) => ({ id: i }));
    fetchMock
      .mockResolvedValueOnce(tokenOk())
      .mockResolvedValueOnce(jsonResponse({ status: 'success', result: fullPage }));
    const api = new HostawayAPI('99', 'key');
    const result = await api.fetchResource('listings', { maxRows: 5 });
    expect(result.rows).toHaveLength(5);
    expect(result.truncated).toBe(true);
  });

  it('maps a failed token exchange (401) to a clear auth error', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ message: 'bad creds' }, { status: 401 }));
    const api = new HostawayAPI('99', 'key');
    await expect(api.fetchResource('listings')).rejects.toThrow(/auth failed/i);
  });

  it('surfaces a Hostaway status:fail body as an error', async () => {
    fetchMock
      .mockResolvedValueOnce(tokenOk())
      .mockResolvedValueOnce(jsonResponse({ status: 'fail', message: 'nope' }));
    const api = new HostawayAPI('99', 'key');
    await expect(api.fetchResource('listings')).rejects.toThrow(/status=fail.*nope/);
  });
});
