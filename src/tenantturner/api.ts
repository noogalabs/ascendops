/**
 * Minimal, READ-ONLY Tenant Turner API v1 client using built-in fetch
 * (Node 20+).
 *
 * This connector is read-only BY CONSTRUCTION: it only ever issues HTTP GET
 * requests and exposes no create/update/delete methods. Tenant Turner's private
 * API key is account-level and *could* write (POST /v1/showings books a
 * showing), so the safety guarantee here is that this client has no code path
 * that writes — see the connector plan.
 *
 * Auth:   HTTP Basic where the credential is base64 of the bare API key (there
 *         is no username:password pair — just the key). Sent as an
 *         `Authorization: Basic <base64(apiKey)>` header, never in the URL.
 * Call:   GET https://api.tenantturner.com/v1/{resource}?SinceDateUpdated=YYYY-MM-DD
 *         (SinceDateUpdated is REQUIRED by some resources, e.g. "applications",
 *         and must be within the last 2 years; "properties" needs no params.)
 * Reply:  { TotalCount, NextPage: "<base64 cursor>" | null, Data: [ ...rows ] }
 * Paging: follow the opaque `NextPage` cursor — pass it back as
 *         ?NextPage=<cursor> (it already encodes the page size + SinceDateUpdated).
 *         Walk until NextPage is absent or the page/row cap is hit.
 */

const BASE_URL = 'https://api.tenantturner.com';
const API_TIMEOUT_MS = 30_000;

/** Safety cap so a huge account (thousands of leads) can't spin forever. The
 *  API returns ~10 rows/page, so 20 pages ≈ 200 rows. Override via opts.maxPages.
 *  Reports should pass a recent `sinceDateUpdated` to keep the walk short. */
const DEFAULT_MAX_PAGES = 20;

export interface TenantTurnerListResponse {
  TotalCount?: number;
  NextPage?: string | null;
  Data?: unknown[];
  StatusCode?: number;
  ErrorMessages?: string[];
}

export interface FetchResourceOptions {
  /** SinceDateUpdated filter (YYYY-MM-DD, within the last 2 years). Required by
   *  resources like "applications"; omit for resources that don't need it. */
  sinceDateUpdated?: string;
  /** Extra query params merged into the first request. */
  query?: Record<string, string | number>;
  maxPages?: number;
  maxRows?: number;
}

export interface FetchResourceResult {
  resource: string;
  rows: unknown[];
  /** Server-reported total across all pages (null if the resource omits it). */
  totalCount: number | null;
  pagesFetched: number;
  /** True when a page cap / row cap stopped us before the data ran out. */
  truncated: boolean;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class TenantTurnerAPI {
  private readonly authHeader: string;

  /**
   * @param apiKey Tenant Turner account private API key (Settings → Tenant
   *               Turner API). The Basic-auth value is base64 of the bare key.
   */
  constructor(apiKey: string) {
    if (!apiKey) {
      throw new Error('TenantTurnerAPI requires an apiKey');
    }
    // HTTP Basic auth: base64 of the bare key (no colon / username), sent as a
    // header rather than embedded in the URL so it can't leak into logs.
    this.authHeader = 'Basic ' + Buffer.from(apiKey).toString('base64');
  }

  /**
   * Fetch a read-only Tenant Turner list resource (e.g. "applications",
   * "properties"), following the NextPage cursor up to the configured caps.
   *
   * Only GET is ever issued — there is no write counterpart on this client.
   */
  async fetchResource(resource: string, opts: FetchResourceOptions = {}): Promise<FetchResourceResult> {
    const safe = resource.replace(/^\/+|\/+$/g, '').trim();
    if (!/^[a-z0-9/_-]+$/i.test(safe)) {
      throw new Error(`Invalid Tenant Turner resource "${resource}" (expected like "applications")`);
    }

    const maxPages = opts.maxPages ?? DEFAULT_MAX_PAGES;
    const rows: unknown[] = [];
    let totalCount: number | null = null;
    let pagesFetched = 0;
    let truncated = false;

    // First page: SinceDateUpdated + any extra query params.
    const firstParams = new URLSearchParams();
    if (opts.sinceDateUpdated) firstParams.set('SinceDateUpdated', opts.sinceDateUpdated);
    for (const [k, v] of Object.entries(opts.query ?? {})) firstParams.set(k, String(v));
    let url = `${BASE_URL}/v1/${safe}${firstParams.toString() ? `?${firstParams}` : ''}`;

    while (true) {
      const data = await this.requestGet(url, safe);
      if (typeof data.TotalCount === 'number') totalCount = data.TotalCount;

      const pageRows = Array.isArray(data.Data) ? data.Data : [];
      pagesFetched += 1;

      for (const row of pageRows) {
        rows.push(row);
        if (opts.maxRows != null && rows.length >= opts.maxRows) {
          return { resource: safe, rows, totalCount, pagesFetched, truncated: true };
        }
      }

      // No cursor means we've reached the last page.
      if (!data.NextPage) break;
      if (pagesFetched >= maxPages) {
        truncated = true;
        break;
      }

      // The NextPage cursor already encodes the page size + SinceDateUpdated, so
      // subsequent pages carry only it.
      const nextParams = new URLSearchParams({ NextPage: data.NextPage });
      url = `${BASE_URL}/v1/${safe}?${nextParams}`;
      await sleep(200); // gentle throttle between pages
    }

    return { resource: safe, rows, totalCount, pagesFetched, truncated };
  }

  /**
   * Shared GET wrapper: bounded timeout, HTTP-status checks, and actionable
   * error mapping. Never puts the API key into the message.
   */
  private async requestGet(url: string, resource: string): Promise<TenantTurnerListResponse> {
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        Authorization: this.authHeader,
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
      if (response.status === 401 || response.status === 403) {
        throw new Error(
          `Tenant Turner auth failed (HTTP ${response.status}). Check TENANTTURNER_API_KEY ` +
            `in secrets.env (Tenant Turner → Settings → Tenant Turner API).${detail ? ` — ${detail}` : ''}`,
        );
      }
      if (response.status === 404) {
        throw new Error(
          `Tenant Turner resource "${resource}" not found (HTTP 404). ` +
            `The resource name may be wrong (try "applications" or "properties").${detail ? ` — ${detail}` : ''}`,
        );
      }
      if (response.status === 422) {
        const hint = /SinceDateUpdated/i.test(detail)
          ? ' — pass --since YYYY-MM-DD (a date within the last 2 years).'
          : '';
        throw new Error(`Tenant Turner resource "${resource}" rejected the request (HTTP 422).${detail ? ` ${detail}` : ''}${hint}`);
      }
      throw new Error(`Tenant Turner resource "${resource}" failed: HTTP ${response.status}${detail ? ` — ${detail}` : ''}`);
    }

    return (await response.json()) as TenantTurnerListResponse;
  }
}
