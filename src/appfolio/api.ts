/**
 * Minimal, READ-ONLY AppFolio Reporting (Data) API v2 client using built-in
 * fetch (Node 20+).
 *
 * AppFolio's Reporting API is read-only by design: every endpoint is a report
 * under /api/v2/reports/{report_name}.json and only ever returns data — there
 * are no write/mutate endpoints here, so this connector cannot change anything
 * in AppFolio. That is intentional (see the AppFolio connector plan): the
 * agents get to *read* property data, nothing more.
 *
 * Auth:    HTTP Basic — username = Client ID, password = Client Secret.
 * Call:    POST https://{db}.appfolio.com/api/v2/reports/{report}.json
 *          with a JSON body of filter params (`application/json`).
 * Reply:   { "results": [ ...rows ], "next_page_url": "https://..." | null }
 *          When paginate_results=false the body is a bare array of rows.
 * Paging:  follow `next_page_url` (a GET, valid ~30 min, not rate-limited).
 * Limits:  7 requests / 15 s on the base endpoints (429 on exceed); the
 *          next_page_url is exempt.
 */

/** Base report calls can be slow (server-side report generation), so this is
 *  deliberately longer than the chat-API clients' 10s. */
const API_TIMEOUT_MS = 60_000;

/** Stay comfortably under "7 requests / 15s" when walking pages on the base
 *  endpoint. next_page_url is exempt from rate limits, but throttling the
 *  whole walk is the simplest safe behavior. */
const PAGE_THROTTLE_MS = 2_300;

/** Safety cap so a runaway/huge report can't spin forever or blow up memory.
 *  At 5,000 rows/page this is up to ~100k rows. Override via opts.maxPages. */
const DEFAULT_MAX_PAGES = 20;

export interface AppFolioReportResponse {
  results?: Record<string, unknown>[];
  next_page_url?: string | null;
}

export interface FetchReportOptions {
  /** Stop after this many pages (default DEFAULT_MAX_PAGES). */
  maxPages?: number;
  /** Stop once this many rows have been collected (across pages). */
  maxRows?: number;
}

export interface FetchReportResult {
  report: string;
  rows: Record<string, unknown>[];
  pagesFetched: number;
  /** True when a page cap / row cap stopped us before AppFolio ran out of pages. */
  truncated: boolean;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class AppFolioAPI {
  private readonly baseUrl: string;
  private readonly authHeader: string;

  /**
   * @param clientId     AppFolio Reports API Client ID (Basic-auth username)
   * @param clientSecret AppFolio Reports API Client Secret (Basic-auth password)
   * @param baseUrl      e.g. https://yourcompany.appfolio.com (trailing slash OK)
   */
  constructor(clientId: string, clientSecret: string, baseUrl: string) {
    if (!clientId || !clientSecret) {
      throw new Error('AppFolioAPI requires both clientId and clientSecret');
    }
    if (!baseUrl) {
      throw new Error('AppFolioAPI requires a baseUrl (e.g. https://yourco.appfolio.com)');
    }
    // Normalize: strip trailing slash so we can join paths cleanly.
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    // HTTP Basic auth. We send it as a header rather than embedding the secret
    // in the URL (which would leak into logs/error messages).
    this.authHeader =
      'Basic ' + Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  }

  /**
   * Fetch a report by its AppFolio path name (without the .json), following
   * pagination automatically up to the configured caps.
   *
   * @param reportName e.g. "rent_roll", "delinquency", "unit_directory"
   * @param params     Report filter params sent as the JSON body, e.g.
   *                   { properties: { property_visibility: 'active' } }. AppFolio
   *                   reports each accept their own filters; pass {} for defaults.
   */
  async fetchReport(
    reportName: string,
    params: Record<string, unknown> = {},
    opts: FetchReportOptions = {},
  ): Promise<FetchReportResult> {
    const safeName = reportName.replace(/\.json$/i, '').trim();
    if (!/^[a-z0-9_]+$/i.test(safeName)) {
      throw new Error(`Invalid report name "${reportName}" (expected like "rent_roll")`);
    }

    const maxPages = opts.maxPages ?? DEFAULT_MAX_PAGES;
    const rows: Record<string, unknown>[] = [];
    let pagesFetched = 0;
    let truncated = false;

    // First page: POST the report endpoint with the filter params.
    let body = await this.requestJson<AppFolioReportResponse | Record<string, unknown>[]>(
      `${this.baseUrl}/api/v2/reports/${safeName}.json`,
      {
        method: 'POST',
        headers: {
          Authorization: this.authHeader,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify(params),
      },
      safeName,
    );

    while (true) {
      // paginate_results=false yields a bare array; the normal shape is { results, next_page_url }.
      const pageRows = Array.isArray(body) ? body : body.results ?? [];
      const nextUrl = Array.isArray(body) ? null : body.next_page_url ?? null;
      pagesFetched += 1;

      for (const row of pageRows) {
        rows.push(row as Record<string, unknown>);
        if (opts.maxRows != null && rows.length >= opts.maxRows) {
          truncated = nextUrl != null || rows.length < pageRows.length;
          return { report: safeName, rows, pagesFetched, truncated };
        }
      }

      if (!nextUrl) break;
      if (pagesFetched >= maxPages) {
        truncated = true;
        break;
      }

      // next_page_url is a fully-qualified GET URL and is exempt from rate
      // limits, but we still throttle gently to be a good citizen.
      await sleep(PAGE_THROTTLE_MS);
      body = await this.requestJson<AppFolioReportResponse | Record<string, unknown>[]>(
        nextUrl,
        {
          method: 'GET',
          headers: {
            Authorization: this.authHeader,
            Accept: 'application/json',
          },
        },
        safeName,
      );
    }

    return { report: safeName, rows, pagesFetched, truncated };
  }

  /**
   * Shared fetch wrapper: bounded timeout, HTTP-status checks before JSON
   * parsing, one automatic retry on 429 honoring Retry-After. Error messages
   * include a snippet of the response body (AppFolio returns useful JSON
   * errors) but never the credentials.
   */
  private async requestJson<T>(url: string, init: RequestInit, reportName: string): Promise<T> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await fetch(url, {
        ...init,
        signal: AbortSignal.timeout(API_TIMEOUT_MS),
      });

      if (response.status === 429 && attempt === 0) {
        const retryAfter = Number(response.headers.get('retry-after')) || 15;
        await sleep(retryAfter * 1000);
        continue;
      }

      if (!response.ok) {
        let detail = '';
        try {
          detail = (await response.text()).slice(0, 300);
        } catch {
          /* ignore — body already consumed or unreadable */
        }
        if (response.status === 401 || response.status === 403) {
          throw new Error(
            `AppFolio report "${reportName}" auth failed (HTTP ${response.status}). ` +
              `Check APPFOLIO_CLIENT_ID / APPFOLIO_CLIENT_SECRET and that the ` +
              `Reports API is enabled for this database.${detail ? ` — ${detail}` : ''}`,
          );
        }
        if (response.status === 404) {
          throw new Error(
            `AppFolio report "${reportName}" not found (HTTP 404). ` +
              `The report path name may differ for your account.${detail ? ` — ${detail}` : ''}`,
          );
        }
        if (response.status === 429) {
          throw new Error(`AppFolio report "${reportName}" rate limited (HTTP 429) after retry`);
        }
        throw new Error(
          `AppFolio report "${reportName}" failed: HTTP ${response.status}${detail ? ` — ${detail}` : ''}`,
        );
      }

      return (await response.json()) as T;
    }
    // Unreachable: the loop either returns or throws.
    throw new Error(`AppFolio report "${reportName}" failed after retry`);
  }
}
