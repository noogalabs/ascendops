/**
 * watchdog.ts — Commit-stability watchdog and git rollback.
 *
 * Ports the two-layer crash-recovery pattern from claude-code-thyself
 * (robman/claude-code-thyself) into the cortextos daemon.
 *
 * How it works:
 * - Each time an agent crashes, the watchdog records a failure against the
 *   current git commit hash in a per-agent stability file.
 * - If the same commit accumulates ROLLBACK_THRESHOLD failures, the watchdog
 *   performs a git rollback: stash uncommitted work, reset hard to the last
 *   known-healthy commit (or origin/main if none), and write a recovery note
 *   for the agent to read on its next boot.
 * - After the agent runs for at least MIN_HEALTHY_SECONDS without crashing,
 *   the current commit is marked healthy so normal restarts don't trigger
 *   rollbacks.
 * - If the agent's directory is not inside a git repository, all git
 *   operations degrade gracefully — the watchdog logs a warning and the
 *   daemon continues with its normal crash-backoff behaviour.
 *
 * Stability state is stored in:
 *   {ctxRoot}/state/{agentName}/watchdog.json
 *
 * Recovery note (written on rollback, cleared after first read):
 *   {ctxRoot}/state/{agentName}/watchdog-recovery.txt
 */

import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  unlinkSync,
} from 'fs';
import { join } from 'path';
import { execFileSync } from 'child_process';
import { atomicWriteSync } from '../utils/atomic.js';

/**
 * Timeout tiers for the watchdog's git subprocesses.
 *
 * The watchdog exists to notice stalled agents. An unbounded child can make the
 * watchdog itself stall, and a stalled watchdog does not report that it stalled:
 * it stops watching while every agent it supervises still looks healthy, because
 * nothing is producing a failure signal. Every git spawn below is bounded.
 *
 * BASIS FOR THE NUMBERS (measured on this host 2026-07-28 at load ~2.6, and this
 * box has been observed at load 21):
 *   - local reads (rev-parse / cat-file / merge-base / stash list): ~30ms each.
 *     15s is ~500x observed, which absorbs heavy load and index.lock contention.
 *   - network fetch: 472ms observed. Network STALLS are unbounded by nature and
 *     are the hazard this bound exists for, so 60s is deliberately generous.
 *   - mutations (stash / tag / reset --hard): NOT MEASURED, deliberately. Timing
 *     `reset --hard` means running it. Asymmetry decides the value instead:
 *     interrupting a reset mid-recovery can leave a repository wedged, while a
 *     slow recovery only costs seconds. So take the longer bound.
 * Where measurement was unavailable the rule is generosity, because the cost of
 * killing too early is strictly worse than the cost of waiting.
 */
export const GIT_READ_TIMEOUT_MS = 15_000;     // measured ~30ms; 500x headroom
export const GIT_MUTATE_TIMEOUT_MS = 30_000;   // unmeasured by choice; longer bound
export const GIT_NETWORK_TIMEOUT_MS = 60_000;  // measured 472ms; stalls unbounded

/**
 * True only for a timeout-induced abort.
 *
 * Deliberately NOT keyed on `signal === 'SIGTERM'`: a child signalled for any
 * unrelated reason would then be reported as a timeout, and a loud log that lies
 * is worse than the silence this fix replaced. Node sets code ETIMEDOUT when it
 * aborts a child for exceeding `timeout`.
 */
export function isSubprocessTimeout(err: unknown): boolean {
  const e = err as (NodeJS.ErrnoException & { killed?: boolean }) | null;
  return e?.code === 'ETIMEDOUT';
}

/**
 * Run a git subprocess with a mandatory, ENFORCEABLE timeout.
 *
 * `timeout` alone is not sufficient. Node signals the child with `killSignal`
 * (default SIGTERM) and a wedged git or a credential helper can ignore SIGTERM
 * and keep execFileSync blocked - i.e. the bound would hold for the happy case
 * and fail for the wedge case, which is the only case it exists for. So:
 *   - killSignal SIGKILL, which cannot be trapped or ignored;
 *   - GIT_TERMINAL_PROMPT=0 so fetch/credential paths fail instead of waiting
 *     forever on a prompt no human will ever answer in a daemon.
 *
 * Callers wrap these in bare `catch { return null }`. The loud log fires HERE,
 * before the rethrow, so a timeout stays distinguishable from "not a git
 * repository" without changing any caller contract.
 */
export function runGit(
  args: string[],
  opts: { cwd: string; timeoutMs: number; capture?: boolean },
): string {
  try {
    const out = execFileSync('git', args, {
      cwd: opts.cwd,
      timeout: opts.timeoutMs,
      killSignal: 'SIGKILL',
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      ...(opts.capture
        ? { encoding: 'utf-8' as const, stdio: ['pipe', 'pipe', 'pipe'] as const }
        : { stdio: 'pipe' as const }),
    });
    return typeof out === 'string' ? out : '';
  } catch (err) {
    if (isSubprocessTimeout(err)) {
      console.error(
        `[watchdog] TIMEOUT after ${opts.timeoutMs}ms: git ${args.join(' ')} (cwd=${opts.cwd}). ` +
        'Agent supervision is DEGRADED for this tick. This is NOT a missing repository ' +
        'and NOT a clean result.',
      );
    }
    throw err;
  }
}

// Number of failures on the same commit before triggering a rollback.
export const ROLLBACK_THRESHOLD = 3;

// Minimum uptime in seconds for a session to be considered healthy.
export const MIN_HEALTHY_SECONDS = 60;

export interface CommitStability {
  /** Maps commit hash → number of crash-only exits recorded. */
  restart_counts: Record<string, number>;
  /** The last commit hash that ran cleanly for ≥ MIN_HEALTHY_SECONDS. */
  last_healthy: string;
  /** ISO timestamp of the last rollback (informational). */
  last_rollback_at?: string;
  /** Maps branch name → cumulative destructive rollback count. */
  rollback_counts?: Record<string, number>;
}

export interface RollbackResult {
  success: boolean;
  rolledBackTo: string;
  stashRef: string | null;
  reason: string;
}

export interface RollbackPreflightContext {
  repoRoot: string;
  stateDir: string;
  branch: string;
  failedCommit: string;
  target: string;
  resetCount: number;
  maxResets: number;
}

type RollbackPreflightHook = (context: RollbackPreflightContext) => void | Promise<void>;

export interface RollbackOptions {
  /** Maximum cumulative destructive resets allowed on one branch. Defaults to 1. */
  maxResetsPerBranch?: number;
  /** Optional floor ref. Rollback target must not be older than this ref. */
  floorRef?: string;
  /** Called after preflight passes and before the first destructive git op. */
  logEventBeforeRollback?: RollbackPreflightHook;
  /** Called after preflight passes and before the first destructive git op. */
  notifyBeforeRollback?: RollbackPreflightHook;
}

export function isWatchdogRollbackEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.WATCHDOG_ROLLBACK_ENABLED?.trim().toLowerCase() === 'true';
}

export function watchdogRollbackMaxResets(env: NodeJS.ProcessEnv = process.env): number {
  const parsed = Number.parseInt(env.WATCHDOG_ROLLBACK_MAX_RESETS ?? '', 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 1;
}

export function watchdogRollbackFloorRef(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const ref = env.WATCHDOG_ROLLBACK_FLOOR_REF?.trim();
  return ref || undefined;
}

// ---------------------------------------------------------------------------
// Stability state helpers
// ---------------------------------------------------------------------------

function stabilityPath(stateDir: string): string {
  return join(stateDir, 'watchdog.json');
}

function recoveryNotePath(stateDir: string): string {
  return join(stateDir, 'watchdog-recovery.txt');
}

export function loadStability(stateDir: string): CommitStability {
  const path = stabilityPath(stateDir);
  if (!existsSync(path)) {
    return { restart_counts: {}, last_healthy: '', rollback_counts: {} };
  }
  try {
    const raw = readFileSync(path, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<CommitStability>;
    return {
      restart_counts: parsed.restart_counts && typeof parsed.restart_counts === 'object'
        ? parsed.restart_counts
        : {},
      last_healthy: typeof parsed.last_healthy === 'string' ? parsed.last_healthy : '',
      last_rollback_at: parsed.last_rollback_at,
      rollback_counts: parsed.rollback_counts && typeof parsed.rollback_counts === 'object'
        ? parsed.rollback_counts as Record<string, number>
        : {},
    };
  } catch {
    return { restart_counts: {}, last_healthy: '', rollback_counts: {} };
  }
}

function saveStability(stateDir: string, data: CommitStability): void {
  try {
    // Atomic (tmp + rename) — saveStability fires on EVERY crash, i.e. exactly
    // when daemon death mid-write is most likely. A torn watchdog.json would
    // reset restart_counts/last_healthy and defeat the rollback threshold.
    // atomicWriteSync mkdirs the parent dir and appends the trailing '\n'
    // itself, so on-disk bytes are identical to the previous format.
    atomicWriteSync(stabilityPath(stateDir), JSON.stringify(data, null, 2));
  } catch {
    // Best-effort — never throw from the watchdog
  }
}

// ---------------------------------------------------------------------------
// Git helpers
// ---------------------------------------------------------------------------

/**
 * Walk up from `dir` to find the enclosing git repository root.
 * Returns null if `dir` is not inside a git repo.
 */
export function findGitRoot(dir: string): string | null {
  try {
    const result = runGit(['rev-parse', '--show-toplevel'], {
      cwd: dir,
      timeoutMs: GIT_READ_TIMEOUT_MS,
      capture: true,
    });
    return result.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Return the HEAD commit hash in `repoRoot`, or null on failure.
 */
export function getCurrentCommit(repoRoot: string): string | null {
  try {
    const hash = runGit(['rev-parse', 'HEAD'], {
      cwd: repoRoot,
      timeoutMs: GIT_READ_TIMEOUT_MS,
      capture: true,
    });
    return hash.trim() || null;
  } catch {
    return null;
  }
}

function getCurrentBranch(repoRoot: string): string {
  try {
    const branch = runGit(['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: repoRoot,
      timeoutMs: GIT_READ_TIMEOUT_MS,
      capture: true,
    }).trim();
    return branch || 'HEAD';
  } catch {
    return 'unknown';
  }
}

function parsePositiveInt(value: number | undefined, fallback: number): number {
  if (value !== undefined && Number.isInteger(value) && value > 0) return value;
  return fallback;
}

// ---------------------------------------------------------------------------
// Public watchdog API
// ---------------------------------------------------------------------------

/**
 * Record one crash failure for the current HEAD commit.
 * Called by AgentProcess.handleExit() on every unintentional crash.
 *
 * @param stateDir  Agent's state directory ({ctxRoot}/state/{agentName})
 * @param repoRoot  Git repository root for the agent's working directory.
 *                  Pass null if the agent is not inside a git repo.
 */
export function recordFailure(
  stateDir: string,
  repoRoot: string | null,
): void {
  if (!repoRoot) return;

  const commit = getCurrentCommit(repoRoot);
  if (!commit) return;

  const data = loadStability(stateDir);
  data.restart_counts[commit] = (data.restart_counts[commit] ?? 0) + 1;
  saveStability(stateDir, data);
}

/**
 * Mark the current HEAD commit as healthy. Resets its failure count and
 * updates last_healthy. Called after MIN_HEALTHY_SECONDS of uptime.
 *
 * @param stateDir  Agent's state directory.
 * @param repoRoot  Git repository root, or null if not in a git repo.
 */
export function markHealthy(
  stateDir: string,
  repoRoot: string | null,
): void {
  if (!repoRoot) return;

  const commit = getCurrentCommit(repoRoot);
  if (!commit) return;

  const data = loadStability(stateDir);
  delete data.restart_counts[commit];
  data.last_healthy = commit;
  saveStability(stateDir, data);
}

/**
 * Returns true if the current HEAD commit has accumulated enough failures
 * to warrant a rollback.
 *
 * @param stateDir  Agent's state directory.
 * @param repoRoot  Git repository root, or null if not in a git repo.
 */
export function shouldRollback(
  stateDir: string,
  repoRoot: string | null,
): boolean {
  if (!repoRoot) return false;

  const commit = getCurrentCommit(repoRoot);
  if (!commit) return false;

  const data = loadStability(stateDir);
  return (data.restart_counts[commit] ?? 0) >= ROLLBACK_THRESHOLD;
}

/**
 * Validate that a commit-ish target is reachable in the repo. Returns true
 * only if `git cat-file -e <target>^{commit}` succeeds — guards against
 * resetting to an orphaned/garbage-collected commit hash, which would either
 * fail loudly or silently move HEAD to an unreachable state.
 *
 * Worktree-eats-docs bug (2026-05-12): a stale `last_healthy` commit got
 * rewritten by an upstream rebase + later garbage-collected. The previous
 * rollback path called `git reset --hard <orphaned-sha>` without checking
 * whether the target was still valid. Validation must run BEFORE any
 * destructive op (stash, tag, reset) so we never strand the working tree.
 */
function targetIsValid(repoRoot: string, target: string): boolean {
  if (!target) return false;
  try {
    runGit(['cat-file', '-e', `${target}^{commit}`], {
      cwd: repoRoot,
      timeoutMs: GIT_READ_TIMEOUT_MS,
    });
    return true;
  } catch {
    return false;
  }
}

function targetRespectsFloor(repoRoot: string, target: string, floorRef: string): boolean {
  if (!floorRef) return true;
  if (!targetIsValid(repoRoot, floorRef)) return false;
  try {
    runGit(['merge-base', '--is-ancestor', floorRef, target], {
      cwd: repoRoot,
      timeoutMs: GIT_READ_TIMEOUT_MS,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Perform a git rollback:
 *   1. Determine + VALIDATE rollback target (last_healthy commit, or origin/main).
 *   2. Stash uncommitted work (preserving it for the agent to review).
 *   3. git reset --hard <target> on the current branch.
 *   4. Write a recovery note the agent reads on next boot.
 *
 * Returns a RollbackResult describing what happened. On any git error the
 * result has success=false and the daemon falls back to normal restart.
 *
 * Worktree-eats-docs bug (2026-05-12) safety patch:
 *   - Target validation runs BEFORE stash so an invalid target aborts cleanly
 *     instead of stashing-then-discovering-reset-fails.
 *   - Stash uses bare `git stash push -m` (NO -u flag) so the watchdog never
 *     touches untracked files anywhere in the repo tree. Original `-u` could
 *     interact with the surrounding working tree (especially gitignored agent
 *     state under orgs/) in unexpected ways across git versions.
 *   - Refuse to roll back to HEAD itself — a no-op that would still run the
 *     destructive stash+reset cycle for no benefit.
 */
export async function performRollback(
  stateDir: string,
  repoRoot: string,
  options: RollbackOptions = {},
): Promise<RollbackResult> {
  const failedCommit = getCurrentCommit(repoRoot) ?? 'unknown';
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const branch = getCurrentBranch(repoRoot);
  const maxResets = parsePositiveInt(options.maxResetsPerBranch, 1);

  // Step 1: determine + validate rollback target FIRST (pre-flight)
  const stability = loadStability(stateDir);
  let target = stability.last_healthy;
  const rollbackCounts = stability.rollback_counts ?? {};
  const resetCount = rollbackCounts[branch] ?? 0;

  if (!target) {
    // No healthy commit on record — fetch and use origin/main
    try {
      runGit(['fetch', 'origin', 'main', '--quiet'], {
        cwd: repoRoot,
        timeoutMs: GIT_NETWORK_TIMEOUT_MS,
      });
      const originMain = runGit(['rev-parse', 'origin/main'], {
        cwd: repoRoot,
        timeoutMs: GIT_READ_TIMEOUT_MS,
        capture: true,
      });
      target = originMain.trim();
    } catch {
      return {
        success: false,
        rolledBackTo: '',
        stashRef: null,
        reason: 'Could not determine rollback target (no healthy commit, fetch failed)',
      };
    }
  }

  // Pre-flight: target must be a reachable commit AND must not equal HEAD.
  // Either check failing aborts BEFORE we touch the working tree.
  if (!targetIsValid(repoRoot, target)) {
    return {
      success: false,
      rolledBackTo: target,
      stashRef: null,
      reason: `Rollback target ${target.slice(0, 12)} is not a reachable commit — refusing destructive ops`,
    };
  }

  if (target === failedCommit) {
    return {
      success: false,
      rolledBackTo: target,
      stashRef: null,
      reason: `Rollback target equals current HEAD (${failedCommit.slice(0, 12)}) — refusing no-op destructive cycle`,
    };
  }

  if (resetCount >= maxResets) {
    return {
      success: false,
      rolledBackTo: target,
      stashRef: null,
      reason: `Rollback depth cap reached for branch ${branch}: ${resetCount}/${maxResets} resets already recorded`,
    };
  }

  if (options.floorRef && !targetRespectsFloor(repoRoot, target, options.floorRef)) {
    return {
      success: false,
      rolledBackTo: target,
      stashRef: null,
      reason: `Rollback target ${target.slice(0, 12)} is older than or unrelated to floor ref ${options.floorRef} — refusing destructive ops`,
    };
  }

  const preflightContext: RollbackPreflightContext = {
    repoRoot,
    stateDir,
    branch,
    failedCommit,
    target,
    resetCount,
    maxResets,
  };
  try {
    await options.logEventBeforeRollback?.(preflightContext);
  } catch {
    // Best-effort audit hook — never let logging change daemon recovery flow.
  }
  try {
    await options.notifyBeforeRollback?.(preflightContext);
  } catch {
    // Best-effort operator notification — rollback safety preflight already passed.
  }

  // Step 2: stash tracked modifications only (NO -u flag — watchdog must
  // never touch untracked files, including gitignored agent state). Best-
  // effort: if stash fails or nothing to stash, continue with reset.
  let stashRef: string | null = null;
  try {
    runGit(
      ['stash', 'push', '-m', `cct-recovery-${ts}`],
      { cwd: repoRoot, timeoutMs: GIT_MUTATE_TIMEOUT_MS },
    );
    // Confirm the stash was created (git stash push is silent on nothing-to-stash)
    const stashList = runGit(['stash', 'list', '--max-count=1'], {
      cwd: repoRoot,
      timeoutMs: GIT_READ_TIMEOUT_MS,
      capture: true,
    });
    if (stashList.trim().includes('cct-recovery')) {
      stashRef = 'stash@{0}';
    }
  } catch {
    // Nothing to stash or stash failed — continue with rollback
  }

  // Step 3: tag failed commit and reset to target
  try {
    // Tag the failed commit for post-mortem reference
    try {
      runGit(
        ['tag', `failed-${ts}-${failedCommit.slice(0, 7)}`],
        { cwd: repoRoot, timeoutMs: GIT_MUTATE_TIMEOUT_MS },
      );
    } catch {
      // Tagging is best-effort — tag may already exist
    }

    runGit(['reset', '--hard', target], {
      cwd: repoRoot,
      timeoutMs: GIT_MUTATE_TIMEOUT_MS,
    });
  } catch (err) {
    return {
      success: false,
      rolledBackTo: target,
      stashRef,
      reason: `git reset failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // Step 4: write recovery note for the agent to read on next boot
  const stashNote = stashRef
    ? `\nUncommitted work was stashed as ${stashRef}. Review with: git stash show -p`
    : '';
  const note = [
    `WATCHDOG ROLLBACK — ${ts}`,
    ``,
    `The agent crashed ${ROLLBACK_THRESHOLD} times on commit ${failedCommit.slice(0, 12)}.`,
    `The daemon rolled back to: ${target.slice(0, 12)}`,
    stashNote,
    ``,
    `ACTION REQUIRED:`,
    `1. Run \`git log --oneline -10\` to review the rollback point.`,
    `2. If a stash exists, run \`git stash show -p\` to inspect what was stashed.`,
    `3. Identify what change on ${failedCommit.slice(0, 12)} caused the crash loop.`,
    `4. Write your findings to memory and notify the operator before resuming normal work.`,
    `5. Do NOT re-apply the stash until the root cause is understood.`,
  ].join('\n');

  try {
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(recoveryNotePath(stateDir), note, 'utf-8');
  } catch {
    // Best-effort
  }

  // Update stability: clear failed commit's count, record rollback time
  stability.last_rollback_at = new Date().toISOString();
  delete stability.restart_counts[failedCommit];
  stability.rollback_counts = {
    ...rollbackCounts,
    [branch]: resetCount + 1,
  };
  saveStability(stateDir, stability);

  return { success: true, rolledBackTo: target, stashRef, reason: '' };
}

/**
 * Read the recovery note without deleting it. Returns the note text if one
 * exists, null otherwise. Use deleteRecoveryNote() to remove it after the
 * note has been successfully delivered to the agent.
 */
export function readRecoveryNote(stateDir: string): string | null {
  const path = recoveryNotePath(stateDir);
  if (!existsSync(path)) return null;
  try {
    return readFileSync(path, 'utf-8') || null;
  } catch {
    return null;
  }
}

/**
 * Delete the recovery note. Called after the note has been injected into a
 * prompt that was successfully delivered to the agent.
 */
export function deleteRecoveryNote(stateDir: string): void {
  const path = recoveryNotePath(stateDir);
  try {
    unlinkSync(path);
  } catch {
    // Best-effort — file may not exist
  }
}

/**
 * Read and consume the recovery note. Returns the note text if one exists,
 * null otherwise. The file is deleted after reading so it surfaces only once.
 *
 * @deprecated Prefer readRecoveryNote() + deleteRecoveryNote() so the note
 * is only deleted after the prompt that contains it has been delivered.
 */
export function consumeRecoveryNote(stateDir: string): string | null {
  const note = readRecoveryNote(stateDir);
  if (note) deleteRecoveryNote(stateDir);
  return note;
}
