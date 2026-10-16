import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { TenantTurnerAPI } from '../../../src/tenantturner/api.js';

/**
 * Mocked-fetch tests for the read-only Tenant Turner connector: base64-key Basic
 * auth, GET-only resource fetch, NextPage cursor pagination, row caps, and error
 * mapping. Nothing hits the network.
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

describe('TenantTurnerAPI', () => {
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

  it('sends base64(apiKey) Basic auth on a GET with the SinceDateUpdated filter', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ TotalCount: 1, NextPage: null, Data: [{ ApplicationId: 1 }] }));

    const api = new TenantTurnerAPI('key');
    const result = await api.fetchResource('applications', { sinceDateUpdated: '2026-06-20' });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain('https://api.tenantturner.com/v1/applications');
    expect(url).toContain('SinceDateUpdated=2026-06-20');
    expect(init.method).toBe('GET');
    // Basic auth value is base64 of the bare key: base64('key') === 'a2V5'.
    expect((init.headers as Record<string, string>).Authorization).toBe('Basic a2V5');
    expect(result.totalCount).toBe(1);
    expect(result.rows).toHaveLength(1);
  });

  it('throws when the api key is missing', () => {
    expect(() => new TenantTurnerAPI('')).toThrow(/apiKey/);
  });

  it('rejects an invalid resource name before any request', async () => {
    const api = new TenantTurnerAPI('key');
    await expect(api.fetchResource('http://evil.com')).rejects.toThrow(/Invalid Tenant Turner resource/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('follows the NextPage cursor until it is absent', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ TotalCount: 2, NextPage: 'Y3Vyc29y', Data: [{ ApplicationId: 1 }] }))
      .mockResolvedValueOnce(jsonResponse({ TotalCount: 2, NextPage: null, Data: [{ ApplicationId: 2 }] }));

    const api = new TenantTurnerAPI('key');
    const promise = api.fetchResource('applications', { sinceDateUpdated: '2026-06-20' });
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result.rows).toHaveLength(2);
    expect(result.pagesFetched).toBe(2);
    expect(result.truncated).toBe(false);
    // Second request carries only the cursor (URL-encoded).
    expect(fetchMock.mock.calls[1][0]).toContain('NextPage=Y3Vyc29y');
    expect(fetchMock.mock.calls[1][0]).not.toContain('SinceDateUpdated');
  });

  it('stops at maxRows and marks truncated', async () => {
    const fullPage = Array.from({ length: 10 }, (_, i) => ({ ApplicationId: i }));
    fetchMock.mockResolvedValueOnce(jsonResponse({ TotalCount: 100, NextPage: 'more', Data: fullPage }));

    const api = new TenantTurnerAPI('key');
    const result = await api.fetchResource('applications', { sinceDateUpdated: '2026-06-20', maxRows: 4 });

    expect(result.rows).toHaveLength(4);
    expect(result.truncated).toBe(true);
  });

  it('stops at maxPages and marks truncated', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ NextPage: 'p2', Data: [{ ApplicationId: 1 }] }))
      .mockResolvedValueOnce(jsonResponse({ NextPage: 'p3', Data: [{ ApplicationId: 2 }] }));

    const api = new TenantTurnerAPI('key');
    const promise = api.fetchResource('applications', { sinceDateUpdated: '2026-06-20', maxPages: 2 });
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result.pagesFetched).toBe(2);
    expect(result.truncated).toBe(true);
  });

  it('maps a 401 to a clear auth error', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ message: 'bad key' }, { status: 401 }));
    const api = new TenantTurnerAPI('key');
    await expect(api.fetchResource('applications', { sinceDateUpdated: '2026-06-20' })).rejects.toThrow(/auth failed/i);
  });

  it('maps a 404 to a resource-not-found error', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse('not found', { status: 404 }));
    const api = new TenantTurnerAPI('key');
    await expect(api.fetchResource('leads')).rejects.toThrow(/not found \(HTTP 404\)/);
  });

  it('maps a 422 SinceDateUpdated error to an actionable hint', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ StatusCode: 422, ErrorMessages: ['SinceDateUpdated is required and must be less than 2 years ago.'] }, { status: 422 }),
    );
    const api = new TenantTurnerAPI('key');
    await expect(api.fetchResource('applications')).rejects.toThrow(/pass --since/);
  });
});
