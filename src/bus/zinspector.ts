/**
 * Bus logic for the read-only zInspector data connector.
 *
 * Loads the zInspector Encoded API key (+ base URL) and fetches a list resource
 * by name. Like the other connectors, the credential comes from process.env
 * when present (agent PTY context), falling back to reading orgs/<org>/secrets.env
 * directly so the same command works from a plain CLI.
 *
 * This path is READ-ONLY: it only calls ZInspectorAPI.fetchResource, which only
 * issues HTTP GET. There is no write path here by design.
 */
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { ZInspectorAPI, type FetchResourceResult } from '../zinspector/api.js';

const DEFAULT_BASE_URL = 'https://portfolio.zinspector.com';

export interface ZInspectorCreds {
  apiKey: string;
  baseUrl: string;
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
 * Resolve the zInspector credential: prefer process.env (agent context), then
 * orgs/<org>/secrets.env (CLI context). The base URL defaults to the standard
 * portfolio host when unset. Throws an actionable error if the key is missing,
 * and never echoes the secret value.
 */
export function loadZinspectorCreds(frameworkRoot: string, org: string): ZInspectorCreds {
  const fileVars = parseEnvFile(join(frameworkRoot, 'orgs', org, 'secrets.env'));
  const pick = (key: string): string =>
    (process.env[key] && process.env[key]!.trim()) || fileVars[key] || '';

  const apiKey = pick('ZINSPECTOR_API_KEY');
  const baseUrl = pick('ZINSPECTOR_API_BASE_URL') || DEFAULT_BASE_URL;
  if (!apiKey) {
    throw new Error(
      `zInspector not configured: missing ZINSPECTOR_API_KEY. Add the "Encoded API key" to ` +
        `orgs/${org}/secrets.env (zInspector → Configuration → API Keys → create, Linked User = an Admin).`,
    );
  }
  return { apiKey, baseUrl };
}

export interface FetchZinspectorResourceResult extends FetchResourceResult {
  ok: true;
  rowCount: number;
}

/**
 * Fetch one read-only zInspector resource (e.g. propertiesCursor, documents,
 * media, process) with optional query params. Read-only — see ZInspectorAPI for
 * why no write path exists.
 */
export async function fetchZinspectorResource(
  frameworkRoot: string,
  org: string,
  resource: string,
  opts: { query?: Record<string, string | number>; maxPages?: number; maxRows?: number } = {},
): Promise<FetchZinspectorResourceResult> {
  const { apiKey, baseUrl } = loadZinspectorCreds(frameworkRoot, org);
  const client = new ZInspectorAPI(apiKey, baseUrl);
  const result = await client.fetchResource(resource, opts);
  return { ok: true, ...result, rowCount: result.rows.length };
}
