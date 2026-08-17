import { mkdirSync, writeFileSync, readFileSync, renameSync, rmSync, statSync } from 'fs';
import { join } from 'path';

/**
 * A lock directory without a readable PID can only be a process still inside
 * the tiny mkdir -> PID publication window, or an abandoned partial acquire.
 * Preserve the live window, but make the abandoned state recoverable.
 */
export const PARTIAL_LOCK_STALE_MS = 5_000;

interface LockSnapshot {
  readonly dev: number;
  readonly ino: number;
  readonly mtimeMs: number;
}

interface OwnedLockGeneration {
  readonly snapshot: LockSnapshot;
  readonly ownerFile: string;
  readonly ownerToken: string;
}

class GenerationLockHandle {
  readonly #lockHandleBrand = true;
}

interface LockHandleState {
  readonly lockDir: string;
  readonly generation: OwnedLockGeneration;
}

const LOCK_HANDLE_STATE = new WeakMap<GenerationLockHandle, LockHandleState>();

function createLockHandle(
  lockDir: string,
  generation: OwnedLockGeneration,
): GenerationLockHandle {
  // Copy at the materialization door so even an internal alias to the
  // acquisition-time object cannot rewrite the identity retained for release.
  const snapshot = Object.freeze({ ...generation.snapshot });
  const immutableGeneration = Object.freeze({
    snapshot,
    ownerFile: generation.ownerFile,
    ownerToken: generation.ownerToken,
  });
  const handle = new GenerationLockHandle();
  Object.freeze(handle);

  LOCK_HANDLE_STATE.set(handle, Object.freeze({
    lockDir,
    generation: immutableGeneration,
  }));
  return handle;
}

export type LockHandle = GenerationLockHandle;

function ownsLockGeneration(lockDir: string, generation: OwnedLockGeneration): boolean {
  const current = snapshotLock(lockDir);
  if (!current || !sameLock(current, generation.snapshot)) return false;

  try {
    return readFileSync(generation.ownerFile, 'utf-8') === generation.ownerToken;
  } catch {
    // A missing or unreadable owner token is ambiguous. Never publish into or
    // remove a path unless both its inode and token still identify our claim.
    return false;
  }
}

function createLock(lockDir: string, pidFile: string): LockHandle | false {
  let createdLockDir = false;
  let acquired = false;
  let generation: OwnedLockGeneration | null = null;
  const ownerToken = `${process.pid}-${process.hrtime.bigint()}`;
  const ownerFile = join(lockDir, '.owner');
  const pendingPidFile = join(lockDir, `pid.${ownerToken}.pending`);

  try {
    mkdirSync(lockDir);
    createdLockDir = true;

    // The fixed-name token is the ownership publication point. If a delayed
    // creator resumes after its directory was quarantined and replaced, wx
    // observes the successor's token and refuses to claim the rebound path.
    try {
      writeFileSync(ownerFile, ownerToken, { flag: 'wx' });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false;
      throw err;
    }

    const createdSnapshot = snapshotLock(lockDir);
    if (!createdSnapshot) return false;
    generation = { snapshot: createdSnapshot, ownerFile, ownerToken };
    if (!ownsLockGeneration(lockDir, generation)) return false;

    try {
      writeFileSync(pendingPidFile, String(process.pid));
    } catch (err) {
      if (!ownsLockGeneration(lockDir, generation)) return false;
      throw err;
    }
    if (!ownsLockGeneration(lockDir, generation)) return false;

    try {
      renameSync(pendingPidFile, pidFile);
    } catch (err) {
      if (!ownsLockGeneration(lockDir, generation)) return false;
      throw err;
    }
    if (!ownsLockGeneration(lockDir, generation)) return false;
    acquired = true;
    return createLockHandle(lockDir, generation);
  } finally {
    // writeFileSync/renameSync can fail after mkdirSync succeeds (ENOSPC was
    // observed in production). Never leave that local partial acquire behind.
    // A hard crash cannot run finally; the mtime reap below covers that case.
    if (
      createdLockDir
      && !acquired
      && generation
      && ownsLockGeneration(lockDir, generation)
    ) {
      try {
        removeOwnedLockGeneration(lockDir, generation);
      } catch {
        // Preserve the original acquire error. The partial directory remains
        // time-reapable by a later caller.
      }
    }
  }
}

function snapshotLock(lockDir: string): LockSnapshot | null {
  try {
    const stat = statSync(lockDir);
    return { dev: stat.dev, ino: stat.ino, mtimeMs: stat.mtimeMs };
  } catch {
    return null;
  }
}

function sameLock(left: LockSnapshot, right: LockSnapshot): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function removeOwnedTakeoverMarker(markerFile: string, markerToken: string): void {
  try {
    if (readFileSync(markerFile, 'utf-8') === markerToken) {
      rmSync(markerFile, { force: true });
    }
  } catch {
    // The generation was concurrently released or replaced. Never remove an
    // unverified marker from the new generation.
  }
}

function staleMarkerCanBeRecovered(
  lockDir: string,
  markerFile: string,
  expected: LockSnapshot,
): boolean {
  const marked = snapshotLock(lockDir);
  if (!marked || !sameLock(marked, expected)) return false;
  if (Date.now() - marked.mtimeMs < PARTIAL_LOCK_STALE_MS) return false;

  let markerRaw: string;
  try {
    markerRaw = readFileSync(markerFile, 'utf-8').trim();
  } catch {
    // A transient read failure cannot prove the marker owner is gone.
    return false;
  }

  const match = /^([1-9]\d*):\d+$/.exec(markerRaw);
  if (!match) {
    // An old partial marker has no credible live owner. The caller still has
    // to claim the exact directory generation through atomic quarantine.
    return true;
  }

  const markerPid = Number(match[1]);
  if (!Number.isSafeInteger(markerPid)) return true;

  try {
    process.kill(markerPid, 0);
    // A live synchronous release/reclaim operation may have been descheduled
    // beyond the age ceiling. Never steal its operation marker by time alone.
    return false;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ESRCH';
  }
}

function removeOwnedLockGeneration(
  lockDir: string,
  generation: OwnedLockGeneration,
): boolean {
  const markerFile = join(lockDir, '.takeover');
  const markerToken = `${process.pid}:${process.hrtime.bigint()}`;

  try {
    writeFileSync(markerFile, markerToken, { flag: 'wx' });
  } catch {
    return false;
  }

  if (!ownsLockGeneration(lockDir, generation)) {
    removeOwnedTakeoverMarker(markerFile, markerToken);
    return false;
  }

  try {
    rmSync(lockDir, { recursive: true, force: true });
    return true;
  } catch {
    removeOwnedTakeoverMarker(markerFile, markerToken);
    return false;
  }
}

function replaceStaleLock(
  lockDir: string,
  pidFile: string,
  expected: LockSnapshot,
): LockHandle | false {
  const markerFile = join(lockDir, '.takeover');
  const markerToken = `${process.pid}:${process.hrtime.bigint()}`;
  let createdMarker = false;

  try {
    writeFileSync(markerFile, markerToken, { flag: 'wx' });
    createdMarker = true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return false;
    if (code !== 'EEXIST') throw err;

    if (!staleMarkerCanBeRecovered(lockDir, markerFile, expected)) return false;
  }

  const claimed = snapshotLock(lockDir);
  if (!claimed || !sameLock(claimed, expected)) {
    if (createdMarker) removeOwnedTakeoverMarker(markerFile, markerToken);
    return false;
  }

  // Keep the claimed generation as a non-empty tombstone. A delayed reclaimer
  // that observed this same inode cannot rename a newly-acquired `.lock.d`
  // over the tombstone, so it must lose rather than report a second success.
  const quarantineDir = `${lockDir}.orphan-${expected.dev}-${expected.ino}`;
  try {
    renameSync(lockDir, quarantineDir);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'EEXIST' || code === 'ENOTEMPTY') return false;
    throw err;
  }

  try {
    return createLock(lockDir, pidFile);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw err;
  }
}

function recoverPartialLock(
  lockDir: string,
  pidFile: string,
  observed: LockSnapshot,
): LockHandle | false {
  if (Date.now() - observed.mtimeMs < PARTIAL_LOCK_STALE_MS) return false;
  return replaceStaleLock(lockDir, pidFile, observed);
}

/**
 * Acquire a mutex lock using mkdir (atomic on all filesystems).
 * Matches the bash pattern: mkdir .lock.d with PID tracking.
 *
 * Returns an opaque generation handle if acquired, false if another process
 * holds it. The exact handle is required for generation-safe release.
 * Automatically recovers stale locks (dead process).
 */
export function acquireLock(dir: string): LockHandle | false {
  const lockDir = join(dir, '.lock.d');
  const pidFile = join(lockDir, 'pid');

  try {
    return createLock(lockDir, pidFile);
  } catch (err) {
    // Only EEXIST means contention. EACCES / ENOSPC / EROFS / etc. are real
    // filesystem failures — propagate so the caller (withFileLockSync) does
    // not loop forever against a directory that will never be writable.
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'EEXIST') {
      throw err;
    }
    // mkdirSync failed with EEXIST — another process holds (or is mid-acquire
    // of) the lock. A recent partial lock is protected from theft; an old one
    // is an abandoned acquire and can be replaced.
    const observedLock = snapshotLock(lockDir);
    if (!observedLock) return false;

    let storedPidRaw: string;
    try {
      storedPidRaw = readFileSync(pidFile, 'utf-8').trim();
    } catch (readErr) {
      // Only a genuinely absent PID is a partial acquire. EACCES/EIO/EMFILE
      // and every other ambiguous read failure must preserve mutual exclusion.
      if ((readErr as NodeJS.ErrnoException).code !== 'ENOENT') return false;
      return recoverPartialLock(lockDir, pidFile, observedLock);
    }

    if (!/^[1-9]\d*$/.test(storedPidRaw)) {
      return recoverPartialLock(lockDir, pidFile, observedLock);
    }
    const storedPid = Number(storedPidRaw);
    if (!Number.isSafeInteger(storedPid)) {
      return recoverPartialLock(lockDir, pidFile, observedLock);
    }

    // Check if process is still alive
    try {
      process.kill(storedPid, 0);
      // Process is alive - lock is held
      return false;
    } catch (killErr) {
      // EPERM and other ambiguous errors mean the process may still be alive.
      // Only ESRCH proves the recorded owner no longer exists.
      if ((killErr as NodeJS.ErrnoException).code !== 'ESRCH') return false;
      // Process is dead - stale lock, remove and re-acquire atomically.
      return replaceStaleLock(lockDir, pidFile, observedLock);
    }
  }
}

/**
 * Release exactly the mutex generation represented by `handle`.
 */
export function releaseLock(handle: LockHandle): boolean {
  if (!(handle instanceof GenerationLockHandle)) return false;
  const state = LOCK_HANDLE_STATE.get(handle);
  if (!state) return false;
  return removeOwnedLockGeneration(state.lockDir, state.generation);
}

/**
 * Inter-process lock options for `withFileLockSync`.
 */
export interface FileLockOptions {
  /** Total time to wait for the lock before throwing. Default 5000ms. */
  timeoutMs?: number;
  /** First retry delay; doubles up to maxBackoffMs. Default 5ms. */
  initialBackoffMs?: number;
  /** Cap on retry delay. Default 100ms. */
  maxBackoffMs?: number;
}

// SharedArrayBuffer + Atomics.wait gives us a clean cross-thread sleep
// from sync code without spinning the CPU.  One module-scoped buffer is
// reused across calls; we never write to it (only sleep on a wait that
// always times out at `ms`).
const SLEEP_SAB  = new SharedArrayBuffer(4);
const SLEEP_VIEW = new Int32Array(SLEEP_SAB);

/**
 * Acquire `dir`'s mutex, run `fn`, then release the lock — even if `fn`
 * throws.  Retries with exponential backoff (capped) until `timeoutMs`.
 *
 * Use this around any read-modify-write sequence on a per-agent file
 * (crons.json etc.) so two concurrent processes can't lose each other's
 * mutations between the read and the write (the atomic rename in
 * writeCrons is per-write only — it does NOT make the surrounding
 * read-modify-write transactional).
 *
 * @throws if the lock cannot be acquired within `timeoutMs`.
 */
export function withFileLockSync<T>(
  dir: string,
  fn: () => T,
  opts: FileLockOptions = {},
): T {
  const timeoutMs    = opts.timeoutMs        ?? 5_000;
  const initBackoff  = opts.initialBackoffMs ?? 5;
  const maxBackoff   = opts.maxBackoffMs     ?? 100;

  // Use process.hrtime.bigint() instead of Date.now() so the timeout works
  // under vi.useFakeTimers() (which freezes Date.now).  hrtime reads the
  // monotonic clock via syscall and is not stubbed by fake-timer libraries.
  const start = process.hrtime.bigint();
  const timeoutNs = BigInt(timeoutMs) * 1_000_000n;
  let backoff = initBackoff;

  let handle: LockHandle | false;
  while (!(handle = acquireLock(dir))) {
    if (process.hrtime.bigint() - start > timeoutNs) {
      throw new Error(
        `withFileLockSync: failed to acquire lock on "${dir}" within ${timeoutMs}ms`,
      );
    }
    Atomics.wait(SLEEP_VIEW, 0, 0, backoff);
    backoff = Math.min(backoff * 2, maxBackoff);
  }

  try {
    return fn();
  } finally {
    releaseLock(handle);
  }
}
