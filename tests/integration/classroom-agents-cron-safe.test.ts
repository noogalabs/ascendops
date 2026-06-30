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
import { join, sep } from 'path';
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
          // Exempt the docs whose JOB is to add the role crons AFTER the agent is
          // configured (not on a fresh/un-onboarded boot): the README ("add after
          // setup") and the ONBOARDING.md / onboarding skill (the interview adds them
          // as its final step, post-configuration). Ship-time config.crons is still []
          // and the fresh-boot scheduler still fires nothing (proven dynamically below).
          const exempt =
            f.endsWith('README.md') ||
            f.endsWith('ONBOARDING.md') ||
            f.includes(`${sep}skills${sep}onboarding${sep}`);
          if (!exempt) offenders.push(f);
        }
      }
      expect(offenders).toEqual([]);
    });

    it(`${b}: ships the onboarding trigger (IDENTITY marker + ONBOARDING.md + onboarding skill)`, () => {
      // The first-boot onboarding interview only fires if the daemon does NOT
      // retro-mark .onboarded. hasCompletedBootstrapContent treats a '<!--' in the
      // IDENTITY '## Name' as "still a template", so the marker keeps the agent
      // un-onboarded on first boot -> buildStartupPrompt injects first-boot ->
      // onboarding skill runs. Guard all three pieces are present.
      const identity = readFileSync(join(bundleDir(b), 'IDENTITY.md'), 'utf-8');
      const nameBlock = /^## Name\s*\n([^\n]*)/m.exec(identity);
      expect(nameBlock?.[1] ?? '').toContain('<!--'); // marker -> not retro-marked onboarded
      expect(existsSync(join(bundleDir(b), 'ONBOARDING.md'))).toBe(true);
      expect(existsSync(join(bundleDir(b), '.claude', 'skills', 'onboarding', 'SKILL.md'))).toBe(true);
    });

    it(`${b}: single .onboarded authority - ONBOARDING.md gates+crons+writes it, onboarding skill defers`, () => {
      // add-agent only fills {{agent_name}}/{{org}}; every other {{...}} (company,
      // operator, owner, timezone, sibling-agent names, role criteria) is filled by
      // the interview, including ones in CLAUDE.md and .claude/skills/**. ONBOARDING.md's
      // final block is the SINGLE completion authority: a hard placeholder+marker gate,
      // then the role crons, then .onboarded - so a member can never end up onboarded
      // with a literal placeholder in Claude's prompt, NOR onboarded-without-crons.
      const onb = readFileSync(join(bundleDir(b), 'ONBOARDING.md'), 'utf-8');
      const skill = readFileSync(join(bundleDir(b), '.claude', 'skills', 'onboarding', 'SKILL.md'), 'utf-8');

      // ONBOARDING.md carries the full gate: greps BOTH {{...}} (format-complete: any
      // placeholder shape) AND the ## Name '<!-- Set during onboarding' marker (every
      // signal the daemon's hasCompletedBootstrapContent keys on); the touch sits inside
      // the if/grep ... fi gate; the gate excludes the self-referencing setup docs (else
      // always-halt).
      expect(onb).toContain("grep -rlE '\\{\\{[^{}]+\\}\\}|<!-- Set during onboarding'");
      expect(onb).toMatch(/if grep -rlE[\s\S]*?touch[^\n]*\.onboarded[\s\S]*?fi/);
      expect(onb).toMatch(/grep -vE '[^']*ONBOARDING\\.md[^']*README\\.md[^']*skills\/onboarding/);

      // SINGLE-AUTHORITY (Codex P2 fix, dual-completion-path): the onboarding skill must
      // NOT write .onboarded itself. A second completion path (a skill-side gate+touch that
      // skips the role crons) let the agent reach onboarded-WITHOUT-crons, and .onboarded
      // suppresses re-onboarding so the crons would never get added. The skill defers to
      // ONBOARDING.md's final block as the one writer.
      expect(skill).not.toMatch(/touch[^\n]*\.onboarded/);
      expect(skill).toContain('ONBOARDING.md');

      // ORDERING (ONBOARDING.md): the add-cron commands live INSIDE the gate's else,
      // AFTER the gate and BEFORE .onboarded - so crons are persisted only when clean,
      // never against a still-templated agent (no cron-persist-before-gate).
      expect(onb).toMatch(/if grep -rlE[\s\S]*?\nelse\n[\s\S]*?add-cron[\s\S]*?touch[^\n]*\.onboarded[\s\S]*?\nfi/);
      // and there is no add-cron OUTSIDE/BEFORE the gate (all crons are in the else)
      const beforeGate = onb.slice(0, onb.indexOf('if grep -rlE'));
      expect(beforeGate).not.toMatch(/cortextos bus add-cron/);
    });

    it(`${b}: MEMORY.md ships with <!-- and ONBOARDING.md strips it atomically between crons and .onboarded`, () => {
      // The daemon retro-write (agent-process.ts:1006-1029) marks an agent onboarded when
      // MEMORY.md is >80 chars AND has no <!--, OR a heartbeat.json exists. The interview
      // fills IDENTITY ## Name early, so MEMORY.md's <!-- comment is the remaining
      // content-guard mid-onboarding. SHIP-TIME the comment MUST be present (the bundle is
      // un-onboarded by content), and it is stripped ONLY in the final &&-chain, AFTER the
      // role crons register and right BEFORE touch .onboarded, so the
      // hasCompletedBootstrapContent window stays closed until the crons exist.
      const memory = readFileSync(join(bundleDir(b), 'MEMORY.md'), 'utf-8');
      expect(memory).toContain('<!--'); // shipped un-onboarded by content

      const onb = readFileSync(join(bundleDir(b), 'ONBOARDING.md'), 'utf-8');
      // the strip targets the EXACT committed comment line (no whitespace drift) so it fires
      const STRIP = "grep -vF '<!-- This memory is written during onboarding and as you work. It starts empty on purpose. -->' MEMORY.md";
      expect(onb).toContain(STRIP);
      // ORDERING: crons (list-crons sits after the last add-cron) -> strip -> touch .onboarded
      expect(onb).toMatch(/list-crons[\s\S]*?grep -vF[^\n]*MEMORY\.md[\s\S]*?touch[^\n]*\.onboarded/);
      // NEGATIVE-CONTROL guard: the strip must NOT sit before the crons - moving it ahead
      // of list-crons reopens the content window mid-onboarding and fails this assertion.
      expect(onb.slice(0, onb.indexOf('list-crons'))).not.toMatch(/grep -vF[^\n]*MEMORY/);
    });
  }

  it('onboarding hard-gate regex covers all trigger signals + is format-complete', () => {
    // the gate greps {{[^{}]+}} OR the ## Name marker - it must HALT on (1) any
    // placeholder format incl future digit/hyphen/uppercase, (2) the unfilled
    // ## Name '<!-- Set during onboarding' marker (the other signal the daemon keys
    // on), and PASS clean text. Guards the membership-vs-completeness gap AND the
    // signal-set-vs-daemon-trigger gap.
    const gate = /\{\{[^{}]+\}\}|<!-- Set during onboarding/;
    expect(gate.test('Owner statements go to {{company_name}} monthly.')).toBe(true);    // placeholder -> refuses
    expect(gate.test('A future placeholder {{Future-Var2}} must be caught too.')).toBe(true); // future format -> refuses
    expect(gate.test('## Name\n<!-- Set during onboarding: pick a name -->')).toBe(true); // unfilled name marker -> refuses
    expect(gate.test('## Name\nQuinn\n\nOwner is Acme Property.')).toBe(false);           // all filled -> allows .onboarded
  });
});

// ---------------------------------------------------------------------------
// Dynamic proof - real CronScheduler, bundle runtime state (no crons.json)
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
