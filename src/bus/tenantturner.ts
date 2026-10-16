/**
 * Bus logic for the read-only Tenant Turner data connector.
 *
 * Loads the Tenant Turner private API key and fetches a list resource by name.
 * Like the AppFolio and Hostaway connectors, the credential comes from
 * process.env when present (agent PTY context), falling back to reading
 * orgs/<org>/secrets.env directly so the same command works from a plain CLI.
 *
 * This path is READ-ONLY: it only calls TenantTurnerAPI.fetchResource, which
 * only issues HTTP GET. There is no write path here by design.
 */
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { TenantTurnerAPI, type FetchResourceResult } from '../tenantturner/api.js';

export interface TenantTurnerCreds {
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
 * Resolve the Tenant Turner API key: prefer process.env (agent context), then
 * orgs/<org>/secrets.env (CLI context). Throws an actionable error if missing,
 * and never echoes the secret value.
 */
export function loadTenantTurnerCreds(frameworkRoot: string, org: string): TenantTurnerCreds {
  const fileVars = parseEnvFile(join(frameworkRoot, 'orgs', org, 'secrets.env'));
  const pick = (key: string): string =>
    (process.env[key] && process.env[key]!.trim()) || fileVars[key] || '';

  const apiKey = pick('TENANTTURNER_API_KEY');
  if (!apiKey) {
    throw new Error(
      `Tenant Turner not configured: missing TENANTTURNER_API_KEY. ` +
        `Add it to orgs/${org}/secrets.env (Tenant Turner → Settings → Tenant Turner API → Refresh API Key).`,
    );
  }
  return { apiKey };
}

export interface FetchTenantTurnerResourceResult extends FetchResourceResult {
  ok: true;
  rowCount: number;
}

/**
 * Fetch one read-only Tenant Turner resource (e.g. applications, properties)
 * with an optional SinceDateUpdated filter and extra query params. Read-only —
 * see TenantTurnerAPI for why no write path exists.
 */
export async function fetchTenantTurnerResource(
  frameworkRoot: string,
  org: string,
  resource: string,
  opts: {
    sinceDateUpdated?: string;
    query?: Record<string, string | number>;
    maxPages?: number;
    maxRows?: number;
  } = {},
): Promise<FetchTenantTurnerResourceResult> {
  const { apiKey } = loadTenantTurnerCreds(frameworkRoot, org);
  const client = new TenantTurnerAPI(apiKey);
  const result = await client.fetchResource(resource, opts);
  return { ok: true, ...result, rowCount: result.rows.length };
}
