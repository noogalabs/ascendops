import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ZInspectorAPI } from '../../../src/zinspector/api.js';

/**
 * Mocked-fetch tests for the read-only zInspector connector: x-api-key auth,
 * GET-only resource fetch with the required trailing slash, `next`-URL
 * pagination (cursor + page styles both expose a full next URL), row caps, and
 * error mapping. Nothing hits the network.
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

describe('ZInspectorAPI', () => {
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

  it('sends the x-api-key header on a GET to the trailing-slash path', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ results: [{ id: 1 }], next: null }));

    const api = new ZInspectorAPI('enc_key', 'https://portfolio.zinspector.com');
    const result = await api.fetchResource('propertiesCursor');

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://portfolio.zinspector.com/api/propertiesCursor/');
    expect(init.method).toBe('GET');
    expect((init.headers as Record<string, string>)['x-api-key']).toBe('enc_key');
    expect(result.rows).toHaveLength(1);
  });

  it('throws when the api key is missing', () => {
    expect(() => new ZInspectorAPI('')).toThrow(/apiKey/);
  });

  it('defaults the base URL and strips a trailing slash from it', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ results: [], next: null }));
    const api = new ZInspectorAPI('enc_key', 'https://portfolio.zinspector.com/');
    await api.fetchResource('documents');
    expect(fetchMock.mock.calls[0][0]).toBe('https://portfolio.zinspector.com/api/documents/');
  });

  it('rejects an invalid resource name before any request', async () => {
    const api = new ZInspectorAPI('enc_key');
    await expect(api.fetchResource('http://evil.com')).rejects.toThrow(/Invalid zInspector resource/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('follows the next URL until it is null and records count', async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({ count: 2, results: [{ id: 1 }], next: 'https://portfolio.zinspector.com/api/media/?page=2' }),
      )
      .mockResolvedValueOnce(jsonResponse({ count: 2, results: [{ id: 2 }], next: null }));

    const api = new ZInspectorAPI('enc_key');
    const promise = api.fetchResource('media');
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result.rows).toHaveLength(2);
    expect(result.pagesFetched).toBe(2);
    expect(result.count).toBe(2);
    expect(result.truncated).toBe(false);
    // Second request goes straight to the next URL zInspector handed back.
    expect(fetchMock.mock.calls[1][0]).toBe('https://portfolio.zinspector.com/api/media/?page=2');
  });

  it('stops at maxRows and marks truncated', async () => {
    const fullPage = Array.from({ length: 10 }, (_, i) => ({ id: i }));
    fetchMock.mockResolvedValueOnce(jsonResponse({ results: fullPage, next: 'https://x/api/media/?page=2' }));
    const api = new ZInspectorAPI('enc_key');
    const result = await api.fetchResource('media', { maxRows: 3 });
    expect(result.rows).toHaveLength(3);
    expect(result.truncated).toBe(true);
  });

  it('stops at maxPages and marks truncated', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ results: [{ id: 1 }], next: 'https://x/api/documents/?page=2' }))
      .mockResolvedValueOnce(jsonResponse({ results: [{ id: 2 }], next: 'https://x/api/documents/?page=3' }));
    const api = new ZInspectorAPI('enc_key');
    const promise = api.fetchResource('documents', { maxPages: 2 });
    await vi.runAllTimersAsync();
    const result = await promise;
    expect(result.pagesFetched).toBe(2);
    expect(result.truncated).toBe(true);
  });

  it('maps a 401 to a clear auth error', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse('unauthorized', { status: 401 }));
    const api = new ZInspectorAPI('enc_key');
    await expect(api.fetchResource('documents')).rejects.toThrow(/auth failed/i);
  });

  it('maps a 403 permission_denied to an actionable message about Linked User + IP', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ code: 'permission_denied', detail: 'Request not allowed for this API key.' }, { status: 403 }),
    );
    const api = new ZInspectorAPI('enc_key');
    await expect(api.fetchResource('propertiesCursor')).rejects.toThrow(/Linked User.*Admin|whitelist/);
  });

  it('maps a 404 to a resource-not-found error', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse('not found', { status: 404 }));
    const api = new ZInspectorAPI('enc_key');
    await expect(api.fetchResource('nope')).rejects.toThrow(/not found \(HTTP 404\)/);
  });
});
