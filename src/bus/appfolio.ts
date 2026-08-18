/**
 * Bus logic for the read-only AppFolio data connector.
 *
 * Loads the AppFolio Reports API credentials (Client ID / Secret / base URL)
 * and fetches a report by name. Credentials come from the process environment
 * when present (agents run with orgs/<org>/secrets.env already sourced into
 * their PTY env), falling back to reading orgs/<org>/secrets.env directly so
 * the same command works when invoked from a plain CLI shell.
 */
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { AppFolioAPI, type FetchReportResult } from '../appfolio/api.js';

export interface AppFolioCreds {
  clientId: string;
  clientSecret: string;
  baseUrl: string;
}

/**
 * Parse a .env-style file into a flat key→value map, stripping comments and
 * surrounding quotes — same shape as the loader used by knowledge-base.ts.
 */
function parseEnvFile(path: string): Record<string, string> {
  const vars: Record<string, string> = {};
  if (!existsSync(path)) return vars;
  for (const line of readFileSync(path, 'utf-8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx <= 0) continue;
    let val = trimmed.slice(idx + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    vars[trimmed.slice(0, idx).trim()] = val;
  }
  return vars;
}

/**
 * Resolve AppFolio creds: prefer process.env (agent context), then
 * orgs/<org>/secrets.env (CLI context). Throws a clear, actionable error if
 * anything is missing — and never echoes secret values.
 */
export function loadAppfolioCreds(frameworkRoot: string, org: string): AppFolioCreds {
  const fileVars = parseEnvFile(join(frameworkRoot, 'orgs', org, 'secrets.env'));
  const pick = (key: string): string =>
    (process.env[key] && process.env[key]!.trim()) || fileVars[key] || '';

  const clientId = pick('APPFOLIO_CLIENT_ID');
  const clientSecret = pick('APPFOLIO_CLIENT_SECRET');
  const baseUrl = pick('APPFOLIO_API_BASE_URL');

  const missing: string[] = [];
  if (!clientId) missing.push('APPFOLIO_CLIENT_ID');
  if (!clientSecret) missing.push('APPFOLIO_CLIENT_SECRET');
  if (!baseUrl) missing.push('APPFOLIO_API_BASE_URL');
  if (missing.length > 0) {
    throw new Error(
      `AppFolio not configured: missing ${missing.join(', ')}. ` +
        `Add them to orgs/${org}/secrets.env (Reports API → Client ID/Secret; ` +
        `base URL is your AppFolio web address, e.g. https://yourco.appfolio.com).`,
    );
  }
  return { clientId, clientSecret, baseUrl };
}

export interface FetchAppfolioReportResult extends FetchReportResult {
  ok: true;
  rowCount: number;
}

/**
 * Fetch one AppFolio report by name with optional filter params.
 * Read-only — see AppFolioAPI for why no write path exists.
 */
export async function fetchAppfolioReport(
  frameworkRoot: string,
  org: string,
  reportName: string,
  params: Record<string, unknown> = {},
  opts: { maxPages?: number; maxRows?: number } = {},
): Promise<FetchAppfolioReportResult> {
  const { clientId, clientSecret, baseUrl } = loadAppfolioCreds(frameworkRoot, org);
  const client = new AppFolioAPI(clientId, clientSecret, baseUrl);
  const result = await client.fetchReport(reportName, params, opts);
  return { ok: true, ...result, rowCount: result.rows.length };
}
