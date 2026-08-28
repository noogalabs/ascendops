import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import type { BusPaths } from '../types/index.js';
import { normalizeOrgName } from '../utils/org.js';
import { assertNoOwnerPrivatePaths } from './kb-privacy.js';

// NOTE: SSN scrubbing for the knowledge base is enforced at the PERSISTENCE
// POINT inside the mmrag ingest tool (knowledge-base/scripts/mmrag.py), NOT
// here. The ingest passes file PATHS to mmrag, which reads/transcribes each
// file (recursing into directories) and embeds the text. Scrubbing in mmrag
// — on the final text including any Gemini transcription, fail-closed —
// covers directory inputs, preserves the original source path (so the
// shared-collection allowlist, provenance, dedup and delete-by-path all keep
// working), and has no read/scrub TOCTOU. An earlier JS-side temp-file scrub
// here was removed because substituting a temp path broke all of the above.

/**
 * Knowledge base integration — calls mmrag.py directly (cross-platform,
 * no bash dependency).  Previously wrapped kb-*.sh bash scripts.
 */

/**
 * Resolve the Python interpreter inside the knowledge-base venv,
 * accounting for Windows vs Unix layout.
 */
function getVenvPython(frameworkRoot: string): string {
  const isWin = process.platform === 'win32';
  const venvBin = isWin ? 'Scripts' : 'bin';
  const pythonExe = isWin ? 'python.exe' : 'python3';
  return join(frameworkRoot, 'knowledge-base', 'venv', venvBin, pythonExe);
}

/**
 * Load .env and secrets.env files the same way the bash scripts did
 * (`set -o allexport && source …`).  Returns a flat key→value map.
 */
function loadSecretsEnv(frameworkRoot: string, org: string): Record<string, string> {
  const secretsPath = join(frameworkRoot, 'orgs', org, 'secrets.env');
  const dotenvPath = join(frameworkRoot, '.env');
  const vars: Record<string, string> = {};
  for (const p of [dotenvPath, secretsPath]) {
    if (existsSync(p)) {
      for (const line of readFileSync(p, 'utf-8').split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const idx = trimmed.indexOf('=');
        if (idx > 0) {
          let val = trimmed.slice(idx + 1);
          // Strip surrounding quotes (single or double) that some .env files use
          if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
            val = val.slice(1, -1);
          }
          vars[trimmed.slice(0, idx)] = val;
        }
      }
    }
  }
  return vars;
}

/**
 * Check whether the knowledge base config file exists for a given env.
 *
 * The Python MMRAG tool loads its config from env.MMRAG_CONFIG
 * (`knowledge-base/config.json` under the org's state dir) and exits with
 * "Config not found. Run setup first" if the file is absent. When that
 * happens, execFileSync throws a non-zero-exit error which — if not caught
 * — produces a user-facing unhandled-throw stack dump on top of the
 * already-printed Python error. This helper lets callers detect the
 * missing-config state UP FRONT and respond gracefully (warn + return)
 * instead of relying on brittle stderr string matching after the throw.
 */
function kbConfigured(env: Record<string, string>): boolean {
  return existsSync(env.MMRAG_CONFIG);
}

/**
 * Build the full env object needed by mmrag.py calls.
 */
function buildKBEnv(
  frameworkRoot: string,
  org: string,
  instanceId: string,
  agent?: string,
): Record<string, string> {
  // Normalize org to its canonical filesystem casing BEFORE touching any
  // paths. Without this, a lowercase --org arg produces a ghost state dir
  // (~/.cortextos/<instance>/orgs/<lowercase>/knowledge-base/) with its own
  // MMRAG config.json, splitting KB state across two directories and
  // polluting dashboard sync with hits against a non-existent org.
  const canonicalOrg = normalizeOrgName(frameworkRoot, org);
  const kbRoot = join(homedir(), '.cortextos', instanceId, 'orgs', canonicalOrg, 'knowledge-base');
  const secrets = loadSecretsEnv(frameworkRoot, canonicalOrg);
  return {
    ...process.env as Record<string, string>,
    ...secrets,
    CTX_ORG: canonicalOrg,
    CTX_AGENT_NAME: agent || '',
    CTX_INSTANCE_ID: instanceId,
    CTX_FRAMEWORK_ROOT: frameworkRoot,
    MMRAG_DIR: kbRoot,
    MMRAG_CHROMADB_DIR: join(kbRoot, 'chromadb'),
    MMRAG_CONFIG: join(kbRoot, 'config.json'),
  };
}

export interface KBQueryResult {
  content: string;
  source_file: string;
  agent_name?: string;
  org: string;
  score: number;
  doc_type: string;
}

export interface KBQueryResponse {
  results: KBQueryResult[];
  total: number;
  query: string;
  collection: string;
}

/**
 * Query the knowledge base.
 * Returns parsed JSON results when --json is used internally.
 */
/**
 * Private KB is caller-scoped (mirror of the ingest anti-spoof in kb-privacy.ts).
 * A private `agent-<X>` collection may be queried ONLY by its owning agent runtime:
 * the effective agent is the RUNTIME identity (`CTX_AGENT_NAME`, `runtimeAgent`), and
 * an explicit `--agent` (`requestedAgent`) naming a DIFFERENT agent is refused — that
 * would read another agent's private store, a privacy-wall violation by definition
 * (departments report UP via events, never read DOWN into a private KB). Without a
 * runtime identity, `--scope private` has no own-collection to address; `--scope all`
 * simply addresses no `agent-<X>` (shared-only). `--scope shared` is unaffected.
 *
 * Trust model matches the ingest guard: self-hosted TRUSTED fleet; this closes the
 * realistic flag-override / cross-agent-read hole (`--agent <other>`), not an OS-level
 * env spoof (a process that can set CTX_AGENT_NAME can also read the Chroma files
 * directly — the same fs-trust boundary).
 */
export function assertQueryIdentity(
  scope: 'shared' | 'private' | 'all',
  runtimeAgent: string | undefined,
  requestedAgent: string | undefined,
): void {
  if (scope === 'shared') return; // no agent-<X> collection is addressed
  if (requestedAgent && requestedAgent !== runtimeAgent) {
    throw new Error(
      `[kb] BLOCKED: private KB is caller-scoped. --agent "${requestedAgent}" does not match ` +
        `the runtime identity "${runtimeAgent ?? '(none)'}". An agent may query only its OWN ` +
        `private collection (agent-<self>); a cross-agent private read is a privacy-wall ` +
        `violation. See your org internal docs.`,
    );
  }
  if (scope === 'private' && !runtimeAgent) {
    throw new Error(
      `[kb] BLOCKED: --scope private needs a runtime agent identity (CTX_AGENT_NAME) to address ` +
        `your own private collection; none resolved. Use --scope shared, or run within an agent runtime.`,
    );
  }
  // scope 'all' with no runtime identity addresses no agent-<X> (shared-only) — safe.
}

export function queryKnowledgeBase(
  paths: BusPaths,
  question: string,
  options: {
    org: string;
    /** The RUNTIME identity (CTX_AGENT_NAME) — the ONLY agent whose private collection this call may address. */
    agent?: string;
    /** An explicit `--agent` flag, if any. Must equal `agent` (the runtime identity) or the call is refused. */
    requestedAgent?: string;
    scope?: 'shared' | 'private' | 'all';
    topK?: number;
    threshold?: number;
    frameworkRoot: string;
    instanceId: string;
  },
): KBQueryResponse {
  const { agent, requestedAgent, scope = 'all', topK = 5, threshold = 0.5, frameworkRoot, instanceId } =
    options;

  // Caller-scoped private KB: refuse a mismatched --agent (or private with no runtime
  // identity) BEFORE any collection is chosen or mmrag is spawned. Mirrors the ingest
  // anti-spoof so ingest + query enforce ONE policy: an agent touches only agent-<self>.
  assertQueryIdentity(scope, agent, requestedAgent);
  // Normalize once at the top so every downstream path join, env var, and
  // ChromaDB collection name uses the canonical filesystem casing. Without
  // this, `shared-acmecorp` and `shared-AcmeCorp` become two
  // distinct ChromaDB collections and a case-drifted query silently hits
  // the wrong one.
  const org = normalizeOrgName(frameworkRoot, options.org);

  const env = buildKBEnv(frameworkRoot, org, instanceId, agent);

  // UX safety net: if the KB is not configured for this org (no config.json
  // on disk yet), skip the python probe entirely and return empty results
  // with a visible warning. Previously the inner runQuery() try/catch would
  // swallow the Config-not-found error silently and the operator would see
  // "0 results" with no hint about WHY — indistinguishable from a legitimate
  // empty query against a configured KB. The warn-and-empty shape makes the
  // distinction obvious and actionable.
  if (!kbConfigured(env)) {
    console.warn(
      `[kb] Knowledge base not configured for org ${org}. Returning empty results — run setup to enable.`,
    );
    return { results: [], total: 0, query: question, collection: `shared-${org}` };
  }

  const pythonPath = getVenvPython(frameworkRoot);
  const mmragPath = join(frameworkRoot, 'knowledge-base', 'scripts', 'mmrag.py');

  // Determine which collections to query based on scope
  const collections: string[] = [];
  switch (scope) {
    case 'shared':
      collections.push(`shared-${org}`);
      break;
    case 'private':
      collections.push(agent ? `agent-${agent}` : `shared-${org}`);
      break;
    case 'all':
      collections.push(`shared-${org}`);
      if (agent) collections.push(`agent-${agent}`);
      break;
  }

  const runQuery = (col: string): string | null => {
    try {
      return execFileSync(pythonPath, [
        mmragPath, 'query', question,
        '--collection', col,
        '--top-k', String(topK),
        '--threshold', String(threshold),
        '--json',
      ], {
        encoding: 'utf-8',
        timeout: 30000,
        env,
      });
    } catch {
      return null;
    }
  };

  const parseOutput = (output: string | null): KBQueryResult[] => {
    if (!output) return [];
    // mmrag.py --json outputs pretty-printed JSON; find and parse the JSON block
    const trimmed = output.trim();
    const jsonStart = trimmed.indexOf('{');
    if (jsonStart === -1) return [];
    try {
      const raw = JSON.parse(trimmed.slice(jsonStart)) as {
        results?: Array<{ content?: string; result?: string; similarity?: number; source?: string; type?: string }>;
        result_count?: number;
        query?: string;
        collection?: string;
      };
      return (raw.results || []).map((r) => ({
        content: r.content || r.result || '',
        source_file: r.source || '',
        org,
        agent_name: agent,
        score: r.similarity ?? 0,
        doc_type: r.type || 'markdown',
      }));
    } catch {
      return [];
    }
  };

  try {
    let allResults: KBQueryResult[] = [];
    let lastCollection = `shared-${org}`;
    for (const col of collections) {
      const output = runQuery(col);
      allResults = allResults.concat(parseOutput(output));
      lastCollection = col;
    }

    // Merge across collections by RELEVANCE, not by collection order.
    //
    // Each collection is queried separately with its own --top-k, so results arrive
    // as one descending run PER collection. Concatenating them (above) preserves
    // collection order, not score order, which means a hit from a later collection
    // ranks below every hit from an earlier one no matter how much better it scores.
    // Observed before this fix: a 0.778 agent-collection match returned at rank 6,
    // beneath five shared-collection hits scoring 0.668–0.699. Retrieval was correct;
    // the merge discarded it. Callers that read "the top result" got the wrong answer
    // systematically — for scope:'all' the shared collection always won on position.
    //
    // The slice is part of the same defect: --top-k is applied PER collection, so
    // scope:'all' returned topK * collections.length rows and the true global top-K
    // was never computed. Sort first, then honour the caller's topK.
    allResults.sort((a, b) => b.score - a.score);
    if (allResults.length > topK) allResults = allResults.slice(0, topK);

    if (allResults.length > 0) {
      return {
        results: allResults,
        total: allResults.length,
        query: question,
        collection: collections.length === 1 ? lastCollection : `shared-${org}`,
      };
    }
  } catch {
    // Failed — return empty
  }

  return { results: [], total: 0, query: question, collection: `shared-${org}` };
}

/**
 * Ingest files into the knowledge base.
 */
export function ingestKnowledgeBase(
  paths: string[],
  options: {
    org: string;
    agent?: string;
    scope?: 'shared' | 'private';
    force?: boolean;
    frameworkRoot: string;
    instanceId: string;
  },
): void {
  const { agent, scope = 'shared', force, frameworkRoot, instanceId } = options;

  // EA privacy wall (W1-C): owner-private content must never enter ANY KB
  // collection, shared OR private. Enforced here at the single Node entry point
  // every `bus kb-ingest` flows through, BEFORE a collection is chosen or mmrag is
  // spawned, so even a bare shared-default ingest of owner-private material is
  // refused. Symlink-resolved + directory-recursive (see kb-privacy.ts). Narrowed
  // (Fable ruling): an agent ingesting its OWN memory into its OWN private scope is
  // allowed (the heartbeat); state/ea + crm stay blocked under every scope.
  assertNoOwnerPrivatePaths(paths, { scope, agent });

  // Normalize once (see queryKnowledgeBase for rationale).
  const org = normalizeOrgName(frameworkRoot, options.org);

  const env = buildKBEnv(frameworkRoot, org, instanceId, agent);

  // Correctness fix: if the KB is not configured for this org, the underlying
  // python MMRAG tool exits with "Config not found. Run setup first" and
  // execFileSync (below, stdio: inherit) throws a non-zero-exit error. That
  // throw used to bubble up through the CLI action handler as an unhandled
  // exception, dumping a full Node stack trace on top of the python error
  // message — ugly and alarming for operators who were just running ingest
  // without setting up the KB first. Detect the missing-config state
  // up-front and warn-and-skip instead of letting execFileSync crash.
  if (!kbConfigured(env)) {
    console.warn(
      `[kb] Knowledge base not configured for org ${org}. Skipping ingest — ` +
      `run setup to enable (see HEARTBEAT.md step 10 for the config path).`,
    );
    return;
  }

  const pythonPath = getVenvPython(frameworkRoot);
  const mmragPath = join(frameworkRoot, 'knowledge-base', 'scripts', 'mmrag.py');

  // Determine collection name (same logic as kb-ingest.sh)
  let collection: string;
  if (scope === 'private') {
    if (!agent) throw new Error('--agent or CTX_AGENT_NAME required for --scope private');
    collection = `agent-${agent}`;
  } else {
    collection = `shared-${org}`;
  }

  // Ensure chromadb dir exists
  const kbRoot = join(homedir(), '.cortextos', instanceId, 'orgs', org, 'knowledge-base');
  const chromaDir = join(kbRoot, 'chromadb');
  if (!existsSync(chromaDir)) {
    mkdirSync(chromaDir, { recursive: true });
  }

  console.log(`Ingesting into collection: ${collection}`);
  for (const p of paths) {
    console.log(`  Source: ${p}`);
  }

  const args = [mmragPath, 'ingest', ...paths, '--collection', collection];
  if (force) args.push('--force');

  // Multimodal PDF ingestion via Gemini Flash routinely takes 2–5 min for
  // documents over ~10 pages with images/tables. Two minutes was too low and
  // produced ETIMEDOUT mid-Gemini-call. Default 10 min, override via env,
  // floored at 60s so nobody accidentally sets it to 0 or a value smaller
  // than a single Gemini call needs.
  const KB_INGEST_TIMEOUT_FLOOR_MS = 60_000;
  const KB_INGEST_TIMEOUT_DEFAULT_MS = 600_000;
  const requestedTimeout = Number(process.env.KB_INGEST_TIMEOUT_MS);
  const ingestTimeoutMs = Math.max(
    KB_INGEST_TIMEOUT_FLOOR_MS,
    Number.isFinite(requestedTimeout) && requestedTimeout > 0
      ? requestedTimeout
      : KB_INGEST_TIMEOUT_DEFAULT_MS,
  );

  execFileSync(pythonPath, args, {
    encoding: 'utf-8',
    timeout: ingestTimeoutMs,
    env,
    stdio: 'inherit',
  });

  console.log(`\nIngest complete → collection: ${collection}`);
}

/**
 * Ensure the knowledge base directories exist for an org.
 *
 * `frameworkRoot` is required so the org name can be normalized to its
 * canonical filesystem casing — without that, a caller passing a drifted
 * name (e.g. "acmecorp") would create a ghost state dir identical
 * to the one this module was written to prevent.
 */
export function ensureKBDirs(instanceId: string, frameworkRoot: string, org: string): void {
  const canonicalOrg = normalizeOrgName(frameworkRoot, org);
  const kbRoot = join(homedir(), '.cortextos', instanceId, 'orgs', canonicalOrg, 'knowledge-base');
  const chromaDir = join(kbRoot, 'chromadb');
  if (!existsSync(chromaDir)) {
    mkdirSync(chromaDir, { recursive: true });
  }
}
