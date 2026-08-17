/**
 * cron-health.ts — Pure health computation helper for the fleet health dashboard.
 *
 * Subtask 4.4.
 *
 * This module is intentionally side-effect-free and has no I/O dependencies so
 * it can be unit-tested exhaustively with injected fixtures.
 *
 * States
 * ------
 *   never-fired  — cron has never produced an execution log entry (lastFire null)
 *                  AND it is not a future-scheduled one-shot in its grace window.
 *   failure      — most recent execution log entry is 'failed' with no later success.
 *   warning      — gap between now and lastFire > 2 × expectedIntervalMs.
 *   healthy      — everything else.
 *
 * One-shot crons (fire_at field set, no schedule interval)
 * ---------------------------------------------------------
 *   A "once" cron that has not yet fired but whose fire_at is still in the future
 *   (+ grace period) is treated as healthy — it is not overdue.
 *   After fire_at + grace period passes without a fire, it becomes warning/never-fired.
 */

import { parseDurationMs } from '../bus/cron-state.js';
import type { CronSummaryRow, CronExecutionLogEntry, CronFireKind } from '../types/index.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type HealthState = 'healthy' | 'warning' | 'failure' | 'never-fired';

/**
 * Compile-time exhaustiveness guard for the summary COUNTER switches.
 *
 * ## WHY THIS EXISTS
 *
 * `allHealthy` on the health page is derived from the counters:
 * `warning === 0 && failure === 0 && neverFired === 0`. The counter switches
 * below enumerate all four states today and are correct — but nothing FORCED
 * them to be exhaustive, so adding a fifth `HealthState` would leave rows in
 * that state incrementing nothing. All three checked counters would stay zero
 * and the page would render "All systems nominal" over them.
 *
 * That is UNKNOWN SHOWN AS GREEN, which is strictly worse than unknown shown as
 * red, and it is the `never-fired` lesson one member further out: `never-fired`
 * was given its own counter precisely so it could not hide inside `healthy`,
 * and the mechanism that protects it does not protect its successor.
 *
 * ## WHY IT DOES NOT THROW
 *
 * A literal `assertNever` that throws would move the failure from build time to
 * RENDER time, on a health dashboard — the page would crash instead of
 * degrading, and it would do so on exactly the malformed input a health view
 * exists to show you. The guard that matters here is the one that fails the
 * BUILD, because it survives the person who adds a member without knowing the
 * counters exist. So this takes `never` (compile-time) and does nothing at
 * runtime (safe).
 *
 * ## THE DASHBOARD PAGE'S OWN PROTECTIONS — corrected, and the correction matters
 *
 * An earlier version of this comment said the three switches in
 * `workflows/health/page.tsx` (`stateColor`, `stateBgColor`, `StateIcon`) all
 * need no guard because each is an expression switch with a declared return
 * type. **That was true of two of the three.** Verified by adding a fifth
 * member and reading which lines `tsc` reports:
 *
 *   page.tsx(87)  TS2366  stateColor    — caught, declared `: string`
 *   page.tsx(96)  TS2366  stateBgColor  — caught, declared `: string`
 *   page.tsx(80)  TS2741  a `Record<HealthState, number>` literal — caught
 *   page.tsx(105)         StateIcon     — NOT REPORTED
 *
 * `StateIcon` has NO declared return type. TypeScript infers
 * `Element | undefined` and raises nothing, so it is **not independently
 * protected**. It is safe today only because its first line calls
 * `stateColor(state)`, and that sibling — in the same file — fails first.
 * Safe by cohabitation, not by its own signature.
 *
 * The enumeration was also short in the other direction: the `Record<HealthState,
 * number>` literal at :80 is a third independent guard that was not counted.
 *
 * Adding a return annotation to `StateIcon` would make it self-protecting and is
 * a post-merge cleanup, ruled not a new head.
 *
 * **Why this paragraph was worth its own successor:** the PR body carrying this
 * same claim was corrected append-only, and that was not enough. A body is read
 * once at review; a source comment is read at every future refactor. Correcting
 * the conversation is not correcting the artifact, and the durable copy of a
 * falsehood is the one that ships in the code.
 *
 * Only the statement-position counter switches were unprotected.
 */
function assertCounted(_state: never): void {
  /* compile-time only, deliberately no runtime effect — see above */
}

export interface CronHealth {
  /** Agent that owns this cron. */
  agent: string;
  /** Org the agent belongs to. */
  org: string;
  /** Name of the cron. */
  cronName: string;
  /** Computed health state. */
  state: HealthState;
  /** Human-readable explanation, e.g. "last fire 3h ago, expected within 90m". */
  reason: string;
  /** Unix ms of the most recent fire attempt; null if never fired. */
  lastFire: number | null;
  /** Kind of the most recent fire, or null for legacy/no history. */
  lastFireKind: CronFireKind | null;
  /** Expected interval in ms (derived from schedule); 0 if not parseable (cron expr). */
  expectedIntervalMs: number;
  /** Gap (now - lastFire) in ms; null if never fired. */
  gapMs: number | null;
  /** Fraction of fires in the last 24h that succeeded (0–1). 1.0 if no fires. */
  successRate24h: number;
  /** Raw count of fire attempts in the last 24h. */
  firesLast24h: number;
  /** ISO string of nextFire from the CronSummaryRow. */
  nextFire: string;
}

// Per-agent summary used by the fleet-health IPC response.
export interface AgentHealthSummary {
  agent: string;
  org: string;
  total: number;
  healthy: number;
  warning: number;
  failure: number;
  neverFired: number;
}

export interface FleetHealthResult {
  rows: CronHealth[];
  summary: {
    total: number;
    healthy: number;
    warning: number;
    failure: number;
    neverFired: number;
    agents: Record<string, AgentHealthSummary>;
  };
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Multiplier: a cron is "warning" when gap > WARNING_MULTIPLIER × expectedIntervalMs */
export const WARNING_MULTIPLIER = 2;

/** Grace period for one-shot crons (ms): 10 minutes past fire_at before becoming warning */
const ONCE_GRACE_MS = 10 * 60 * 1000;

const MS_24H = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Core helper
// ---------------------------------------------------------------------------

/**
 * Compute health for a single cron given its summary row and recent executions.
 *
 * @param row               - CronSummaryRow from list-all-crons / listAllCrons().
 * @param executionsLast24h - All execution log entries for this cron in the last 24h.
 *                            Caller is responsible for pre-filtering to the cron + time window.
 * @param nowMs             - Epoch ms for "now" (injectable for deterministic tests).
 */
export function computeHealth(
  row: CronSummaryRow,
  executionsLast24h: CronExecutionLogEntry[],
  nowMs = Date.now(),
): CronHealth {
  const { agent, org, cron, lastFire: lastFireTs, lastStatus, lastFireKind, nextFire } = row;

  // ── Derived timing values ──────────────────────────────────────────────────

  const lastFireMs: number | null = lastFireTs ? new Date(lastFireTs).getTime() : null;
  const gapMs: number | null = lastFireMs !== null ? nowMs - lastFireMs : null;

  // Expected interval: derive from schedule.
  // parseDurationMs returns NaN for cron expressions — treat those as 0 (unknown).
  const expectedIntervalMs = Math.max(0, parseDurationMs(cron.schedule) || 0);

  // ── 24h metrics ───────────────────────────────────────────────────────────

  const firesLast24h = executionsLast24h.length;
  const successCount = executionsLast24h.filter(e => e.status === 'fired' || e.status === 'confirmed').length;
  const successRate24h = firesLast24h > 0 ? successCount / firesLast24h : 1;

  // ── State machine ─────────────────────────────────────────────────────────

  // Check for one-shot cron that hasn't fired yet but is scheduled in the future
  if (lastFireMs === null && cron.fire_at) {
    const fireAtMs = new Date(cron.fire_at).getTime();
    if (!isNaN(fireAtMs)) {
      if (nowMs < fireAtMs + ONCE_GRACE_MS) {
        // Still within grace window — healthy
        return makeHealth(agent, org, cron.name, nextFire, 'healthy',
          `one-shot scheduled in the future (fire_at: ${cron.fire_at})`,
          lastFireMs, lastFireKind, expectedIntervalMs, gapMs, successRate24h, firesLast24h);
      }
      // Past grace window, never fired — fall through to never-fired
    }
  }

  // never-fired: no execution log entry at all
  if (lastFireMs === null) {
    return makeHealth(agent, org, cron.name, nextFire, 'never-fired',
      'cron has never fired — no execution history',
      lastFireMs, lastFireKind, expectedIntervalMs, gapMs, successRate24h, firesLast24h);
  }

  // failure: most recent status is 'failed' AND no later success in log
  if (lastStatus === 'failed') {
    return makeHealth(agent, org, cron.name, nextFire, 'failure',
      `most recent execution failed (${formatRelativeMs(gapMs!)} ago)`,
      lastFireMs, lastFireKind, expectedIntervalMs, gapMs, successRate24h, firesLast24h);
  }

  if (lastStatus === 'noop_persistent') {
    return makeHealth(agent, org, cron.name, nextFire, 'failure',
      'persistent cron no-op detected after re-inject verification',
      lastFireMs, lastFireKind, expectedIntervalMs, gapMs, successRate24h, firesLast24h);
  }

  if (lastStatus === 'noop_unconfirmed' || lastStatus === 'noop_reinjected') {
    return makeHealth(agent, org, cron.name, nextFire, 'warning',
      `most recent cron fire was not confirmed by transcript detector (${lastStatus})`,
      lastFireMs, lastFireKind, expectedIntervalMs, gapMs, successRate24h, firesLast24h);
  }

  // warning: gap > 2x expected interval (only applies when interval is known)
  if (expectedIntervalMs > 0 && gapMs !== null && gapMs > WARNING_MULTIPLIER * expectedIntervalMs) {
    const expectedLabel = formatMs(expectedIntervalMs);
    const gapLabel = formatMs(gapMs);
    return makeHealth(agent, org, cron.name, nextFire, 'warning',
      `last fire ${gapLabel} ago, expected within ${expectedLabel} (2x threshold exceeded)`,
      lastFireMs, lastFireKind, expectedIntervalMs, gapMs, successRate24h, firesLast24h);
  }

  // healthy
  const gapLabel = gapMs !== null ? `${formatRelativeMs(gapMs)} ago` : 'never';
  return makeHealth(agent, org, cron.name, nextFire, 'healthy',
    `last fired ${gapLabel}`,
    lastFireMs, lastFireKind, expectedIntervalMs, gapMs, successRate24h, firesLast24h);
}

// ---------------------------------------------------------------------------
// Fleet aggregation
// ---------------------------------------------------------------------------

/**
 * Aggregate an array of CronHealth rows into a FleetHealthResult.
 * Pure — no I/O.
 */
export function aggregateFleetHealth(rows: CronHealth[]): FleetHealthResult {
  const summary = {
    total: rows.length,
    healthy: 0,
    warning: 0,
    failure: 0,
    neverFired: 0,
    agents: {} as Record<string, AgentHealthSummary>,
  };

  for (const row of rows) {
    // Top-level counters
    switch (row.state) {
      case 'healthy':    summary.healthy++;    break;
      case 'warning':    summary.warning++;    break;
      case 'failure':    summary.failure++;    break;
      case 'never-fired': summary.neverFired++; break;
      default: assertCounted(row.state);
    }

    // Per-agent breakdown
    if (!summary.agents[row.agent]) {
      summary.agents[row.agent] = {
        agent: row.agent,
        org: row.org,
        total: 0,
        healthy: 0,
        warning: 0,
        failure: 0,
        neverFired: 0,
      };
    }
    const agentSummary = summary.agents[row.agent];
    agentSummary.total++;
    switch (row.state) {
      case 'healthy':    agentSummary.healthy++;    break;
      case 'warning':    agentSummary.warning++;    break;
      case 'failure':    agentSummary.failure++;    break;
      case 'never-fired': agentSummary.neverFired++; break;
      default: assertCounted(row.state);
    }
  }

  return { rows, summary };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function makeHealth(
  agent: string,
  org: string,
  cronName: string,
  nextFire: string,
  state: HealthState,
  reason: string,
  lastFire: number | null,
  lastFireKind: CronFireKind | null,
  expectedIntervalMs: number,
  gapMs: number | null,
  successRate24h: number,
  firesLast24h: number,
): CronHealth {
  return {
    agent,
    org,
    cronName,
    state,
    reason,
    lastFire,
    lastFireKind,
    expectedIntervalMs,
    gapMs,
    successRate24h,
    firesLast24h,
    nextFire,
  };
}

/** Format a duration in ms as a compact human string: "3h", "45m", "2d". */
function formatMs(ms: number): string {
  if (ms >= 86_400_000) return `${Math.round(ms / 86_400_000)}d`;
  if (ms >= 3_600_000)  return `${Math.round(ms / 3_600_000)}h`;
  if (ms >= 60_000)     return `${Math.round(ms / 60_000)}m`;
  return `${ms}ms`;
}

/** Format a positive gap in ms as "3h 12m" style. */
function formatRelativeMs(ms: number): string {
  if (ms >= 86_400_000) {
    const d = Math.floor(ms / 86_400_000);
    const h = Math.floor((ms % 86_400_000) / 3_600_000);
    return h > 0 ? `${d}d ${h}h` : `${d}d`;
  }
  if (ms >= 3_600_000) {
    const h = Math.floor(ms / 3_600_000);
    const m = Math.floor((ms % 3_600_000) / 60_000);
    return m > 0 ? `${h}h ${m}m` : `${h}h`;
  }
  if (ms >= 60_000) {
    const m = Math.floor(ms / 60_000);
    return `${m}m`;
  }
  return `${Math.round(ms / 1000)}s`;
}
