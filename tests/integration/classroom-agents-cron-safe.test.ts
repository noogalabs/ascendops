/**
 * tests/integration/classroom-agents-cron-safe.test.ts
 *
 * Guards the safety contract for the downloadable classroom agent bundles
 * (community/classroom-agents/*-agent-template). These are PUBLIC member
 * downloads. Each ships enabled=true (so a member's added agent actually boots)
 * but MUST ship NO active crons, so a freshly-added, not-yet-configured agent
 * never fires a recurring cron while its bootstrap files still hold
 * {{placeholders}}. The role crons are documented in each README as
 * "add after setup".
 *
 * Static contract (every bundle):
 *   - config.json: enabled === true AND crons === [] (empty)
 *   - no crons.json shipped anywhere in the bundle (that is runtime state)
 *   - no cron-creation / heartbeat-cron / /loop instructions in the bootstrap
 *     docs that would auto-spawn a cron on first boot (all-origins check)
 *
 * Dynamic proof (REAL scheduler, no mocking): a bundle's runtime state is "no
 * crons.json". Boot the real CronScheduler in that state, advance several
 * 30s tick windows with fake timers, and assert onFire is NEVER called.
 * Mirrors agent-bootstrap-crons scenario 2 ("boot without crons.json →
 * scheduler has no entries"), applied to the bundle contract.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const BUNDLES_DIR = join(process.cwd(), 'community', 'classroom-agents');
const BUNDLES = [
  'accounting-agent-template',
  'leasing-coordinator-agent-template',
  'maintenance-coordinator-agent-template',
];
const TICK_MS = 30_000; // CronScheduler.TICK_INTERVAL_MS

function bundleDir(b: string): string {
  return join(BUNDLES_DIR, b);
}

/** Recursively list all files under a dir. */
function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Static contract
// ---------------------------------------------------------------------------

describe('classroom bundles: static cron-safety contract', () => {
  for (const b of BUNDLES) {
    it(`${b}: enabled=true and crons=[]`, () => {
      const cfg = JSON.parse(readFileSync(join(bundleDir(b), 'config.json'), 'utf-8'));
      expect(cfg.enabled).toBe(true); // startable (avoids the enabled=false silent-stop)
      expect(Array.isArray(cfg.crons)).toBe(true);
      expect(cfg.crons).toHaveLength(0); // no active crons on a fresh template
    });

    it(`${b}: ships no crons.json`, () => {
      const cronsJson = walk(bundleDir(b)).filter((f) => f.endsWith('crons.json'));
      expect(cronsJson).toEqual([]);
    });

    it(`${b}: no cron-creation instructions in bootstrap docs`, () => {
      const docs = walk(bundleDir(b)).filter((f) => f.endsWith('.md'));
      const offenders: string[] = [];
      for (const f of docs) {
        const text = readFileSync(f, 'utf-8');
        // Instructions that would make the agent self-spawn a cron on boot.
        if (/CronCreate|bus add-cron|\/loop\s+\{|set up (your )?(a )?(heartbeat )?cron|create (a )?cron/i.test(text)) {
          // README documents "add after setup" with bus add-cron — that is guidance to the
          // human, not a boot-time self-spawn instruction. Exclude the README on that basis.
          if (!f.endsWith('README.md')) offenders.push(f);
        }
      }
      expect(offenders).toEqual([]);
    });
  }
});

// ---------------------------------------------------------------------------
// Dynamic proof — real CronScheduler, bundle runtime state (no crons.json)
// ---------------------------------------------------------------------------

describe('classroom bundles: real scheduler fires zero crons in bundle runtime state', () => {
  let tmpRoot: string;
  const originalCtxRoot = process.env.CTX_ROOT;
  let CronScheduler: typeof import('../../src/daemon/cron-scheduler.js').CronScheduler;

  beforeEach(async () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'classroom-cron-safe-'));
    process.env.CTX_ROOT = tmpRoot;
    vi.useFakeTimers();
    vi.resetModules();
    CronScheduler = (await import('../../src/daemon/cron-scheduler.js')).CronScheduler;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.resetModules();
    if (originalCtxRoot !== undefined) process.env.CTX_ROOT = originalCtxRoot;
    else delete process.env.CTX_ROOT;
    try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('no crons.json (config crons=[] runtime) => zero onFire over many ticks', async () => {
    const fired: string[] = [];
    const logs: string[] = [];
    // A freshly-added bundle agent has crons=[] in config -> no crons.json is
    // written -> this is exactly the scheduler's state. Do not write crons.json.
    const scheduler = new CronScheduler({
      agentName: 'classroom-test-agent',
      onFire: async (cron) => { fired.push(cron.name); },
      logger: (msg) => logs.push(msg),
    });
    scheduler.start();
    // Advance 10 tick windows (5 minutes of simulated time).
    for (let i = 0; i < 10; i++) {
      await vi.advanceTimersByTimeAsync(TICK_MS);
    }
    scheduler.stop?.();
    expect(fired).toEqual([]); // ZERO crons fired
  });
});
