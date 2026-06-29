/**
 * Minimal, READ-ONLY Hostaway Public API v1 client using built-in fetch
 * (Node 20+).
 *
 * This connector is read-only BY CONSTRUCTION: it only ever issues HTTP GET
 * requests and exposes no create/update/delete methods. Hostaway's API key is
 * account-level and *could* write, so the safety guarantee here is that the
 * agents' tool simply has no code path that writes — see the connector plan.
 *
 * Auth:   OAuth2 client-credentials. Trade Account ID (client_id) + API Key
 *         (client_secret) for a Bearer access token at /v1/accessTokens, then
 *         send `Authorization: Bearer <token>` on every call. We mint a token
 *         per process (CLI invocations are short-lived) and reuse it for all
 *         requests in that run.
 * Call:   GET https://api.hostaway.com/v1/{resource}?limit=&offset=
 * Reply:  { status: 'success', result: [...], count, limit, offset }
 * Paging: limit/offset — walk until a short page or the row cap is hit.
 */

const BASE_URL = 'https://api.hostaway.com/v1';
const API_TIMEOUT_MS = 30_000;
const PAGE_SIZE = 100;
const DEFAULT_MAX_PAGES = 20;

export interface HostawayListResponse {
  status: string;
  result?: unknown[];
  count?: number;
  limit?: number;
  offset?: number;
  message?: string;
}

export interface FetchResourceOptions {
  /** Extra query params merged into each request (e.g. { listingId: 123 }). */
  query?: Record<string, string | number>;
  maxPages?: number;
  maxRows?: number;
}

export interface FetchResourceResult {
  resource: string;
  rows: unknown[];
  pagesFetched: number;
  truncated: boolean;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class HostawayAPI {
  private readonly accountId: string;
  private readonly apiKey: string;
  private token: string | null = null;

  /**
   * @param accountId Hostaway Account ID (OAuth client_id)
   * @param apiKey    Hostaway API Key  (OAuth client_secret)
   */
  constructor(accountId: string, apiKey: string) {
    if (!accountId || !apiKey) {
      throw new Error('HostawayAPI requires both accountId and apiKey');
    }
    this.accountId = accountId;
    this.apiKey = apiKey;
  }

  /**
   * Obtain (and cache for this process) a Bearer access token via the
   * client-credentials grant. scope=general is the standard read scope.
   */
  private async getToken(): Promise<string> {
    if (this.token) return this.token;

    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: this.accountId,
      client_secret: this.apiKey,
      scope: 'general',
    });

    const response = await fetch(`${BASE_URL}/accessTokens`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Cache-Control': 'no-cache',
      },
      body,
      signal: AbortSignal.timeout(API_TIMEOUT_MS),
    });

    if (!response.ok) {
      let detail = '';
      try {
        detail = (await response.text()).slice(0, 300);
      } catch {
        /* ignore */
      }
      if (response.status === 401 || response.status === 403) {
        throw new Error(
          `Hostaway auth failed (HTTP ${response.status}). Check HOSTAWAY_ACCOUNT_ID / ` +
            `HOSTAWAY_API_KEY in secrets.env (Settings → Hostaway API).${detail ? ` — ${detail}` : ''}`,
        );
      }
      throw new Error(`Hostaway token request failed: HTTP ${response.status}${detail ? ` — ${detail}` : ''}`);
    }

    const data = (await response.json()) as { access_token?: string };
    if (!data.access_token) {
      throw new Error('Hostaway token response did not include an access_token');
    }
    this.token = data.access_token;
    return this.token;
  }

  /**
   * Fetch a read-only Hostaway list resource (e.g. "listings", "reservations",
   * "calendar"), following limit/offset pagination up to the configured caps.
   *
   * Only GET is ever issued — there is no write counterpart on this client.
   */
  async fetchResource(resource: string, opts: FetchResourceOptions = {}): Promise<FetchResourceResult> {
    const safe = resource.replace(/^\/+|\/+$/g, '').trim();
    if (!/^[a-z0-9/_-]+$/i.test(safe)) {
      throw new Error(`Invalid Hostaway resource "${resource}" (expected like "listings")`);
    }

    const token = await this.getToken();
    const maxPages = opts.maxPages ?? DEFAULT_MAX_PAGES;
    const rows: unknown[] = [];
    let pagesFetched = 0;
    let truncated = false;
    let offset = 0;

    while (true) {
      const params = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(offset) });
      for (const [k, v] of Object.entries(opts.query ?? {})) params.set(k, String(v));

      const data = await this.requestGet<HostawayListResponse>(
        `${BASE_URL}/${safe}?${params}`,
        token,
        safe,
      );

      const pageRows = Array.isArray(data.result) ? data.result : [];
      pagesFetched += 1;

      for (const row of pageRows) {
        rows.push(row);
        if (opts.maxRows != null && rows.length >= opts.maxRows) {
          return { resource: safe, rows, pagesFetched, truncated: true };
        }
      }

      // A short page means we've reached the end.
      if (pageRows.length < PAGE_SIZE) break;
      if (pagesFetched >= maxPages) {
        truncated = true;
        break;
      }
      offset += PAGE_SIZE;
      await sleep(200); // gentle throttle between pages
    }

    return { resource: safe, rows, pagesFetched, truncated };
  }

  /**
   * Shared GET wrapper: bounded timeout, HTTP-status checks, Hostaway-level
   * `status:fail` detection. Never throws the credentials into the message.
   */
  private async requestGet<T>(url: string, token: string, resource: string): Promise<T> {
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        'Cache-Control': 'no-cache',
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(API_TIMEOUT_MS),
    });

    if (!response.ok) {
      let detail = '';
      try {
        detail = (await response.text()).slice(0, 300);
      } catch {
        /* ignore */
      }
      if (response.status === 404) {
        throw new Error(
          `Hostaway resource "${resource}" not found (HTTP 404). The resource name may be wrong.` +
            `${detail ? ` — ${detail}` : ''}`,
        );
      }
      throw new Error(`Hostaway resource "${resource}" failed: HTTP ${response.status}${detail ? ` — ${detail}` : ''}`);
    }

    const data = (await response.json()) as T & { status?: string; message?: string };
    if (data.status && data.status !== 'success') {
      throw new Error(`Hostaway resource "${resource}" returned status=${data.status}${data.message ? `: ${data.message}` : ''}`);
    }
    return data;
  }
}
