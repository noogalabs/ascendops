/**
 * tests/unit/utils/dormancy.test.ts
 *
 * Unit tests for computeDormancy() and parseHeartbeatIntervalMs() — the pure
 * silent-dormancy predicate and its schedule parser. No I/O — all inputs
 * (including `nowMs`) are injected. Every numeric expectation is DERIVED from
 * the exported constants so the tests stay valid if the constants change.
 *
 * The staleness threshold is now ADDITIVE and cadence-relative:
 *   thresholdMs = max(BOOT_GRACE_MS, interval + JITTER_MARGIN_MS)
 * where `interval` is the agent's OWN configured heartbeat cadence, or
 * FALLBACK_INTERVAL_MS when it cannot be determined.
 */

import { describe, it, expect } from 'vitest';
import {
  computeDormancy,
  parseHeartbeatIntervalMs,
  BOOT_GRACE_MS,
  JITTER_MARGIN_MS,
  FALLBACK_INTERVAL_MS,
  type DormancyInput,
} from '../../../src/utils/dormancy';

// Fixed injected "now". Value is arbitrary — nothing reads the wall clock.
const NOW = 1_000_000_000_000;

const ONE_MIN = 60 * 1000;
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

// A representative real multi-hour cadence (heartbeat = "4h").
const INTERVAL_4H = 4 * HOUR;

/** The threshold the helper derives for a given interval (null ⇒ fallback). */
function thresholdFor(intervalMs: number | null): number {
  const interval = intervalMs ?? FALLBACK_INTERVAL_MS;
  return Math.max(BOOT_GRACE_MS, interval + JITTER_MARGIN_MS);
}

// Default threshold used by the base() fixture (4h cadence).
const THRESHOLD = thresholdFor(INTERVAL_4H);

function base(overrides: Partial<DormancyInput>): DormancyInput {
  return {
    agent: 'agent-x',
    org: 'testorg',
    enabled: true,
    mapped: true,
    nowMs: NOW,
    lastSeenMs: NOW, // fresh by default
    uptimeMs: THRESHOLD + 10 * ONE_MIN, // well past grace + threshold by default
    daemonUptimeMs: THRESHOLD + 10 * ONE_MIN,
    expectedIntervalMs: INTERVAL_4H,
    ...overrides,
  };
}

describe('computeDormancy — threshold derivation (additive, cadence-relative)', () => {
  it('threshold is interval + JITTER_MARGIN_MS (additive, not a multiplier)', () => {
    const r = computeDormancy(base({ expectedIntervalMs: INTERVAL_4H }));
    expect(r.thresholdMs).toBe(INTERVAL_4H + JITTER_MARGIN_MS);
  });

  it('a longer cadence widens the threshold by exactly the same fixed margin', () => {
    const shortR = computeDormancy(base({ expectedIntervalMs: HOUR }));
    const longR = computeDormancy(base({ expectedIntervalMs: 8 * HOUR }));
    // Additive: the gap between the two thresholds equals the gap between the
    // two cadences (7h), NOT a multiplied blow-up. A multiplier would make the
    // difference scale as MULTIPLIER × 7h.
    expect(longR.thresholdMs - shortR.thresholdMs).toBe(7 * HOUR);
    expect(longR.thresholdMs).toBe(8 * HOUR + JITTER_MARGIN_MS);
  });

  it('the JITTER margin is exactly 45 minutes', () => {
    expect(JITTER_MARGIN_MS).toBe(45 * ONE_MIN);
  });

  it('null interval falls back to FALLBACK_INTERVAL_MS (24h) + margin', () => {
    const r = computeDormancy(base({ expectedIntervalMs: null }));
    expect(r.thresholdMs).toBe(FALLBACK_INTERVAL_MS + JITTER_MARGIN_MS);
    expect(FALLBACK_INTERVAL_MS).toBe(24 * HOUR);
  });

  it('undefined interval falls back to FALLBACK_INTERVAL_MS + margin', () => {
    const r = computeDormancy(base({ expectedIntervalMs: undefined }));
    expect(r.thresholdMs).toBe(FALLBACK_INTERVAL_MS + JITTER_MARGIN_MS);
  });

  it('POSITIVE CONTROL: the 45m margin is load-bearing — a within-margin stale beat is NOT dormant', () => {
    // Heartbeat is stale by interval + 44min — a HARDCODED age (deliberately NOT
    // derived from JITTER_MARGIN_MS, so it does not move if the constant is
    // mutated). With the real 45m margin the threshold is interval + 45m and this
    // age (interval + 44m) is inside it ⇒ healthy. If JITTER_MARGIN_MS were
    // removed (threshold collapsed to `interval`), interval + 44m would exceed
    // the threshold and this assertion would flip to dormant.
    const interval = HOUR;
    const r = computeDormancy(base({
      expectedIntervalMs: interval,
      lastSeenMs: NOW - (interval + 44 * ONE_MIN),
      uptimeMs: 10 * DAY,
    }));
    expect(r.dormant).toBe(false);
  });

  it('boundary is strict `>`: heartbeat stale by exactly the threshold is NOT dormant', () => {
    const r = computeDormancy(base({
      expectedIntervalMs: INTERVAL_4H,
      lastSeenMs: NOW - THRESHOLD, // exactly at threshold
      uptimeMs: 10 * DAY,          // uptime far past threshold so the clamp is inert
    }));
    expect(r.ageMs).toBe(THRESHOLD);
    expect(r.dormant).toBe(false);
  });

  it('one ms past the threshold IS dormant', () => {
    const r = computeDormancy(base({
      expectedIntervalMs: INTERVAL_4H,
      lastSeenMs: NOW - (THRESHOLD + 1),
      uptimeMs: 10 * DAY,
    }));
    expect(r.dormant).toBe(true);
  });
});

describe('computeDormancy — Face A (mapped, uptime baseline)', () => {
  it('mapped + frozen heartbeat + enabled + past grace ⇒ dormant', () => {
    const r = computeDormancy(base({
      mapped: true,
      lastSeenMs: NOW - (THRESHOLD + ONE_MIN), // stale beyond threshold
      uptimeMs: THRESHOLD + 10 * ONE_MIN,      // up long enough to see the staleness
    }));
    expect(r.dormant).toBe(true);
    expect(r.mapped).toBe(true);
    expect(r.reason).toContain('mapped');
  });

  it('fresh mapped agent with uptime below grace ⇒ NOT dormant (boot-grace floor / Face-A bounce guard)', () => {
    const r = computeDormancy(base({
      mapped: true,
      uptimeMs: BOOT_GRACE_MS - ONE_MIN,        // still inside boot grace
      lastSeenMs: NOW - (THRESHOLD + ONE_MIN),  // heartbeat would otherwise be stale
    }));
    expect(r.dormant).toBe(false);
  });

  it('healthy recent heartbeat ⇒ NOT dormant', () => {
    const r = computeDormancy(base({
      mapped: true,
      lastSeenMs: NOW - ONE_MIN, // one minute ago, well within threshold
      uptimeMs: THRESHOLD + 10 * ONE_MIN,
    }));
    expect(r.dormant).toBe(false);
  });

  it('staleness is locked to the baseline (uptime), not wall-clock', () => {
    // Heartbeat is ancient in wall-clock terms, but the agent has only been up
    // a little past grace (still under threshold). Clamping to uptime keeps it
    // healthy — proves the min(., uptimeMs) mechanism.
    const r = computeDormancy(base({
      mapped: true,
      lastSeenMs: NOW - 10 * THRESHOLD,      // wall-clock age >> threshold
      uptimeMs: BOOT_GRACE_MS + ONE_MIN,     // past grace but under threshold
    }));
    expect(r.dormant).toBe(false);
    // The reported age is clamped to uptime, not the raw wall-clock gap.
    expect(r.ageMs).toBe(BOOT_GRACE_MS + ONE_MIN);
  });

  it('disabled mapped agent ⇒ never dormant', () => {
    const r = computeDormancy(base({
      mapped: true,
      enabled: false,
      lastSeenMs: NOW - (THRESHOLD + ONE_MIN),
      uptimeMs: THRESHOLD + 10 * ONE_MIN,
    }));
    expect(r.dormant).toBe(false);
  });

  it('mapped agent with no uptime yet ⇒ NOT dormant', () => {
    const r = computeDormancy(base({
      mapped: true,
      uptimeMs: null,
      lastSeenMs: null,
    }));
    expect(r.dormant).toBe(false);
  });
});

describe('computeDormancy — Face B (unmapped/absent, daemon-uptime baseline)', () => {
  it('unmapped + stale heartbeat + enabled + past daemon grace ⇒ dormant (gate ignores mapped)', () => {
    const r = computeDormancy(base({
      mapped: false,
      uptimeMs: null, // no agent uptime — it is absent from the map
      lastSeenMs: NOW - (THRESHOLD + ONE_MIN),
      daemonUptimeMs: THRESHOLD + 10 * ONE_MIN,
    }));
    expect(r.dormant).toBe(true);
    expect(r.mapped).toBe(false);
    expect(r.reason).toContain('unmapped');
  });

  it('never-heartbeating absent agent past daemon grace ⇒ dormant', () => {
    // null last-seen is treated as "stale for the whole daemon uptime".
    const r = computeDormancy(base({
      mapped: false,
      uptimeMs: null,
      lastSeenMs: null,
      daemonUptimeMs: THRESHOLD + ONE_MIN, // exceeds threshold
    }));
    expect(r.dormant).toBe(true);
  });

  it('fresh daemon (uptime below grace) + absent stale agent ⇒ NOT dormant (fleet-bounce guard)', () => {
    const r = computeDormancy(base({
      mapped: false,
      uptimeMs: null,
      lastSeenMs: NOW - (THRESHOLD + ONE_MIN), // heartbeat is genuinely stale
      daemonUptimeMs: BOOT_GRACE_MS - ONE_MIN, // but the daemon just started
    }));
    expect(r.dormant).toBe(false);
  });

  it('Face B uses the daemon-uptime baseline in its reason string', () => {
    const r = computeDormancy(base({
      mapped: false,
      uptimeMs: null,
      lastSeenMs: NOW - (THRESHOLD + ONE_MIN),
      daemonUptimeMs: THRESHOLD + 10 * ONE_MIN,
    }));
    expect(r.baselineMs).toBe(THRESHOLD + 10 * ONE_MIN);
    expect(r.reason).toContain('daemon up');
  });

  it('disabled absent agent ⇒ never dormant', () => {
    const r = computeDormancy(base({
      mapped: false,
      enabled: false,
      uptimeMs: null,
      lastSeenMs: NOW - (THRESHOLD + ONE_MIN),
      daemonUptimeMs: THRESHOLD + 10 * ONE_MIN,
    }));
    expect(r.dormant).toBe(false);
  });
});

describe('parseHeartbeatIntervalMs — interval shorthand', () => {
  it('Nh → hours', () => {
    expect(parseHeartbeatIntervalMs('4h')).toBe(4 * HOUR);
    expect(parseHeartbeatIntervalMs('1h')).toBe(HOUR);
  });

  it('Nm → minutes', () => {
    expect(parseHeartbeatIntervalMs('20m')).toBe(20 * ONE_MIN);
    expect(parseHeartbeatIntervalMs('30m')).toBe(30 * ONE_MIN);
  });

  it('Nd → days', () => {
    expect(parseHeartbeatIntervalMs('1d')).toBe(DAY);
    expect(parseHeartbeatIntervalMs('2d')).toBe(2 * DAY);
  });

  it('leading/trailing whitespace is tolerated', () => {
    expect(parseHeartbeatIntervalMs('  4h  ')).toBe(4 * HOUR);
  });

  it('zero and non-numeric shorthand → null', () => {
    expect(parseHeartbeatIntervalMs('0h')).toBeNull();
    expect(parseHeartbeatIntervalMs('h')).toBeNull();
  });
});

describe('parseHeartbeatIntervalMs — every-N-hours cron', () => {
  it('"<min> */N * * *" → N hours', () => {
    expect(parseHeartbeatIntervalMs('0 */6 * * *')).toBe(6 * HOUR);
    expect(parseHeartbeatIntervalMs('30 */4 * * *')).toBe(4 * HOUR);
    expect(parseHeartbeatIntervalMs('0 */1 * * *')).toBe(HOUR);
  });

  it('POSITIVE CONTROL: */N cron yields the tight parsed threshold — breaking the parse drops to the 24h fallback and flips dormancy', () => {
    // A 4h-stepped cron parses to a 4h cadence ⇒ threshold 4h45m. A heartbeat
    // stale by just over that IS dormant. If the every-N-hours parse regressed
    // to null, the interval would fall to FALLBACK_INTERVAL_MS (24h) ⇒ threshold
    // 24h45m, the same ~4h46m age would be well within it, and this assertion
    // would flip to false.
    const interval = parseHeartbeatIntervalMs('0 */4 * * *');
    expect(interval).toBe(4 * HOUR); // guard: the parse must be tight
    const r = computeDormancy(base({
      expectedIntervalMs: interval,
      lastSeenMs: NOW - (4 * HOUR + JITTER_MARGIN_MS + ONE_MIN), // just past 4h45m
      uptimeMs: 10 * DAY,
    }));
    expect(r.dormant).toBe(true);
  });
});

describe('parseHeartbeatIntervalMs — unparseable ⇒ null (caller falls back)', () => {
  it('specific-hour and day-of-week cron expressions → null', () => {
    expect(parseHeartbeatIntervalMs('0 8 * * *')).toBeNull();       // daily at 08:00
    expect(parseHeartbeatIntervalMs('0 0,6,12,18 * * *')).toBeNull(); // hour list
    expect(parseHeartbeatIntervalMs('0 16 * * 1')).toBeNull();      // Mondays
    expect(parseHeartbeatIntervalMs('*/5 * * * *')).toBeNull();     // every 5 min (not every-N-hours)
  });

  it('weeks shorthand (unsupported), garbage, empty, null, undefined → null', () => {
    expect(parseHeartbeatIntervalMs('2w')).toBeNull();
    expect(parseHeartbeatIntervalMs('garbage')).toBeNull();
    expect(parseHeartbeatIntervalMs('')).toBeNull();
    expect(parseHeartbeatIntervalMs('   ')).toBeNull();
    expect(parseHeartbeatIntervalMs(null)).toBeNull();
    expect(parseHeartbeatIntervalMs(undefined)).toBeNull();
  });
});
