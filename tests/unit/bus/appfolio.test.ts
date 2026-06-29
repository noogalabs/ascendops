import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { AppFolioAPI } from '../../../src/appfolio/api.js';

/**
 * These tests drive a mocked global.fetch so nothing hits the network. They
 * cover the contract that matters for the read-only AppFolio connector:
 * Basic-auth header construction, POST-then-follow-next_page_url pagination,
 * the bare-array (paginate_results=false) response shape, row/page caps, and
 * error mapping (auth, 404, 429-retry).
 */

const realFetch = global.fetch;

function jsonResponse(body: unknown, init: { status?: number; headers?: Record<string, string> } = {}) {
  const status = init.status ?? 200;
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k: string) => init.headers?.[k.toLowerCase()] ?? null },
    json: async () => body,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  } as unknown as Response;
}

describe('AppFolioAPI', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
    // Make the page-throttle sleeps instant so tests don't wait seconds.
    vi.useFakeTimers();
  });

  afterEach(() => {
    global.fetch = realFetch;
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('constructs a Basic auth header and normalizes the base URL', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ results: [], next_page_url: null }));
    const api = new AppFolioAPI('cid', 'secret', 'https://showcase.appfolio.com/');
    await api.fetchReport('rent_roll');

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://showcase.appfolio.com/api/v2/reports/rent_roll.json');
    expect(init.method).toBe('POST');
    const expected = 'Basic ' + Buffer.from('cid:secret').toString('base64');
    expect((init.headers as Record<string, string>).Authorization).toBe(expected);
  });

  it('throws when credentials or base URL are missing', () => {
    expect(() => new AppFolioAPI('', 'secret', 'https://x.appfolio.com')).toThrow(/clientId/);
    expect(() => new AppFolioAPI('cid', '', 'https://x.appfolio.com')).toThrow(/clientSecret/);
    expect(() => new AppFolioAPI('cid', 'secret', '')).toThrow(/baseUrl/);
  });

  it('rejects an invalid report name before making a request', async () => {
    const api = new AppFolioAPI('cid', 'secret', 'https://x.appfolio.com');
    await expect(api.fetchReport('../../etc/passwd')).rejects.toThrow(/Invalid report name/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('follows next_page_url and aggregates rows across pages', async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({ results: [{ id: 1 }], next_page_url: 'https://x.appfolio.com/next?p=2' }),
      )
      .mockResolvedValueOnce(jsonResponse({ results: [{ id: 2 }], next_page_url: null }));

    const api = new AppFolioAPI('cid', 'secret', 'https://x.appfolio.com');
    const promise = api.fetchReport('delinquency');
    await vi.runAllTimersAsync(); // flush the inter-page throttle sleep
    const result = await promise;

    expect(result.rows).toEqual([{ id: 1 }, { id: 2 }]);
    expect(result.pagesFetched).toBe(2);
    expect(result.truncated).toBe(false);
    // Page 2 is fetched as a GET against the exact next_page_url.
    expect(fetchMock.mock.calls[1][0]).toBe('https://x.appfolio.com/next?p=2');
    expect(fetchMock.mock.calls[1][1].method).toBe('GET');
  });

  it('handles the bare-array (paginate_results=false) response shape', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse([{ id: 1 }, { id: 2 }]));
    const api = new AppFolioAPI('cid', 'secret', 'https://x.appfolio.com');
    const result = await api.fetchReport('unit_directory');
    expect(result.rows).toHaveLength(2);
    expect(result.truncated).toBe(false);
  });

  it('stops at maxPages and marks the result truncated', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ results: [{ id: 1 }], next_page_url: 'https://x.appfolio.com/next' }),
    );
    const api = new AppFolioAPI('cid', 'secret', 'https://x.appfolio.com');
    const promise = api.fetchReport('rent_roll', {}, { maxPages: 2 });
    await vi.runAllTimersAsync();
    const result = await promise;
    expect(result.pagesFetched).toBe(2);
    expect(result.truncated).toBe(true);
  });

  it('retries once on HTTP 429 honoring Retry-After, then succeeds', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ message: 'slow down' }, { status: 429, headers: { 'retry-after': '1' } }))
      .mockResolvedValueOnce(jsonResponse({ results: [{ id: 1 }], next_page_url: null }));
    const api = new AppFolioAPI('cid', 'secret', 'https://x.appfolio.com');
    const promise = api.fetchReport('rent_roll');
    await vi.runAllTimersAsync(); // flush the retry-after sleep
    const result = await promise;
    expect(result.rows).toEqual([{ id: 1 }]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('maps 401/403 to a clear auth error', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ message: 'unauthorized' }, { status: 401 }));
    const api = new AppFolioAPI('cid', 'secret', 'https://x.appfolio.com');
    await expect(api.fetchReport('rent_roll')).rejects.toThrow(/auth failed/i);
  });

  it('maps 404 to a "report not found" error', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ message: 'not a valid report' }, { status: 404 }));
    const api = new AppFolioAPI('cid', 'secret', 'https://x.appfolio.com');
    await expect(api.fetchReport('made_up_report')).rejects.toThrow(/not found/i);
  });
});
