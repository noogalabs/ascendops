/**
 * Bus logic for the read-only Hostaway data connector.
 *
 * Loads the Hostaway Public API credentials (Account ID / API Key) and fetches
 * a list resource by name. Like the AppFolio connector, credentials come from
 * process.env when present (agent PTY context), falling back to reading
 * orgs/<org>/secrets.env directly so the same command works from a plain CLI.
 *
 * This path is READ-ONLY: it only calls HostawayAPI.fetchResource, which only
 * issues HTTP GET. There is no write path here by design.
 */
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { HostawayAPI, type FetchResourceResult } from '../hostaway/api.js';

export interface HostawayCreds {
  accountId: string;
  apiKey: string;
}

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
 * Resolve Hostaway creds: prefer process.env (agent context), then
 * orgs/<org>/secrets.env (CLI context). Throws an actionable error if missing,
 * and never echoes secret values.
 */
export function loadHostawayCreds(frameworkRoot: string, org: string): HostawayCreds {
  const fileVars = parseEnvFile(join(frameworkRoot, 'orgs', org, 'secrets.env'));
  const pick = (key: string): string =>
    (process.env[key] && process.env[key]!.trim()) || fileVars[key] || '';

  const accountId = pick('HOSTAWAY_ACCOUNT_ID');
  const apiKey = pick('HOSTAWAY_API_KEY');

  const missing: string[] = [];
  if (!accountId) missing.push('HOSTAWAY_ACCOUNT_ID');
  if (!apiKey) missing.push('HOSTAWAY_API_KEY');
  if (missing.length > 0) {
    throw new Error(
      `Hostaway not configured: missing ${missing.join(', ')}. ` +
        `Add them to orgs/${org}/secrets.env (Hostaway dashboard → Settings → Hostaway API → Create).`,
    );
  }
  return { accountId, apiKey };
}

export interface FetchHostawayResourceResult extends FetchResourceResult {
  ok: true;
  rowCount: number;
}

/**
 * Fetch one read-only Hostaway resource (e.g. listings, reservations, calendar)
 * with optional query params. Read-only — see HostawayAPI for why no write
 * path exists.
 */
export async function fetchHostawayResource(
  frameworkRoot: string,
  org: string,
  resource: string,
  opts: { query?: Record<string, string | number>; maxPages?: number; maxRows?: number } = {},
): Promise<FetchHostawayResourceResult> {
  const { accountId, apiKey } = loadHostawayCreds(frameworkRoot, org);
  const client = new HostawayAPI(accountId, apiKey);
  const result = await client.fetchResource(resource, opts);
  return { ok: true, ...result, rowCount: result.rows.length };
}
