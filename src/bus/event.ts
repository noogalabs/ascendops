import { appendFileSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import type { EventCategory, EventSeverity, BusPaths, Heartbeat } from '../types/index.js';
import { atomicWriteSync, ensureDir } from '../utils/atomic.js';
import { withFileLockSync } from '../utils/lock.js';
import { randomString } from '../utils/random.js';
import { validateEventCategory, validateEventSeverity, isValidJson } from '../utils/validate.js';
import { redactSSN, piiLabelKeyHint } from '../utils/ssn-redaction.js';
import { hasAgentSessionCredential, sessionCredentialNonce } from '../utils/env.js';
import { isSessionNonceLive } from './heartbeat-session-store.js';

/**
 * Recursively scrub PII from every string value in an event metadata object
 * (Layer-2 never-STORE guarantee). Numbers/booleans/null are left untouched —
 * a PII value persisted as a bare JS number is not a realistic shape (leading
 * zeros would be lost) and scrubbing the serialized JSON would risk producing
 * invalid JSON for numeric values.
 *
 * `inheritedKey` carries — bounded to ONE wrapper level — the promoting PII KEY
 * of the immediate containing object, so `{ein:{value:"X"}}` /
 * `{bank_account:{value:"X"}}` / `{ssn:{value:"X"}}` all promote their nested
 * `value` under the right PII label, not just SSN. The inherited key is the
 * ORIGINAL parent key (resolved via the registry resolver `piiLabelKeyHint`,
 * the SINGLE source of truth — NOT a hand-rolled label list here), so redactSSN
 * re-tests it against every entry's predicate and the matching entry redacts.
 */
function scrubMetaStrings(value: unknown, keyHint?: string, inheritedKey?: string): unknown {
  // A leaf value's promoting label is its immediate KEY (keyHint) if that key is
  // itself a PII label, else — bounded to ONE wrapper level — the PII key of its
  // immediate containing object (inheritedKey). So {"ein":"X"} and
  // {"ein":{"value":"X"}} both promote, but a number nested deeper under a PII-ish
  // ancestor ({"ein":{"a":{"b":N}}}) is NOT promoted (conservative: don't nuke an
  // unrelated deep number — inheritance does not accumulate past one wrapper).
  // Only a key that ANCHORED-resolves to a real PII label (piiLabelKeyHint) — or a
  // one-wrapper inherited PII key — promotes a value. The raw `?? keyHint` fallback
  // was REMOVED: it passed an unresolved organic key (caffeine_level, routing_table)
  // straight to redactSSN's intentionally-unanchored labelHint predicate, which
  // re-over-matched the substring and false-redacted the value. Unresolved key ->
  // no labelHint -> conservative scrub (the value's own in-text labels still apply).
  const hint = piiLabelKeyHint(keyHint) ?? inheritedKey;
  if (typeof value === 'string') return redactSSN(value, { labelHint: hint });
  if (typeof value === 'number') {
    // A 9-digit numeric value under a PII-ish key is PII stored as a JSON number
    // (e.g. {"ssn":987654321}). Reuse redactSSN+labelHint on the stringified
    // value; if it changes, return the placeholder string.
    const asStr = String(value);
    const scrubbed = redactSSN(asStr, { labelHint: hint });
    return scrubbed === asStr ? value : scrubbed;
  }
  // Array elements inherit their array's labeling context unchanged.
  if (Array.isArray(value)) return value.map((v) => scrubMetaStrings(v, keyHint, inheritedKey));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    // ONE wrapper level: a child inherits THIS object's key as its promoting
    // label only if THIS key is itself a PII label — it does not accumulate down
    // deeper levels. piiLabelKeyHint returns the key (any enabled PII entry
    // matched) or undefined.
    const childInherits = piiLabelKeyHint(keyHint);
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      // Redact the KEY too — metadata keys are user-controlled and could carry
      // PII (e.g. {"tenant 123-45-6789":"present"}). The ORIGINAL key is the
      // child's labelHint so a bare-9 value under a PII key promotes.
      out[redactSSN(k)] = scrubMetaStrings(v, k, childInherits);
    }
    return out;
  }
  return value;
}

/**
 * Positive markers that THIS process is running under a BORROWED agent
 * identity — an identity it was handed by a supervisor rather than one it
 * minted for its own reasoning session.
 *
 * Keyed on positive markers set by the SPAWNER, never on the absence of
 * `CTX_AGENT_NAME`. That principle is not new here: it is written into
 * `src/daemon/cron-side-run-runner.ts`, which sets `CTX_SIDE_RUN=1` as a
 * positive marker precisely because "a consumer that keys on 'no agent name'
 * cannot tell a side-run from a misconfigured spawn". This function
 * generalizes that marker so a SECOND consumer — the heartbeat refresh —
 * can ask the same question, instead of each spawn site re-deleting variables
 * and hoping every downstream consumer keys on the same absence.
 *
 * Absence of every marker grants nothing new: it simply leaves the caller's
 * explicit `refreshHeartbeat` opt-in in force. The markers can only WITHHOLD
 * a refresh, never authorize one.
 *
 * Markers, and the path each one closes:
 *
 *  - `CTX_SIDE_RUN=1` — a detached headless `claude -p` cron side-run
 *    (`cron-side-run-runner.ts:169`). That runner deletes `CTX_AGENT_NAME`
 *    from the child env, but the delete does NOT stop the bus CLI from
 *    re-deriving the same name: `resolveEnv()` falls back to a
 *    `.cortextos-env` file in `process.cwd()`, the side-run's cwd IS the
 *    agent directory, and `AgentProcess.start()` writes `CTX_AGENT_NAME`
 *    into exactly that file. So the identity comes straight back and the
 *    side-run — which is by definition NOT the agent's session — could move
 *    that agent's `last_heartbeat`. The delete stays (it is what protects
 *    `hook-crash-alert`, which reads `process.env` directly); this marker is
 *    what protects the consumers that resolve identity from disk.
 *
 *  - `CTX_ON_BEHALF_OF=<agent>` — the daemon reporting about an agent it
 *    supervises (`agent-process.ts` watchdog rollback preflight). There the
 *    daemon deliberately SETS `CTX_AGENT_NAME` to the subject agent, so
 *    neither an absence check nor a subject-vs-actor comparison can see it.
 *    The marker names WHO was borrowed rather than being a bare flag, so a
 *    misfiled event is diagnosable from the environment alone.
 *
 * Returns the marker name that fired (for callers that want to explain the
 * refusal), or null when nothing indicates a borrowed identity.
 */
export function borrowedIdentityMarker(
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  if (env.CTX_SIDE_RUN === '1') return 'CTX_SIDE_RUN';
  if (env.CTX_ON_BEHALF_OF) return 'CTX_ON_BEHALF_OF';
  return null;
}

/**
 * Log a structured event. Appends JSONL line to daily event file.
 * Identical to bash log-event.sh format.
 *
 * Events are stored at: {analyticsDir}/events/{agent}/{YYYY-MM-DD}.jsonl
 *
 * Optional side-effect: when the caller opts in via `opts.refreshHeartbeat`
 * and this agent has an existing heartbeat.json, refresh its
 * `last_heartbeat` timestamp. "Activity is liveness" holds ONLY for an
 * agent logging its OWN in-session activity, so opt-in is reserved for
 * those call sites. Daemon-on-behalf writes (e.g. delivering an inbound
 * message to another agent) must never opt in — otherwise a wedged
 * agent's heartbeat would be spoofed fresh by traffic it did not act on.
 * The default is off (fail-safe): a caller that says nothing never
 * touches the heartbeat. Other fields (status, mode, etc.) are preserved
 * from the last explicit update-heartbeat call. Best-effort: a failing
 * heartbeat refresh never blocks the event write itself. If no heartbeat
 * file exists yet we do nothing — the first update-heartbeat call creates
 * it with full field values.
 */
export function logEvent(
  paths: BusPaths,
  agentName: string,
  org: string,
  category: EventCategory,
  eventName: string,
  severity: EventSeverity,
  metadata?: Record<string, unknown> | string,
  opts?: { refreshHeartbeat?: boolean },
): void {
  validateEventCategory(category);
  validateEventSeverity(severity);

  // Parse metadata if it's a string
  let meta: Record<string, unknown> = {};
  if (typeof metadata === 'string') {
    if (isValidJson(metadata)) {
      meta = JSON.parse(metadata);
    }
  } else if (metadata) {
    meta = metadata;
  }

  // Layer-2 backstop: never STORE an SSN. Scrub the event name and every
  // string value in the metadata before it is written to the JSONL log.
  const safeEventName = redactSSN(eventName);
  meta = scrubMetaStrings(meta) as Record<string, unknown>;

  const epoch = Math.floor(Date.now() / 1000);
  const rand = randomString(5);
  const eventId = `${epoch}-${agentName}-${rand}`;
  const timestamp = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');

  const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
  const eventsDir = join(paths.analyticsDir, 'events', agentName);
  ensureDir(eventsDir);

  const eventLine = JSON.stringify({
    id: eventId,
    agent: agentName,
    org,
    timestamp,
    category,
    event: safeEventName,
    severity,
    metadata: meta,
  });

  appendFileSync(join(eventsDir, `${today}.jsonl`), eventLine + '\n', 'utf-8');

  // Refresh heartbeat timestamp only when the caller opts in (in-session
  // self-logging). Default off is fail-safe. See doc comment above.
  //
  // Session-authorship guard: the opt-in is necessary but not sufficient.
  // `bus log-event` opts in UNCONDITIONALLY, so any process that can reach
  // that CLI while carrying a borrowed agent identity can move an agent's
  // `last_heartbeat` without that agent's session having done anything. A
  // heartbeat must be authored by the session it proves. When the process
  // carries a positive marker of borrowed identity, the event is still
  // written (the record is real and wanted) but the liveness claim is
  // withheld.
  // A refresh requires all three: the caller opted in, the credential names THIS
  // agent and its nonce matches the live session the daemon recorded, and no
  // borrowed-identity marker is set. Shape alone is forgeable — `<agent>:0000…`
  // is well-formed and was never minted — so the nonce is checked against
  // daemon-owned state, which only the minting authority can write.
  const presentedNonce = sessionCredentialNonce();
  const credentialIsLive = hasAgentSessionCredential(agentName)
    && presentedNonce !== null
    && isSessionNonceLive(paths.ctxRoot, agentName, presentedNonce);
  if (opts?.refreshHeartbeat && credentialIsLive && borrowedIdentityMarker() === null) {
    refreshHeartbeatTimestamp(paths, timestamp);
  }
}

/**
 * Bump the `last_heartbeat` timestamp on the existing heartbeat.json,
 * preserving every other field. No-op when the file does not exist yet
 * or when any step fails — event writes are the authoritative record
 * and must never be blocked by heartbeat housekeeping.
 */
function refreshHeartbeatTimestamp(paths: BusPaths, timestamp: string): void {
  try {
    const hbPath = join(paths.stateDir, 'heartbeat.json');
    if (!existsSync(hbPath)) return;
    // The read-modify-write below is NOT atomic against a concurrent
    // updateHeartbeat() overwrite: without a lock, this reader can load a
    // stale heartbeat, an explicit update-heartbeat can write new status/
    // mode/task fields, and then this write clobbers them back to stale
    // (TOCTOU lost-update). Take the per-agent stateDir lock — the SAME lock
    // updateHeartbeat() takes — so the read+write is serialized against it.
    // withFileLockSync may throw on timeout; the surrounding try/catch keeps
    // the refresh best-effort and never blocks the already-persisted event.
    withFileLockSync(paths.stateDir, () => {
      const hb = JSON.parse(readFileSync(hbPath, 'utf-8')) as Heartbeat;
      hb.last_heartbeat = timestamp;
      atomicWriteSync(hbPath, JSON.stringify(hb));
    });
  } catch {
    // Best-effort — event already persisted, heartbeat refresh is secondary.
  }
}
