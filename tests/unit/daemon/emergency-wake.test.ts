import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { cronWakesForEmergencyClass } from '../../../src/daemon/agent-manager.js';

/**
 * The Greenwood/TDL50WP post-mortem, as tests.
 *
 * An emergency check-back fired at 2026-08-10T02:00:29Z, was suppressed
 * off-shift, and never reached the agent. The agent's config named exactly which
 * emergencies could wake it — and nothing read that list. These tests exist so
 * the list can never become decorative again.
 */

const BLUE_LIKE = {
  shift_schedule: {
    weekly: { sun: { start: '07:00', end: '21:00' } },
    emergency_override: {
      off_shift_can_wake_for: ['safety', 'flood', 'fire', 'no_heat_freezing'],
    },
  },
} as never;

describe('emergency class wake — the 22:00 flood case', () => {
  it('WAKES for a flood-class cron', () => {
    // The case that was missed: this must now pierce off-shift suppression.
    expect(cronWakesForEmergencyClass({ emergency_class: 'flood' }, BLUE_LIKE)).toBe(true);
  });

  it('does NOT wake for a routine sweep at the same minute', () => {
    // The paired negative. Without it, a function returning true always would
    // pass the test above and quietly disable all suppression.
    expect(cronWakesForEmergencyClass({ emergency_class: undefined }, BLUE_LIKE)).toBe(false);
    expect(cronWakesForEmergencyClass({ emergency_class: 'routine-sweep' }, BLUE_LIKE)).toBe(false);
  });

  it.each(['safety', 'fire', 'no_heat_freezing'])('wakes for declared class %s', (cls) => {
    expect(cronWakesForEmergencyClass({ emergency_class: cls }, BLUE_LIKE)).toBe(true);
  });

  it('matches case-insensitively and ignores surrounding whitespace', () => {
    expect(cronWakesForEmergencyClass({ emergency_class: '  FLOOD ' }, BLUE_LIKE)).toBe(true);
  });

  it('FAILS CLOSED on a near-miss rather than guessing', () => {
    // A cron that believes it is exempt and is not is worse than one that knows
    // it is suppressed, so matching is exact — no prefix, no fuzzy.
    for (const near of ['floods', 'flood-warning', 'fl00d', 'emergency']) {
      expect(cronWakesForEmergencyClass({ emergency_class: near }, BLUE_LIKE)).toBe(false);
    }
  });

  it('FAILS CLOSED on a SUBSTRING of an allowed class', () => {
    // Added after a surviving mutant: swapping `===` for `.includes()` passed
    // every other test here, because all my near-misses were SUPERSTRINGS
    // ('floods' contains 'flood'). A substring is the direction that actually
    // slips through — 'heat' inside 'no_heat_freezing' — and a cron claiming
    // class 'heat' must not inherit a freezing-pipes exemption.
    for (const sub of ['heat', 'freezing', 'ire', 'safe', 'no_heat']) {
      expect(cronWakesForEmergencyClass({ emergency_class: sub }, BLUE_LIKE)).toBe(false);
    }
  });

  it.each([
    ['no emergency_override at all', { shift_schedule: { weekly: {} } }],
    ['empty allow list', { shift_schedule: { emergency_override: { off_shift_can_wake_for: [] } } }],
    ['no shift_schedule', {}],
  ])('fails closed when the agent declares nothing: %s', (_label, cfg) => {
    expect(cronWakesForEmergencyClass({ emergency_class: 'flood' }, cfg as never)).toBe(false);
  });

  it.each([['', 'empty'], ['   ', 'whitespace']])('ignores a %s class (%s)', (cls) => {
    expect(cronWakesForEmergencyClass({ emergency_class: cls }, BLUE_LIKE)).toBe(false);
  });
});

describe('NO-READER REGRESSION — the structural keeper', () => {
  /**
   * Three emergency fields existed in this subsystem and only one had a reader.
   * `off_shift_can_wake_for` and `emergency_allowed` were declared, documented,
   * and consulted by nothing — a safety config that read correctly to a human
   * and was wired to code that never looked at it.
   *
   * These assertions fail the moment any of them loses its reader again. This is
   * the day's whole lesson expressed as a test rather than a memory.
   */
  const SRC = join(dirname(new URL(import.meta.url).pathname), '..', '..', '..', 'src');

  it('off_shift_can_wake_for HAS a reader in the daemon', () => {
    const mgr = readFileSync(join(SRC, 'daemon', 'agent-manager.ts'), 'utf8');
    expect(mgr).toContain('off_shift_can_wake_for');
    expect(mgr).toContain('cronWakesForEmergencyClass');
  });

  it('the suppression evaluator CONSULTS the class reader', () => {
    // Presence of the function is not enough — an unused helper is the same
    // defect one step removed.
    const mgr = readFileSync(join(SRC, 'daemon', 'agent-manager.ts'), 'utf8');
    const evaluator = mgr.slice(mgr.indexOf('private evaluateCronShiftSuppression'));
    expect(evaluator.slice(0, 2000)).toContain('cronWakesForEmergencyClass(cron, agentConfig)');
  });

  it('wake_on_fire is settable from the CLI, not only by hand-editing daemon state', () => {
    const cli = readFileSync(join(SRC, 'cli', 'bus.ts'), 'utf8');
    expect(cli).toContain('--wake-on-fire');
    expect(cli).toContain('wake_on_fire: true');
  });

  it('emergency_class is settable from the CLI', () => {
    const cli = readFileSync(join(SRC, 'cli', 'bus.ts'), 'utf8');
    expect(cli).toContain('--emergency-class');
    expect(cli).toContain('emergency_class: opts.emergencyClass');
  });

  it('the deprecated boolean points at its replacement', () => {
    const types = readFileSync(join(SRC, 'types', 'index.ts'), 'utf8');
    const idx = types.indexOf('emergency_allowed?: boolean');
    expect(idx).toBeGreaterThan(-1);
    expect(types.slice(Math.max(0, idx - 400), idx)).toContain('@deprecated');
    expect(types.slice(Math.max(0, idx - 400), idx)).toContain('emergency_class');
  });
});
