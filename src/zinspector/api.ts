/**
 * Minimal, READ-ONLY zInspector API v1 client using built-in fetch (Node 20+).
 *
 * This connector is read-only BY CONSTRUCTION: it only ever issues HTTP GET
 * requests and exposes no create/update/delete methods. The key's write ability
 * (if any) is governed by its Linked User in zInspector; the safety guarantee
 * here is that this client simply has no code path that writes.
 *
 * Auth:   header `x-api-key: <encoded key>` where the encoded key is
 *         base64(KeyID:Secret) — exactly the value zInspector shows as the
 *         "Encoded API key". Sent as a header, never in the URL.
 * Call:   GET {baseUrl}/api/{resource}/   (the TRAILING SLASH is required — a
 *         slashless path 301-redirects).
 * Reply:  { results: [ ...rows ], next: "<full URL>" | null, previous, count? }
 * Paging: two styles exist (cursor `?cursor=` for propertiesCursor, page
 *         `?page=N` for documents/media) but BOTH expose `next` as a fully
 *         qualified URL, so we just follow `next` until it's null or a cap hits.
 */

const API_TIMEOUT_MS = 30_000;
const DEFAULT_BASE_URL = 'https://portfolio.zinspector.com';

/** Safety cap so a large account can't spin forever. Override via opts.maxPages. */
const DEFAULT_MAX_PAGES = 20;

export interface ZInspectorListResponse {
  results?: unknown[];
  next?: string | null;
  previous?: string | null;
  count?: number;
}

export interface FetchResourceOptions {
  /** Extra query params merged into the first request (e.g. { property: 123 }). */
  query?: Record<string, string | number>;
  maxPages?: number;
  maxRows?: number;
}

export interface FetchResourceResult {
  resource: string;
  rows: unknown[];
  /** Server-reported total when the endpoint provides it (page-style), else null. */
  count: number | null;
  pagesFetched: number;
  /** True when a page cap / row cap stopped us before the data ran out. */
  truncated: boolean;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class ZInspectorAPI {
  private readonly baseUrl: string;
  private readonly apiKey: string;

  /**
   * @param apiKey  The zInspector "Encoded API key" (base64 of KeyID:Secret).
   * @param baseUrl e.g. https://portfolio.zinspector.com (trailing slash OK).
   */
  constructor(apiKey: string, baseUrl: string = DEFAULT_BASE_URL) {
    if (!apiKey) {
      throw new Error('ZInspectorAPI requires an apiKey');
    }
    this.apiKey = apiKey;
    this.baseUrl = (baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');
  }

  /**
   * Fetch a read-only zInspector list resource (e.g. "propertiesCursor",
   * "documents", "media", "process"), following the `next` cursor up to the caps.
   *
   * Only GET is ever issued — there is no write counterpart on this client.
   */
  async fetchResource(resource: string, opts: FetchResourceOptions = {}): Promise<FetchResourceResult> {
    const safe = resource.replace(/^\/+|\/+$/g, '').trim();
    if (!/^[a-z0-9/_-]+$/i.test(safe)) {
      throw new Error(`Invalid zInspector resource "${resource}" (expected like "propertiesCursor")`);
    }

    const maxPages = opts.maxPages ?? DEFAULT_MAX_PAGES;
    const rows: unknown[] = [];
    let count: number | null = null;
    let pagesFetched = 0;
    let truncated = false;

    // First page: the trailing slash is required. Merge any extra query params.
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(opts.query ?? {})) params.set(k, String(v));
    let url = `${this.baseUrl}/api/${safe}/${params.toString() ? `?${params}` : ''}`;

    while (true) {
      const data = await this.requestGet(url, safe);
      if (typeof data.count === 'number') count = data.count;

      const pageRows = Array.isArray(data.results) ? data.results : [];
      pagesFetched += 1;

      for (const row of pageRows) {
        rows.push(row);
        if (opts.maxRows != null && rows.length >= opts.maxRows) {
          return { resource: safe, rows, count, pagesFetched, truncated: true };
        }
      }

      // `next` is a fully-qualified URL for both cursor- and page-style paging.
      if (!data.next) break;
      if (pagesFetched >= maxPages) {
        truncated = true;
        break;
      }
      url = data.next;
      await sleep(200); // gentle throttle between pages
    }

    return { resource: safe, rows, count, pagesFetched, truncated };
  }

  /**
   * Shared GET wrapper: bounded timeout, HTTP-status checks, and actionable
   * error mapping. Never puts the key into the message.
   */
  private async requestGet(url: string, resource: string): Promise<ZInspectorListResponse> {
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'x-api-key': this.apiKey,
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(API_TIMEOUT_MS),
    });

    if (!response.ok) {
      let detail = '';
      try {
        detail = (await response.text()).slice(0, 300);
      } catch {
        /* ignore — body already consumed or unreadable */
      }
      if (response.status === 401) {
        throw new Error(
          `zInspector auth failed (HTTP 401). Check ZINSPECTOR_API_KEY in secrets.env ` +
            `(it must be the "Encoded API key" value).${detail ? ` — ${detail}` : ''}`,
        );
      }
      if (response.status === 403) {
        throw new Error(
          `zInspector denied resource "${resource}" (HTTP 403 permission_denied). The API key ` +
            `must be created with its Linked User set to an Admin/Owner, and your current public ` +
            `IP must be in the key's whitelist.${detail ? ` — ${detail}` : ''}`,
        );
      }
      if (response.status === 404) {
        throw new Error(
          `zInspector resource "${resource}" not found (HTTP 404). Check the resource name ` +
            `(e.g. propertiesCursor, documents, media, process).${detail ? ` — ${detail}` : ''}`,
        );
      }
      throw new Error(`zInspector resource "${resource}" failed: HTTP ${response.status}${detail ? ` — ${detail}` : ''}`);
    }

    return (await response.json()) as ZInspectorListResponse;
  }
}
