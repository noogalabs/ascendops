import { readdirSync, readFileSync, renameSync, statSync, existsSync, lstatSync, unlinkSync } from 'fs';
import { join, resolve, sep } from 'path';
import { createHmac, timingSafeEqual } from 'crypto';
import type { InboxMessage, Priority, BusPaths } from '../types/index.js';
import { PRIORITY_MAP } from '../types/index.js';
import { atomicWriteSync, ensureDir } from '../utils/atomic.js';
import { acquireLock, releaseLock } from '../utils/lock.js';
import { randomString } from '../utils/random.js';
import { validateAgentName, validatePriority, validateMessageText } from '../utils/validate.js';
import { redactSSN } from '../utils/ssn-redaction.js';
// added 2026-04-29 via internal dispatch — RFC #15 Wave 1 events implementation
import { logEvent } from './event.js';

// ---------------------------------------------------------------------------
// Security (H10): HMAC-SHA256 message signing
// ---------------------------------------------------------------------------

/**
 * Load the shared bus signing key from config.
 * Returns null if the key file doesn't exist (legacy installs without signing).
 */
function loadSigningKey(ctxRoot: string): string | null {
  const keyPath = join(ctxRoot, 'config', 'bus-signing-key');
  if (!existsSync(keyPath)) return null;
  try {
    return readFileSync(keyPath, 'utf-8').trim();
  } catch {
    return null;
  }
}

function hmacSign(key: string, payload: string): string {
  return createHmac('sha256', key).update(payload).digest('hex');
}

function hmacVerify(key: string, payload: string, sig: string): boolean {
  const expected = hmacSign(key, payload);
  try {
    return timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(sig, 'hex'));
  } catch {
    return false;
  }
}

function signPayload(msgId: string, from: string, to: string, text: string): string {
  return `${msgId}:${from}:${to}:${text}`;
}

/**
 * Send a message to another agent's inbox.
 * Creates a JSON file with format: {pnum}-{epochMs}-from-{sender}-{rand5}.json
 * Identical to bash send-message.sh output.
 */
export function sendMessage(
  paths: BusPaths,
  from: string,
  to: string,
  priority: Priority,
  text: string,
  replyTo?: string,
): string {
  validateAgentName(from);
  validateAgentName(to);
  validatePriority(priority);
  // Fail LOUD at the sender, BEFORE any side effect — before the inbox write, before
  // signing, before the arrival event. An empty body that gets past here is delivered and
  // ACKed silently, so the sender never learns the content was lost. Validated at the
  // primitive rather than per-call-site for the same reason as the SSN scrub below: every
  // inbox writer flows through this chokepoint, and per-call-site checks leave bypasses.
  validateMessageText(text);

  // Layer-2 backstop at the PRIMITIVE: never STORE/SHARE an SSN in an inbox
  // message, regardless of caller. Every inbox writer flows through here
  // (CLI send-message, create-task auto-notify, notifyAgent, future callers),
  // so scrubbing once at this chokepoint covers them all — per-call-site
  // scrubbing left bypasses (create-task title/desc, urgent signals).
  text = redactSSN(text);

  const pnum = PRIORITY_MAP[priority];
  const epochMs = Date.now();
  const rand = randomString(5);
  const msgId = `${epochMs}-${from}-${rand}`;
  const filename = `${pnum}-${epochMs}-from-${from}-${rand}.json`;

  // Security (H10): Sign message with HMAC-SHA256.
  const signingKey = loadSigningKey(paths.ctxRoot);
  const message: InboxMessage = {
    id: msgId,
    from,
    to,
    priority,
    timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, '.000Z'),
    text,
    reply_to: replyTo || null,
    ...(signingKey ? { sig: hmacSign(signingKey, signPayload(msgId, from, to, text)) } : {}),
  };

  // Write to target agent's inbox
  const inboxDir = join(paths.ctxRoot, 'inbox', to);
  ensureDir(inboxDir);
  atomicWriteSync(join(inboxDir, filename), JSON.stringify(message));

  // added 2026-04-29 via internal dispatch — RFC #15 Wave 1 events implementation
  // Emit inbox_arrival event so hooks can subscribe to cross-agent message routing.
  // Best-effort: never throw out of the canonical send path.
  try {
    const bodyPreview = text.length > 120 ? text.slice(0, 120) + '…' : text;
    logEvent(paths, to, _orgFromPaths(paths), 'action', 'inbox_arrival', 'info', {
      to_agent: to,
      from_agent: from,
      msg_id: msgId,
      priority,
      has_reply_to: Boolean(replyTo),
      body_preview: bodyPreview,
    });
  } catch { /* non-fatal */ }

  return msgId;
}

// Added 2026-04-29 via internal dispatch — RFC #15 Wave 1 events implementation.
// Fixed 2026-08-03: the original walked for `<root>/analytics/<org>`, a shape
// getBusPaths has never produced. buildBusPaths (utils/paths.ts:46) sets
//   analyticsDir = join(ctxRoot, 'orgs', <org>, 'analytics')   when an org is scoped
//   analyticsDir = join(ctxRoot, 'analytics')                  when it is not
// so 'analytics' is ALWAYS the final segment and the org sits BEFORE it, not after. The
// old guard `idx + 1 < parts.length` was therefore never true on any real path: the
// branch had never executed once in production. The helper silently degraded to CTX_ORG,
// and to '' wherever that env var was absent — which is how single-org events landed
// under two different roots. Positional, not off-by-one: reading parts[idx + 1] could
// not have worked from either direction.
//
// Separator-agnostic split. `join()` emits '\' on win32 and '/' elsewhere, and this
// parsing must not depend on the platform it happens to run on — a win32-shaped path
// has to be readable on any host, otherwise the only place the behaviour can be
// checked is the platform where it is hardest to check it.
function _splitPathSegments(p: string): string[] {
  return p.split(/[\\/]+/).filter(Boolean);
}
// Falls back to env CTX_ORG, then '' as last resort. logEvent treats '' as a no-op org tag.
function _orgFromPaths(paths: BusPaths): string {
  try {
    const root = _splitPathSegments(paths.ctxRoot);
    const full = _splitPathSegments(paths.analyticsDir);

    // ANCHOR at the authoritative ctxRoot. A suffix heuristic is not enough: a ctxRoot
    // that itself ends in `orgs/<something>` makes an UNSCOPED analyticsDir
    // (<ctxRoot>/analytics) look org-scoped, and the helper would hand back the last
    // segment of the ROOT as if it were an org.
    if (full.length <= root.length) return process.env.CTX_ORG ?? '';
    for (let i = 0; i < root.length; i++) {
      if (full[i] !== root[i]) return process.env.CTX_ORG ?? '';
    }

    // buildBusPaths (utils/paths.ts:46) produces exactly two shapes below ctxRoot, and
    // only one of them carries an org. Accept those two and nothing else:
    //   ['analytics']                 unscoped   -> no org, fall through to CTX_ORG
    //   ['orgs', <org>, 'analytics']  org-scoped -> the org
    const rest = full.slice(root.length);
    if (rest.length === 3 && rest[0] === 'orgs' && rest[2] === 'analytics' && rest[1]) {
      return rest[1];
    }
  } catch { /* ignore */ }
  return process.env.CTX_ORG ?? '';
}

// Test seam. `_orgFromPaths` is pure and its win32 behaviour must be checkable from a
// posix host — routing that check through sendMessage would mean creating 'C:\...'
// directories on the test machine. Exported for tests only; production callers use
// sendMessage.
export const orgFromPathsForTest = _orgFromPaths;

/**
 * Distinguishes an unreadable inbox from a successfully-read empty inbox.
 * Production callers must surface this state and retry; they must never emit
 * the successful empty representation (`[]`).
 */
export class InboxLockUnavailableError extends Error {
  readonly code = 'INBOX_LOCK_UNAVAILABLE';

  constructor(readonly inbox: string) {
    super(`Inbox lock unavailable: ${inbox}`);
    this.name = 'InboxLockUnavailableError';
  }
}

/**
 * Check inbox for pending messages.
 * Reads inbox directory, moves messages to inflight, returns sorted array.
 * Recovers stale inflight messages (>5 minutes old).
 * Identical to bash check-inbox.sh behavior.
 */
export function checkInbox(paths: BusPaths): InboxMessage[] {
  const { inbox, inflight } = paths;
  ensureDir(inbox);
  ensureDir(inflight);

  // Acquire lock
  const lockHandle = acquireLock(inbox);
  if (!lockHandle) {
    throw new InboxLockUnavailableError(inbox);
  }

  try {
    // Recover stale inflight messages (>5 min old)
    recoverStaleInflight(inflight, inbox, 300);

    // Read and sort messages by filename (priority then timestamp)
    const files = readdirSync(inbox)
      .filter(f => f.endsWith('.json') && !f.startsWith('.'))
      .sort();

    if (files.length === 0) {
      return [];
    }

    // Security (H10): Load signing key for HMAC verification.
    const signingKey = loadSigningKey(paths.ctxRoot);

    const messages: InboxMessage[] = [];
    for (const file of files) {
      const srcPath = join(inbox, file);
      try {
        const content = readFileSync(srcPath, 'utf-8');
        const msg: InboxMessage = JSON.parse(content);

        // Security (H10): Verify HMAC signature if key is available and message has sig.
        if (signingKey && msg.sig) {
          const valid = hmacVerify(signingKey, signPayload(msg.id, msg.from, msg.to, msg.text), msg.sig);
          if (!valid) {
            console.error(`[bus/message] SECURITY: Message ${msg.id} from '${msg.from}' failed HMAC verification — rejecting`);
            const errDir = join(inbox, '.errors');
            ensureDir(errDir);
            try { renameSync(srcPath, join(errDir, file)); } catch { /* ignore */ }
            continue;
          }
        } else if (signingKey && !msg.sig) {
          // Signing key exists but message has no sig — legacy message, log warning
          console.warn(`[bus/message] WARNING: Unsigned message ${msg.id} from '${msg.from}' — accepted (legacy)`);
        }

        // Move to inflight
        const destPath = join(inflight, file);
        renameSync(srcPath, destPath);
        messages.push(msg);
      } catch {
        // Move corrupt files to .errors/
        const errDir = join(inbox, '.errors');
        ensureDir(errDir);
        try {
          renameSync(srcPath, join(errDir, file));
        } catch {
          // Ignore if move fails
        }
      }
    }

    return messages;
  } finally {
    releaseLock(lockHandle);
  }
}

/**
 * Acknowledge a message by moving it from inflight to processed.
 * Identical to bash ack-inbox.sh behavior.
 */
export function ackInbox(paths: BusPaths, messageId: string): void {
  const { inflight, processed } = paths;
  ensureDir(processed);

  // Find the file in inflight that contains this message ID
  let files: string[];
  try {
    files = readdirSync(inflight).filter(f => f.endsWith('.json'));
  } catch {
    return;
  }

  for (const file of files) {
    const filePath = join(inflight, file);
    try {
      const content = readFileSync(filePath, 'utf-8');
      const msg = JSON.parse(content);
      if (msg.id === messageId) {
        renameSync(filePath, join(processed, file));
        return;
      }
    } catch {
      // Skip corrupt files
    }
  }
}

// ---------------------------------------------------------------------------
// F12 disk-leak fix: TTL sweep of processed/ messages
// ---------------------------------------------------------------------------

/** Default retention (days) for acked messages in processed/ (F12). */
export const PROCESSED_TTL_DAYS = 30;

/** Hard floor: pruneProcessed refuses any TTL below this many days. */
export const PROCESSED_TTL_MIN_DAYS = 1;

export interface PruneProcessedResult {
  /** Number of candidate .json files examined. */
  scanned: number;
  /** Number of files deleted (older than the TTL). */
  deleted: number;
  /** Files skipped because their mtime is within the TTL. */
  keptRecent: number;
  /** Files that failed to stat/delete (left in place). */
  errors: number;
}

/**
 * Delete acked messages in processed/ that are older than `ttlDays`.
 *
 * ackInbox renames messages into processed/{agent}/ forever and nothing in
 * src/ ever cleans them up (observed in prod: 18k+ files / 72 MB). This sweep
 * is exposed as `cortextos bus prune-processed`.
 *
 * Path safety:
 * - Only sweeps directories under {ctxRoot}/processed/ — any target dir that
 *   resolves outside that root is rejected (throws).
 * - Only deletes regular files (never directories or symlinks) whose name
 *   ends in `.json`, taken from readdirSync (so names cannot contain `/`).
 * - Each unlink target is re-checked to resolve inside its sweep dir.
 * - Recent files are never deleted: ttlDays is clamped-by-rejection to a
 *   minimum of PROCESSED_TTL_MIN_DAYS (1 day) and mtime must be strictly
 *   older than the cutoff.
 *
 * @param paths   Bus paths for the calling agent.
 * @param ttlDays Retention in days (default 30, minimum 1; invalid → throws).
 * @param options allAgents: sweep every agent's processed/ dir under ctxRoot,
 *                not just the calling agent's.
 */
export function pruneProcessed(
  paths: BusPaths,
  ttlDays: number = PROCESSED_TTL_DAYS,
  options: { allAgents?: boolean } = {},
): PruneProcessedResult {
  if (!Number.isFinite(ttlDays) || ttlDays < PROCESSED_TTL_MIN_DAYS) {
    throw new Error(
      `pruneProcessed: ttlDays must be a number >= ${PROCESSED_TTL_MIN_DAYS} (got ${ttlDays})`,
    );
  }

  const processedRoot = resolve(join(paths.ctxRoot, 'processed'));
  const cutoffMs = Date.now() - ttlDays * 24 * 60 * 60 * 1000;
  const result: PruneProcessedResult = { scanned: 0, deleted: 0, keptRecent: 0, errors: 0 };

  const sweepDirs: string[] = [];
  if (options.allAgents) {
    let entries;
    try {
      entries = readdirSync(processedRoot, { withFileTypes: true });
    } catch {
      return result; // no processed/ root yet — nothing to do
    }
    for (const ent of entries) {
      // Only real directories (never symlinks), never dotfiles.
      if (ent.isDirectory() && !ent.name.startsWith('.')) {
        sweepDirs.push(join(processedRoot, ent.name));
      }
    }
  } else {
    sweepDirs.push(paths.processed);
  }

  for (const dir of sweepDirs) {
    sweepProcessedDir(dir, processedRoot, cutoffMs, result);
  }
  return result;
}

/** Sweep one directory. Refuses to operate outside processedRoot. */
function sweepProcessedDir(
  dir: string,
  processedRoot: string,
  cutoffMs: number,
  result: PruneProcessedResult,
): void {
  const resolvedDir = resolve(dir);
  if (resolvedDir !== processedRoot && !resolvedDir.startsWith(processedRoot + sep)) {
    throw new Error(
      `pruneProcessed: refusing to sweep '${dir}' — outside processed root '${processedRoot}'`,
    );
  }

  let entries;
  try {
    entries = readdirSync(resolvedDir, { withFileTypes: true });
  } catch {
    return; // dir missing/unreadable — nothing to do
  }

  for (const ent of entries) {
    // Regular files only (dirents never follow symlinks), .json only, no dotfiles.
    if (!ent.isFile() || !ent.name.endsWith('.json') || ent.name.startsWith('.')) continue;

    const target = join(resolvedDir, ent.name);
    // Defense-in-depth: re-verify the final path stays inside the sweep dir.
    if (!resolve(target).startsWith(resolvedDir + sep)) continue;

    result.scanned++;
    try {
      const st = lstatSync(target);
      if (!st.isFile()) continue; // symlink/raced replacement — never delete
      if (st.mtimeMs < cutoffMs) {
        unlinkSync(target);
        result.deleted++;
      } else {
        result.keptRecent++;
      }
    } catch {
      result.errors++;
    }
  }
}

/**
 * Recover stale inflight messages (older than thresholdSeconds) back to inbox.
 */
function recoverStaleInflight(
  inflightDir: string,
  inboxDir: string,
  thresholdSeconds: number,
): void {
  const now = Math.floor(Date.now() / 1000);
  let files: string[];
  try {
    files = readdirSync(inflightDir).filter(f => f.endsWith('.json'));
  } catch {
    return;
  }

  for (const file of files) {
    const filePath = join(inflightDir, file);
    try {
      const stat = statSync(filePath);
      const mtime = Math.floor(stat.mtimeMs / 1000);
      if (now - mtime > thresholdSeconds) {
        renameSync(filePath, join(inboxDir, file));
      }
    } catch {
      // Ignore stat/move errors
    }
  }
}
