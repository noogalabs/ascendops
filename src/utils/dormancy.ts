/**
 * dormancy.ts — Pure silent-dormancy predicate for the agent status surface.
 *
 * Silent dormancy = an ENABLED agent whose activity signal (heartbeat) is stale
 * RELATIVE TO its own liveness baseline, while nothing surfaces it.
 *
 * This module is intentionally side-effect-free and has no I/O dependencies so
 * it can be unit-tested exhaustively with an injected `nowMs`. It mirrors the
 * shape of cron-health.ts.
 *
 * One defect, two faces — the ONLY difference is which liveness baseline applies:
 *
 *   Face A — mapped agent (present in getAllStatuses)
 *     baseline = the agent's own process uptime. Staleness is clamped to uptime
 *     so a fleet bounce cannot flag the whole fleet.
 *
 *   Face B — enabled agent ABSENT from the mapped set (roster-diff)
 *     no agent uptime exists, so baseline = time since DAEMON start. Catches the
 *     never-spawned / dropped-from-map case. Daemon-start grace is the bounce
 *     guard for this face.
 *
 * `mapped` is NEVER part of the predicate — it only selects which baseline
 * applies and is echoed into the reason string.
 *
 * Named residuals (advisory-only surface — no action is taken on any of these):
 *   (a) Agents with no `heartbeat` cron fall to
 *       the 24h fallback and are effectively not caught — and may not even be
 *       "dormant": they can be event-driven rather than beat-driven.
 *   (b) Agents whose `heartbeat` cron uses a schedule form the parser cannot
 *       read also fall to the 24h fallback.
 *   (c) Sub-cadence dormancy (a stall shorter than interval + margin) is
 *       undetectable BY DESIGN at these cadences — the margin is the price of
 *       not false-flagging normal jitter.
 *   (d) The 24h fallback is a conservative, UNVALIDATED ceiling (see
 *       FALLBACK_INTERVAL_MS); durable per-agent cadence measurement is a
 *       tracked follow-up.
 *   (e) A genuinely-idle agent stuck in a single >45m turn exactly when its
 *       beat is due could receive one spurious advisory flag. Status-surface
 *       only — nothing acts on it.
 */

// ---------------------------------------------------------------------------
// Constants — all review-tunable proposals, NOT final.
// ---------------------------------------------------------------------------

/** Below this uptime (Face A) / daemon uptime (Face B) an agent is never flagged. */
export const BOOT_GRACE_MS = 15 * 60 * 1000; // 15 min

/**
 * Additive slack added to an agent's OWN configured heartbeat cadence to get the
 * staleness threshold. It is ADDITIVE, not a multiplier, on purpose: the jitter
 * that delays a beat is ~constant wall-clock (a heartbeat cron whose fire lands
 * behind a long agent turn is late by roughly one turn, regardless of whether
 * the cadence is 20m or 4h). A multiplier would scale this fixed slack with the
 * cadence and silently flag slow-cadence agents for most of every cycle — the
 * exact defect this fix removes.
 */
export const JITTER_MARGIN_MS = 45 * 60 * 1000; // 45 min

/**
 * Fallback expected heartbeat interval, used ONLY when an agent's real cadence
 * cannot be parsed (no `heartbeat` cron, or a cron form the parser can't read).
 *
 * ⚠ CONSERVATIVE, UNVALIDATED best-estimate CEILING — NOT a measured
 * zero-false-positive number. It is deliberately large so the fallback path
 * almost never emits a spurious advisory flag; the cost is that a genuinely
 * dormant agent on this path is caught late (or, if it is purely event-driven
 * and legitimately heals-idle beyond 24h, not caught at all). Durable
 * measurement of real per-agent cadences is a tracked follow-up.
 */
export const FALLBACK_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 h

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface DormancyInput {
  /** Agent name (for the result/reason only). */
  agent: string;
  /** Org the agent belongs to (optional; echoed through). */
  org?: string;
  /** Whether the agent is enabled. A disabled agent is never dormant. */
  enabled: boolean;
  /** True = mapped (Face A, uptime baseline); false = enabled-but-absent (Face B). */
  mapped: boolean;
  /** Epoch ms for "now" (injectable for deterministic tests). */
  nowMs: number;
  /** Epoch ms of the last heartbeat; null if never seen. */
  lastSeenMs: number | null;
  /** Agent process uptime in ms (Face A baseline); null when unmapped. */
  uptimeMs: number | null;
  /** Time since daemon start in ms (Face B baseline). */
  daemonUptimeMs: number;
  /** Expected heartbeat interval in ms; falls back to FALLBACK_INTERVAL_MS when null/undefined. */
  expectedIntervalMs?: number | null;
}

export interface DormancyResult {
  agent: string;
  org?: string;
  dormant: boolean;
  mapped: boolean;
  /** Human string containing the mapped/unmapped word + the age/threshold numbers. */
  reason: string;
  /** Staleness threshold used (ms). */
  thresholdMs: number;
  /** The staleness age measured against the baseline (ms). */
  ageMs: number;
  /** The liveness baseline used: uptime (Face A) or daemon uptime (Face B) (ms). */
  baselineMs: number;
}

// ---------------------------------------------------------------------------
// Core helper
// ---------------------------------------------------------------------------

/**
 * Compute silent-dormancy for a single agent. Pure — no I/O.
 *
 * Both faces derive their threshold identically; they differ only in the
 * baseline and staleness measure. The `mapped` flag selects the face.
 */
export function computeDormancy(input: DormancyInput): DormancyResult {
  const interval = input.expectedIntervalMs ?? FALLBACK_INTERVAL_MS;
  const thresholdMs = Math.max(BOOT_GRACE_MS, interval + JITTER_MARGIN_MS);

  if (input.mapped) {
    // Face A — baseline is the agent's own uptime. Staleness is clamped to
    // uptime (the min(., uptimeMs) below) so a fleet bounce, where every
    // agent's uptime is small, cannot report the whole fleet as stale.
    const uptimeMs = input.uptimeMs;
    const baselineMs = uptimeMs ?? 0;
    const sinceLastBeat = input.lastSeenMs == null
      ? baselineMs
      : Math.min(input.nowMs - input.lastSeenMs, baselineMs);
    const dormant =
      input.enabled && uptimeMs != null && uptimeMs > BOOT_GRACE_MS && sinceLastBeat > thresholdMs;
    const reason = `mapped agent, heartbeat ${formatMs(sinceLastBeat)} stale vs ${formatMs(thresholdMs)} threshold (uptime ${formatMs(baselineMs)})`;
    return { agent: input.agent, org: input.org, dormant, mapped: true, reason, thresholdMs, ageMs: sinceLastBeat, baselineMs };
  }

  // Face B — baseline is time since daemon start. A never-heartbeating absent
  // agent is treated as stale for the whole daemon uptime. The daemon-start
  // grace is the bounce guard: an agent briefly absent-from-map mid-bounce
  // (daemon uptime still under grace) must NOT flag.
  const daemonUptimeMs = input.daemonUptimeMs;
  const heartbeatAgeMs = input.lastSeenMs == null ? daemonUptimeMs : input.nowMs - input.lastSeenMs;
  const dormant = input.enabled && daemonUptimeMs > BOOT_GRACE_MS && heartbeatAgeMs > thresholdMs;
  const reason = `unmapped agent (enabled but absent from map), heartbeat ${formatMs(heartbeatAgeMs)} stale vs ${formatMs(thresholdMs)} threshold (daemon up ${formatMs(daemonUptimeMs)})`;
  return { agent: input.agent, org: input.org, dormant, mapped: false, reason, thresholdMs, ageMs: heartbeatAgeMs, baselineMs: daemonUptimeMs };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Format a duration in ms as a compact human string: "3h", "45m", "2d". */
function formatMs(ms: number): string {
  if (ms >= 86_400_000) return `${Math.round(ms / 86_400_000)}d`;
  if (ms >= 3_600_000)  return `${Math.round(ms / 3_600_000)}h`;
  if (ms >= 60_000)     return `${Math.round(ms / 60_000)}m`;
  return `${ms}ms`;
}

// ---------------------------------------------------------------------------
// Heartbeat schedule parser — pure, no I/O
// ---------------------------------------------------------------------------

//
// Parse a cron `schedule` string into an expected interval in ms, or null when
// the cadence cannot be determined (caller then falls back to
// FALLBACK_INTERVAL_MS).
//
// Recognized forms — deliberately narrow so an ambiguous schedule fails to
// `null` rather than yielding a wrong (and silently trusted) cadence:
//   - Interval shorthand: "Nh" / "Nm" / "Nd"  (e.g. "4h" -> 14_400_000).
//   - Every-N-hours 5-field cron "<min> [star][slash]N [star] [star] [star]"
//     (fixed minute, stepped hour, wildcard day/month/dow) -> N x 3_600_000.
//
// Everything else — arbitrary cron expressions (specific hour lists,
// day-of-week schedules, minute steps), unrecognized text, empty,
// null/undefined — returns null. A schedule the parser cannot read is a named
// residual: the agent falls to the 24h fallback and is not caught at its true
// cadence.
//
export function parseHeartbeatIntervalMs(schedule: string | null | undefined): number | null {
  if (schedule == null) return null;
  const s = schedule.trim();
  if (s === '') return null;

  // Interval shorthand: Nh / Nm / Nd.
  const shorthand = /^(\d+)([hmd])$/.exec(s);
  if (shorthand) {
    const n = Number(shorthand[1]);
    if (n <= 0) return null;
    const unit = shorthand[2];
    const mult = unit === 'h' ? 3_600_000 : unit === 'm' ? 60_000 : 86_400_000;
    return n * mult;
  }

  // Every-N-hours 5-field cron: "<min> */N * * *" — a fixed minute, a stepped
  // hour, and wildcard day-of-month / month / day-of-week.
  const everyNHours = /^\d+\s+\*\/(\d+)\s+\*\s+\*\s+\*$/.exec(s);
  if (everyNHours) {
    const n = Number(everyNHours[1]);
    if (n > 0) return n * 3_600_000;
  }

  return null;
}
