import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { connect } from 'net';

/**
 * The daemon-owned record of which session nonce is currently live for an agent.
 *
 * A credential of the shape `<agent>:<nonce>` proves nothing on its own: its
 * format is guessable, so `alpha:0000000000000000` passes any shape check without
 * a PTY ever minting it, and a nonce from a session that ended stays well-formed
 * forever. A capability has to be checked against something that only the minting
 * authority can write.
 *
 * So the PTY records the nonce here BEFORE it builds the child environment, and
 * the record is removed when the session ends. `logEvent` refreshes only when the
 * presented nonce equals the recorded one. No record, or a mismatch, is no
 * refresh — and the event is still written either way, because withholding a
 * liveness claim must never drop an audit record.
 */

const SESSIONS_DIR = 'heartbeat-sessions';
/** Nonces come from randomString; anything else cannot name a file here. */
const SAFE_NONCE = /^[A-Za-z0-9_-]{16,128}$/;

function sessionsDir(ctxRoot: string, agent: string): string {
  return join(ctxRoot, 'state', agent, SESSIONS_DIR);
}

function sessionFileFor(ctxRoot: string, agent: string, nonce: string): string | null {
  if (!SAFE_NONCE.test(nonce)) return null;
  return join(sessionsDir(ctxRoot, agent), `${nonce}.json`);
}

/**
 * Record a nonce as live. ONE FILE PER NONCE, named by the nonce.
 *
 * The previous shape was a single `heartbeat-session.json` per agent plus a
 * read-compare-delete helper, and that helper was check-then-act: an exiting
 * lifecycle read nonce A, matched, then `rmSync`ed the singleton path — by which
 * time a replacement could have written B to that same path. The old exit deleted
 * the LIVE replacement's record and the replacement could never refresh again.
 * That is the same name-reuse lost update the comparison was added to close, one
 * layer in: the delete still addressed the file by NAME.
 *
 * Naming the file after the nonce removes the window rather than narrowing it.
 * `unlink` is atomic on an exact path and a lifecycle can only ever name its own
 * file, so deleting A's record cannot touch B's. No read, no compare, no lock.
 */
export function recordSessionNonce(ctxRoot: string, agent: string, nonce: string): void {
  const file = sessionFileFor(ctxRoot, agent, nonce);
  if (!file) throw new Error('refusing to record a malformed session nonce');
  mkdirSync(sessionsDir(ctxRoot, agent), { recursive: true });
  writeFileSync(file, JSON.stringify({ agent, nonce }), { mode: 0o600 });
}

/**
 * Drop THIS lifecycle's record. Atomic on the exact path; cannot touch another's.
 * Ordered before SessionEnd hook dispatch on the paths the daemon controls.
 */
export function clearSessionNonce(ctxRoot: string, agent: string, nonce: string): void {
  const file = sessionFileFor(ctxRoot, agent, nonce);
  if (file) rmSync(file, { force: true });
}

/** Is this exact nonce live for this agent? Its own file existing IS the record. */
export function isSessionNonceLive(ctxRoot: string, agent: string, nonce: string): boolean {
  const file = sessionFileFor(ctxRoot, agent, nonce);
  return file !== null && existsSync(file);
}

/**
 * Drop every persisted session record. Called at daemon boot, before any agent starts.
 *
 * `stop()` and `handleExit()` clear the record on the paths the daemon controls.
 * `handleFatal` -> `process.exit(1)` controls nothing: it bypasses both, so records
 * survive the daemon that wrote them. A detached descendant of a dead agent would
 * then keep a credential that still matches a record nobody owns, and refresh the
 * heartbeat of an agent that no longer exists.
 *
 * No live session can span a daemon boot, so revoking all of them is always safe:
 * every real PTY re-mints on start.
 */
/**
 * Revoke one agent's records. Throws if the directory cannot be read — the
 * caller decides what an unknown revocation means, and for that agent it means
 * quarantine (see daemon/session-revocation-quarantine.ts).
 */
export function revokeAgentSessionNonces(ctxRoot: string, agent: string): number {
  const dir = sessionsDir(ctxRoot, agent);
  if (!existsSync(dir)) return 0;
  let revoked = 0;
  for (const entry of readdirSync(dir)) { rmSync(join(dir, entry), { force: true }); revoked += 1; }
  return revoked;
}

export function revokeAllSessionNonces(
  ctxRoot: string,
  onAgentFailure: (agent: string, error: unknown) => void,
): number {
  const stateRoot = join(ctxRoot, 'state');
  let agents: string[];
  try {
    agents = readdirSync(stateRoot);
  } catch (error) {
    // ABSENCE AND UNOBSERVABILITY ARE DIFFERENT, and conflating them here was a
    // fail-open one directory above the per-agent fail-closed below. ENOENT means
    // there is genuinely no state root, so there are zero records and boot may
    // proceed. Any OTHER enumeration failure — EACCES, EIO, a malformed
    // directory — means the population cannot be SCOPED, and an unscopable
    // population cannot be quarantined per agent: no agent name enumerates, so
    // the per-agent machinery below never runs and boot would read the failure as
    // a successful zero-record revocation while every stale credential beneath
    // that root stayed valid. Fail closed instead, and let it abort admission.
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return 0;
    throw new Error(
      `heartbeat session records cannot be enumerated at ${stateRoot}; refusing to admit agents `
      + 'because every record beneath an unreadable root is still a valid credential and the '
      + `affected population cannot be scoped: ${error}`,
      { cause: error },
    );
  }
  let revoked = 0;
  for (const agent of agents) {
    // One agent's unreadable or unwritable sessions directory must not abort the
    // sweep, and must not abort daemon boot: readdirSync throws EACCES on a
    // chmod-000 directory and nothing above this catches it, so a single bad
    // entry would take the whole fleet down. Skipping is not silent — an
    // unrevoked record is a live credential for a session that no longer exists,
    // so the failure is REPORTED to the caller rather than swallowed.
    try {
      revoked += revokeAgentSessionNonces(ctxRoot, agent);
    } catch (error) {
      onAgentFailure(agent, error);
    }
  }
  return revoked;
}

/**
 * Is another process listening on this instance's IPC socket?
 *
 * `IPCServer.start()` resolving does NOT prove exclusivity: it `unlinkSync`s any
 * existing socket with no liveness check and, on EADDRINUSE, unlinks and retries.
 * A second daemon started against a live instance therefore steals the socket and
 * resolves cleanly. Inferring ownership from that call is how a revocation that
 * exists to clean up after a rare crash became something that could wipe a live
 * daemon's records and stop the whole fleet refreshing.
 *
 * So exclusivity is proven POSITIVELY, by connecting. Anything that answers means
 * another daemon is live.
 */
export function instanceSocketAnswers(socketPath: string, timeoutMs = 500): Promise<boolean> {
  return new Promise(resolve => {
    if (!existsSync(socketPath)) return resolve(false);
    const socket = connect(socketPath);
    const done = (answered: boolean) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(answered);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}
