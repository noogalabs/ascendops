// EA privacy wall for KB ingestion (W1-C).
//
// Owner-private content must NEVER enter ANY ChromaDB collection, shared OR
// private. A "private" collection (`agent-<name>`) is deterministic and the
// `kb-query --scope private` flag is UNAUTHENTICATED, so private scope is
// namespace addressing, not access control. Therefore owner-personal data (the
// EA store, CRM, and live agent memory that has carried owner/family PII) is
// filesystem-only and is refused at ingest under every scope.
//
// This mirrors the canonical guard `ea-privacy/kb-ingest-guard.sh` (v3) and the
// `mmrag.py` engine denylist: same resolved-path deny set, symlink-followed, with
// directory recursion so a directory that merely CONTAINS an owner-private file
// (or a symlink to one) is caught. It is enforced in `ingestKnowledgeBase`, the
// single Node entry point every `cortextos bus kb-ingest` call flows through, so
// even a bare shared-default ingest of owner-private material is refused.
//
// Canonical rule: your org internal docs.

import { realpathSync, statSync, readdirSync } from 'node:fs';
import { delimiter } from 'node:path';
import { join, resolve } from 'node:path';

// Optional runtime owner-private vault roots. Operators configure these in the
// environment so the public repo never carries a machine-specific home path.
const VAULT_ROOT_ENV = 'OWNER_PRIVATE_VAULT_DIR';

function ownerPrivateVaultRoots(): string[] {
  const raw = process.env[VAULT_ROOT_ENV];
  if (!raw) return [];
  return raw
    .split(delimiter)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => resolvePath(resolve(p)));
}

// Absolute owner-personal prefixes (resolved path equals the prefix or sits under it).
function denyPrefixes(): string[] {
  return ownerPrivateVaultRoots().flatMap((vault) => [
    join(vault, '00-Core'), // identity / user / schedule / memory
    join(vault, '01-Memory'), // personal daily journal + agent mirrors
    join(vault, '07-Infrastructure', 'migration-backup'), // personal exports
    join(vault, '03-People'), // owner/family profiles
  ]);
}

// `state/ea` and `crm` anywhere (any agent / any worktree) are owner-private.
// Matched as PATH SEGMENTS so "/state/ealous" or "/crmx" never false-trip.
const SEGMENT_DENY = ['/state/ea', '/crm'];

// Live agent-memory trees: agents/<O>/MEMORY.md | memory/ | migrated/. The owning
// agent O is captured so own-memory can enter only its matching own-private scope.
// Matched on the REALPATH-resolved path so a traversal
// (agents/an agent/../an agent/MEMORY.md) is attributed to the true owner (an agent).
const AGENT_MEMORY_RE = /\/agents\/([^/]+)\/(?:MEMORY\.md|memory|migrated)(?:\/|$)/;

type DenyHit =
  | { category: 'always'; rule: string }
  | { category: 'agent-memory'; rule: string; owningAgent: string };

/** Fully symlink-resolved absolute path (matches the engine's Path.resolve()).
 *  Falls back to the raw path when it does not exist yet. */
function resolvePath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

/** True when `resolved` contains `seg` as a path segment (…/seg/… or ends with …/seg). */
function hasSegment(resolved: string, seg: string): boolean {
  return resolved.includes(`${seg}/`) || resolved.endsWith(seg);
}

/** The matched deny hit for a resolved path, or null. */
function matchDeny(resolved: string): DenyHit | null {
  for (const d of denyPrefixes()) {
    if (resolved === d || resolved.startsWith(`${d}/`)) return { category: 'always', rule: d };
  }
  for (const seg of SEGMENT_DENY) {
    if (hasSegment(resolved, seg)) return { category: 'always', rule: seg };
  }
  const m = AGENT_MEMORY_RE.exec(resolved);
  if (m) return { category: 'agent-memory', rule: 'agent-memory tree', owningAgent: m[1] };
  return null;
}

/** Throw unless this is own-memory entering the matching own-private scope. */
function assertHitAllowed(
  hitPath: string,
  hit: DenyHit,
  ctx: { scope: 'shared' | 'private'; agent?: string },
): void {
  if (hit.category === 'agent-memory') {
    const ownMemoryOwnPrivate =
      ctx.scope === 'private' && !!ctx.agent && hit.owningAgent === ctx.agent;
    if (ownMemoryOwnPrivate) return;
    throw new Error(
      `[kb] BLOCKED: agent memory is filesystem-only except an agent ingesting ` +
        `its OWN memory into its OWN private scope. "${hitPath}" is agent ` +
        `"${hit.owningAgent}" memory; refused for scope=${ctx.scope}` +
        `${ctx.agent ? `, agent=${ctx.agent}` : ''}. Recall reads memory directly. ` +
        `See your org internal docs.`,
    );
  }
  throw new Error(
    `[kb] BLOCKED: refusing to ingest owner-private content into any KB collection ` +
      `(shared or private): "${hitPath}" matched deny rule "${hit.rule}". Owner-private ` +
      `data (state/ea, crm) is filesystem-only and must never enter ChromaDB. See ` +
      `your org internal docs.`,
  );
}

/** Depth-first walk (symlink-resolved, loop-safe). Checks EVERY owner-private file
 *  reachable from `p` (the path itself, or, when it is a directory, every file it
 *  contains) — throwing on the FIRST one not permitted under `ctx`. Checking every
 *  file (not just the first hit) is load-bearing: an allowed own-memory file must
 *  NOT mask an always-blocked state/ea file sitting in the same directory. */
function walkAndAssert(
  p: string,
  seen: Set<string>,
  ctx: { scope: 'shared' | 'private'; agent?: string },
): void {
  const resolved = resolvePath(p);
  const hit = matchDeny(resolved);
  if (hit) assertHitAllowed(resolved, hit, ctx); // throws if refused; returns if allowed

  if (seen.has(resolved)) return; // symlink-loop guard
  seen.add(resolved);

  let st;
  try {
    st = statSync(resolved); // follows symlinks
  } catch {
    return;
  }
  if (st.isDirectory()) {
    let entries: string[];
    try {
      entries = readdirSync(resolved);
    } catch {
      return;
    }
    for (const e of entries) walkAndAssert(join(resolved, e), seen, ctx);
  }
}

/** True when `p` (resolved) is itself an owner-private path (any category). */
export function isOwnerPrivatePath(p: string): boolean {
  return matchDeny(resolvePath(p)) !== null;
}

/**
 * Refuse owner-private ingests. Call before any collection is chosen.
 *
 * - `state/ea`, `crm`, owner-personal vault: BLOCKED under every scope, no exemption.
 * - agent memory: allowed only when agent A ingests its own memory into private
 *   collection agent-A; shared and cross-agent memory are refused.
 *
 * Trust model: self-hosted TRUSTED fleet; the threat is accidental owner-PII sprawl,
 * not a malicious agent. REALPATH resolution prevents traversal or symlink aliases
 * from escaping owner attribution.
 */
export function assertNoOwnerPrivatePaths(
  paths: string[],
  ctx: { scope: 'shared' | 'private'; agent?: string },
): void {
  for (const p of paths) walkAndAssert(p, new Set<string>(), ctx);
}
