/**
 * tests/integration/crons-migration.test.ts — Subtask 2.2 Integration Tests
 *
 * Covers all acceptance scenarios specified in EXTERNAL_CRONS_PLAN.md § 2.2:
 *
 *  1. Migrate clean agent (config has 4 crons → crons.json has same 4)
 *  2. Idempotency: migrate twice → no duplicates, second run is no-op (marker present)
 *  3. Migrate with --force → re-runs even with marker, overwrites crons.json
 *  4. type:"once" with future fire_at → skipped with explicit log (not representable in CronDefinition)
 *  5. type:"once" with past fire_at → skipped with log
 *  6. Missing `type` field → defaults to recurring
 *  7. Multiple agents migrated via migrateAllAgents()
 *  8. Missing config.json → no-op result, no crash, empty crons.json + marker created
 *  9. Config.json with no crons array → empty crons.json + marker created
 * 10. Field mapping correctness — each migrated CronDefinition matches readCrons() output
 *
 * All tests use temp directories only — no real config.json or crons.json files
 * in the repository are touched.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  existsSync,
} from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// ---------------------------------------------------------------------------
// Types used directly in tests
// ---------------------------------------------------------------------------
import type { CronDefinition } from '../../src/types/index.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const CRONS_DIR = '.cortextOS/state/agents';
const CRONS_FILE = 'crons.json';
const MARKER_FILE = '.crons-migrated';

// ---------------------------------------------------------------------------
// Per-test environment wiring
//
// We reset modules per test so that CTX_ROOT env changes are picked up by
// the crons.ts module (which reads process.env.CTX_ROOT at call time —
// but the join() is inside the function, so it's fine either way).
// ---------------------------------------------------------------------------

let tmpCtxRoot: string;
let tmpFrameworkRoot: string;
const originalCtxRoot = process.env.CTX_ROOT;

// Dynamically imported module references (re-imported per test after vi.resetModules)
let migrateCronsForAgent: typeof import('../../src/daemon/cron-migration.js').migrateCronsForAgent;
let migrateAllAgents: typeof import('../../src/daemon/cron-migration.js').migrateAllAgents;
let isMigrated: typeof import('../../src/daemon/cron-migration.js').isMigrated;
let reloadCronsForAgent: typeof import('../../src/daemon/cron-migration.js').reloadCronsForAgent;
let readCrons: typeof import('../../src/bus/crons.js').readCrons;

async function reloadModules() {
  vi.resetModules();
  const migModule = await import('../../src/daemon/cron-migration.js');
  reloadCronsForAgent = migModule.reloadCronsForAgent;
  migrateCronsForAgent = migModule.migrateCronsForAgent;
  migrateAllAgents = migModule.migrateAllAgents;
  isMigrated = migModule.isMigrated;
  const cronsModule = await import('../../src/bus/crons.js');
  readCrons = cronsModule.readCrons;
}

/**
 * Write a config.json to the agent dir with the given crons array.
 */
function writeConfigJson(agentDir: string, crons: unknown[]): void {
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(
    join(agentDir, 'config.json'),
    JSON.stringify({ agent_name: 'test', enabled: true, crons }),
    'utf-8',
  );
}

/**
 * Read the raw crons.json envelope from disk (bypassing readCrons abstraction).
 */
function rawCronsJson(ctxRoot: string, agentName: string): { updated_at: string; crons: CronDefinition[] } | null {
  const { existsSync: fsExists, readFileSync: fsRead } = require('fs') as typeof import('fs');
  const path = join(ctxRoot, CRONS_DIR, agentName, CRONS_FILE);
  if (!fsExists(path)) return null;
  return JSON.parse(fsRead(path, 'utf-8'));
}

/**
 * Check if marker file exists.
 */
function markerExists(ctxRoot: string, agentName: string): boolean {
  return existsSync(join(ctxRoot, CRONS_DIR, agentName, MARKER_FILE));
}

beforeEach(async () => {
  tmpCtxRoot = mkdtempSync(join(tmpdir(), 'crons-migration-ctx-'));
  tmpFrameworkRoot = mkdtempSync(join(tmpdir(), 'crons-migration-fw-'));
  process.env.CTX_ROOT = tmpCtxRoot;
  await reloadModules();
});

afterEach(() => {
  vi.resetModules();
  if (originalCtxRoot !== undefined) {
    process.env.CTX_ROOT = originalCtxRoot;
  } else {
    delete process.env.CTX_ROOT;
  }
  try { rmSync(tmpCtxRoot, { recursive: true, force: true }); } catch { /* ignore */ }
  try { rmSync(tmpFrameworkRoot, { recursive: true, force: true }); } catch { /* ignore */ }
});

// ---------------------------------------------------------------------------
// Test 1: Migrate clean agent with 4 recurring crons
// ---------------------------------------------------------------------------

describe('migrateCronsForAgent', () => {
  it('migrates all 4 recurring crons from config.json', () => {
    const agentDir = join(tmpFrameworkRoot, 'orgs', 'testorg', 'agents', 'alpha');
    writeConfigJson(agentDir, [
      { name: 'heartbeat', type: 'recurring', interval: '6h', prompt: 'Read HEARTBEAT.md and run it.' },
      { name: 'daily-review', interval: '24h', prompt: 'Review the day.' },
      { name: 'pr-monitor', type: 'recurring', interval: '6h', prompt: 'Scan PRs.' },
      { name: 'weekly', cron: '0 16 * * 1', prompt: 'Weekly report.' },
    ]);

    const result = migrateCronsForAgent('alpha', join(agentDir, 'config.json'), tmpCtxRoot);

    expect(result.status).toBe('migrated');
    expect(result.cronsMigrated).toBe(4);
    expect(result.cronsSkipped).toHaveLength(0);

    const crons = readCrons('alpha');
    expect(crons).toHaveLength(4);

    // Marker must exist
    expect(markerExists(tmpCtxRoot, 'alpha')).toBe(true);
    expect(isMigrated(tmpCtxRoot, 'alpha')).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // Test 2: Idempotency — second run is a no-op
  // ---------------------------------------------------------------------------

  it('is idempotent: second migration run is skipped (marker present, no duplicates)', () => {
    const agentDir = join(tmpFrameworkRoot, 'orgs', 'testorg', 'agents', 'alpha');
    writeConfigJson(agentDir, [
      { name: 'heartbeat', type: 'recurring', interval: '6h', prompt: 'Run heartbeat.' },
    ]);
    const configPath = join(agentDir, 'config.json');

    // First run
    const first = migrateCronsForAgent('alpha', configPath, tmpCtxRoot);
    expect(first.status).toBe('migrated');
    expect(first.cronsMigrated).toBe(1);

    // Second run — must be a no-op
    const second = migrateCronsForAgent('alpha', configPath, tmpCtxRoot);
    expect(second.status).toBe('skipped-already-migrated');

    // Still exactly 1 cron — no duplication
    const crons = readCrons('alpha');
    expect(crons).toHaveLength(1);
    expect(crons[0].name).toBe('heartbeat');

    // Marker still exists
    expect(markerExists(tmpCtxRoot, 'alpha')).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // Test 3: --force flag re-runs migration
  // ---------------------------------------------------------------------------

  it('re-runs migration when force: true (deletes marker first)', () => {
    const agentDir = join(tmpFrameworkRoot, 'orgs', 'testorg', 'agents', 'beta');
    writeConfigJson(agentDir, [
      { name: 'heartbeat', interval: '6h', prompt: 'Run heartbeat.' },
    ]);
    const configPath = join(agentDir, 'config.json');

    // First run
    migrateCronsForAgent('beta', configPath, tmpCtxRoot);
    expect(isMigrated(tmpCtxRoot, 'beta')).toBe(true);

    // Modify config — add a second cron — then force re-run
    writeConfigJson(agentDir, [
      { name: 'heartbeat', interval: '6h', prompt: 'Run heartbeat.' },
      { name: 'daily', interval: '24h', prompt: 'Daily check.' },
    ]);

    const forced = migrateCronsForAgent('beta', configPath, tmpCtxRoot, { force: true });
    expect(forced.status).toBe('migrated');
    expect(forced.cronsMigrated).toBe(2);

    const crons = readCrons('beta');
    expect(crons).toHaveLength(2);
    expect(crons.map(c => c.name)).toContain('daily');

    // Marker exists again after re-migration
    expect(isMigrated(tmpCtxRoot, 'beta')).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // Test 4: type:"once" with future fire_at → skipped with log
  // ---------------------------------------------------------------------------

  it('skips type:"once" with future fire_at (not representable in CronDefinition)', () => {
    const agentDir = join(tmpFrameworkRoot, 'orgs', 'testorg', 'agents', 'gamma');
    const futureTs = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    writeConfigJson(agentDir, [
      { name: 'one-shot', type: 'once', fire_at: futureTs, prompt: 'Do something once.' },
      { name: 'heartbeat', type: 'recurring', interval: '6h', prompt: 'Run heartbeat.' },
    ]);
    const configPath = join(agentDir, 'config.json');

    const logs: string[] = [];
    const result = migrateCronsForAgent('gamma', configPath, tmpCtxRoot, {
      log: (msg) => logs.push(msg),
    });

    expect(result.status).toBe('migrated');
    expect(result.cronsMigrated).toBe(1);
    expect(result.cronsSkipped).toContain('one-shot');

    // one-shot must not appear in crons.json
    const crons = readCrons('gamma');
    expect(crons).toHaveLength(1);
    expect(crons[0].name).toBe('heartbeat');

    // Log must mention the skip reason
    const skipLog = logs.find(l => l.includes('one-shot') && l.includes('skip'));
    expect(skipLog).toBeTruthy();

    expect(markerExists(tmpCtxRoot, 'gamma')).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // Test 5: type:"once" with past fire_at → skipped with log
  // ---------------------------------------------------------------------------

  it('skips type:"once" with past fire_at (already expired)', () => {
    const agentDir = join(tmpFrameworkRoot, 'orgs', 'testorg', 'agents', 'delta');
    const pastTs = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    writeConfigJson(agentDir, [
      { name: 'past-shot', type: 'once', fire_at: pastTs, prompt: 'This already ran.' },
    ]);
    const configPath = join(agentDir, 'config.json');

    const logs: string[] = [];
    const result = migrateCronsForAgent('delta', configPath, tmpCtxRoot, {
      log: (msg) => logs.push(msg),
    });

    expect(result.status).toBe('migrated');
    expect(result.cronsMigrated).toBe(0);
    expect(result.cronsSkipped).toContain('past-shot');

    const crons = readCrons('delta');
    expect(crons).toHaveLength(0);

    const skipLog = logs.find(l => l.includes('past-shot'));
    expect(skipLog).toBeTruthy();

    expect(markerExists(tmpCtxRoot, 'delta')).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // Test 6: Missing `type` field → defaults to recurring
  // ---------------------------------------------------------------------------

  it('treats missing type field as "recurring"', () => {
    const agentDir = join(tmpFrameworkRoot, 'orgs', 'testorg', 'agents', 'epsilon');
    writeConfigJson(agentDir, [
      // No `type` field — should default to recurring
      { name: 'implicit-recurring', interval: '12h', prompt: 'Do the thing.' },
    ]);
    const configPath = join(agentDir, 'config.json');

    const result = migrateCronsForAgent('epsilon', configPath, tmpCtxRoot);

    expect(result.status).toBe('migrated');
    expect(result.cronsMigrated).toBe(1);
    expect(result.cronsSkipped).toHaveLength(0);

    const crons = readCrons('epsilon');
    expect(crons).toHaveLength(1);
    expect(crons[0].name).toBe('implicit-recurring');
    expect(crons[0].schedule).toBe('12h');
    expect(crons[0].enabled).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // Test 7: Missing config.json → no-op, no crash, marker created
  // ---------------------------------------------------------------------------

  it('handles missing config.json gracefully: no crash, empty crons.json + marker', () => {
    const configPath = join(tmpFrameworkRoot, 'orgs', 'testorg', 'agents', 'noconfig', 'config.json');
    // Do NOT write config.json

    const result = migrateCronsForAgent('noconfig', configPath, tmpCtxRoot);

    expect(result.status).toBe('no-config');
    expect(result.cronsMigrated).toBeUndefined();

    // crons.json should exist (empty envelope)
    const raw = rawCronsJson(tmpCtxRoot, 'noconfig');
    expect(raw).not.toBeNull();
    expect(raw!.crons).toHaveLength(0);

    // Marker must exist so we don't retry every boot
    expect(markerExists(tmpCtxRoot, 'noconfig')).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // Test 8: Config.json with no crons array → empty crons.json + marker
  // ---------------------------------------------------------------------------

  it('handles config.json with no crons array: writes empty crons.json + marker', () => {
    const agentDir = join(tmpFrameworkRoot, 'orgs', 'testorg', 'agents', 'nocrons');
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(
      join(agentDir, 'config.json'),
      JSON.stringify({ agent_name: 'nocrons', enabled: true }),
      'utf-8',
    );

    const result = migrateCronsForAgent('nocrons', join(agentDir, 'config.json'), tmpCtxRoot);

    expect(result.status).toBe('no-crons');

    const crons = readCrons('nocrons');
    expect(crons).toHaveLength(0);

    expect(markerExists(tmpCtxRoot, 'nocrons')).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // Test 9: Empty crons array → empty crons.json + marker
  // ---------------------------------------------------------------------------

  it('handles config.json with empty crons array: writes empty crons.json + marker', () => {
    const agentDir = join(tmpFrameworkRoot, 'orgs', 'testorg', 'agents', 'emptycrons');
    writeConfigJson(agentDir, []);

    const result = migrateCronsForAgent('emptycrons', join(agentDir, 'config.json'), tmpCtxRoot);

    expect(result.status).toBe('no-crons');

    const crons = readCrons('emptycrons');
    expect(crons).toHaveLength(0);

    expect(markerExists(tmpCtxRoot, 'emptycrons')).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // Test 10: Field mapping correctness
  // ---------------------------------------------------------------------------

  it('maps all fields correctly: name, schedule (from interval), prompt, enabled, metadata', () => {
    const agentDir = join(tmpFrameworkRoot, 'orgs', 'testorg', 'agents', 'zeta');
    writeConfigJson(agentDir, [
      { name: 'heartbeat', type: 'recurring', interval: '6h', prompt: 'Read HEARTBEAT.md.' },
    ]);
    const configPath = join(agentDir, 'config.json');

    migrateCronsForAgent('zeta', configPath, tmpCtxRoot);

    const crons = readCrons('zeta');
    expect(crons).toHaveLength(1);

    const c = crons[0];
    expect(c.name).toBe('heartbeat');
    expect(c.schedule).toBe('6h');           // interval → schedule
    expect(c.prompt).toBe('Read HEARTBEAT.md.');
    expect(c.enabled).toBe(true);
    expect(typeof c.created_at).toBe('string');
    expect(c.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T/); // ISO format
    // Metadata should record the migration origin
    expect(c.metadata?.migrated_from_config).toBe(true);
    expect(c.metadata?.original_type).toBe('recurring');
  });

  it('maps cron expression field correctly (cron → schedule)', () => {
    const agentDir = join(tmpFrameworkRoot, 'orgs', 'testorg', 'agents', 'eta');
    writeConfigJson(agentDir, [
      { name: 'morning', type: 'recurring', cron: '0 13 * * *', prompt: 'Morning briefing.' },
    ]);
    const configPath = join(agentDir, 'config.json');

    migrateCronsForAgent('eta', configPath, tmpCtxRoot);

    const crons = readCrons('eta');
    expect(crons).toHaveLength(1);
    expect(crons[0].schedule).toBe('0 13 * * *');
    expect(crons[0].name).toBe('morning');
  });

  it('cron expression takes precedence over interval when both are present', () => {
    const agentDir = join(tmpFrameworkRoot, 'orgs', 'testorg', 'agents', 'theta');
    writeConfigJson(agentDir, [
      { name: 'both', cron: '0 8 * * *', interval: '24h', prompt: 'Cron wins over interval.' },
    ]);
    const configPath = join(agentDir, 'config.json');

    migrateCronsForAgent('theta', configPath, tmpCtxRoot);

    const crons = readCrons('theta');
    expect(crons).toHaveLength(1);
    // cron field takes precedence (mirrors convertEntry logic)
    expect(crons[0].schedule).toBe('0 8 * * *');
  });
});

// ---------------------------------------------------------------------------
// Test 11: Multiple agents migrated via migrateAllAgents()
// ---------------------------------------------------------------------------

describe('migrateAllAgents', () => {
  it('migrates all agents in framework across multiple orgs', () => {
    // Create 3 agents in 2 orgs
    const agents = [
      { org: 'lifeos', name: 'boris', crons: [
        { name: 'heartbeat', type: 'recurring', interval: '6h', prompt: 'Heartbeat.' },
        { name: 'daily', interval: '24h', prompt: 'Daily.' },
      ]},
      { org: 'lifeos', name: 'paul', crons: [
        { name: 'briefing', interval: '12h', prompt: 'Briefing.' },
      ]},
      { org: 'cointally', name: 'becky', crons: [
        { name: 'usage', interval: '1h', prompt: 'Usage check.' },
        { name: 'weekly', cron: '0 16 * * 1', prompt: 'Weekly.' },
      ]},
    ];

    for (const { org, name, crons } of agents) {
      const agentDir = join(tmpFrameworkRoot, 'orgs', org, 'agents', name);
      writeConfigJson(agentDir, crons);
    }

    const logs: string[] = [];
    const summary = migrateAllAgents(tmpFrameworkRoot, tmpCtxRoot, {
      log: (msg) => logs.push(msg),
    });

    expect(summary.processed).toBe(3);
    expect(summary.totalCronsMigrated).toBe(5);
    expect(summary.results).toHaveLength(3);

    // All agents should be marked as migrated
    for (const { name } of agents) {
      expect(isMigrated(tmpCtxRoot, name)).toBe(true);
    }

    // Verify each agent's crons.json is correct
    expect(readCrons('boris')).toHaveLength(2);
    expect(readCrons('paul')).toHaveLength(1);
    expect(readCrons('becky')).toHaveLength(2);
  });

  it('skips already-migrated agents and reports correct counts', () => {
    const agentDir = join(tmpFrameworkRoot, 'orgs', 'testorg', 'agents', 'iota');
    writeConfigJson(agentDir, [
      { name: 'heartbeat', interval: '6h', prompt: 'Heartbeat.' },
    ]);
    const configPath = join(agentDir, 'config.json');

    // Pre-migrate iota manually
    migrateCronsForAgent('iota', configPath, tmpCtxRoot);
    expect(isMigrated(tmpCtxRoot, 'iota')).toBe(true);

    // Run all-agents migration
    const summary = migrateAllAgents(tmpFrameworkRoot, tmpCtxRoot, {
      log: () => {},
    });

    // iota should be in results as 'skipped-already-migrated'
    const iotaResult = summary.results.find(r => r.agentName === 'iota');
    expect(iotaResult?.status).toBe('skipped-already-migrated');

    // No duplicate crons
    expect(readCrons('iota')).toHaveLength(1);
  });

  it('force flag re-migrates all agents', () => {
    const agentDir = join(tmpFrameworkRoot, 'orgs', 'testorg', 'agents', 'kappa');
    writeConfigJson(agentDir, [
      { name: 'heartbeat', interval: '6h', prompt: 'Heartbeat.' },
    ]);
    const configPath = join(agentDir, 'config.json');

    // First migration
    migrateCronsForAgent('kappa', configPath, tmpCtxRoot);

    // Update config (add cron), then force-migrate all
    writeConfigJson(agentDir, [
      { name: 'heartbeat', interval: '6h', prompt: 'Heartbeat.' },
      { name: 'extra', interval: '12h', prompt: 'Extra.' },
    ]);

    const summary = migrateAllAgents(tmpFrameworkRoot, tmpCtxRoot, {
      force: true,
      log: () => {},
    });

    const kappaResult = summary.results.find(r => r.agentName === 'kappa');
    expect(kappaResult?.status).toBe('migrated');
    expect(kappaResult?.cronsMigrated).toBe(2);

    expect(readCrons('kappa')).toHaveLength(2);
  });

  it('handles missing orgs directory gracefully (no crash)', () => {
    const emptyFwRoot = mkdtempSync(join(tmpdir(), 'crons-migration-empty-'));
    try {
      const summary = migrateAllAgents(emptyFwRoot, tmpCtxRoot, { log: () => {} });
      expect(summary.processed).toBe(0);
      expect(summary.totalCronsMigrated).toBe(0);
      expect(summary.results).toHaveLength(0);
    } finally {
      try { rmSync(emptyFwRoot, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });
});

// ---------------------------------------------------------------------------
// Test 12: Disabled crons are migrated as enabled:false
// ---------------------------------------------------------------------------

describe('disabled cron handling', () => {
  it('migrates type:"disabled" cron with enabled:false', () => {
    const agentDir = join(tmpFrameworkRoot, 'orgs', 'testorg', 'agents', 'lambda');
    writeConfigJson(agentDir, [
      { name: 'paused', type: 'disabled', interval: '6h', prompt: 'This is paused.' },
    ]);
    const configPath = join(agentDir, 'config.json');

    const result = migrateCronsForAgent('lambda', configPath, tmpCtxRoot);
    expect(result.status).toBe('migrated');
    expect(result.cronsMigrated).toBe(1);

    const crons = readCrons('lambda');
    expect(crons).toHaveLength(1);
    expect(crons[0].enabled).toBe(false);
    expect(crons[0].name).toBe('paused');
  });

  // -------------------------------------------------------------------------
  // RESTART SURVIVAL — regression guard for 2026-08-12.
  //
  // The test above covers `type: "disabled"`, which was the ONLY disable signal
  // the reader honoured. Operators reach for `enabled: false` and leave `type`
  // as "recurring" — the cron IS recurring, it is just switched off — and that
  // shape was untested and silently discarded.
  //
  // What it cost: coordinator hardened operator's config with `enabled: false` on five
  // proactive crons so a fleet restart could not re-arm them. The restart
  // re-armed all five, because config.json is reconciled into crons.json on
  // EVERY AGENT BOOT (#125). Zero prohibited fires only because operator noticed and
  // re-disabled them ~25 minutes before the next window — an agent-shaped catch,
  // not a system-enforced one.
  //
  // These assert the SHAPE THAT BROKE, not the shape that already worked.
  // -------------------------------------------------------------------------
  it('honours enabled:false even when type is "recurring" (the shape that broke)', () => {
    const agentDir = join(tmpFrameworkRoot, 'orgs', 'testorg', 'agents', 'lambda2');
    writeConfigJson(agentDir, [
      // Exactly operator's shape: switched off via `enabled`, type left as recurring.
      { name: 'ar-digest', type: 'recurring', cron: '0 8 * * 1-5', prompt: 'Run digest.', enabled: false },
      // Control: an entry with no `enabled` field must still arm, or the fix
      // would disable everything and pass this file for the wrong reason.
      { name: 'heartbeat', type: 'recurring', interval: '2h', prompt: 'Heartbeat.' },
    ]);

    const result = migrateCronsForAgent('lambda2', join(agentDir, 'config.json'), tmpCtxRoot);
    expect(result.status).toBe('migrated');

    const crons = readCrons('lambda2');
    const digest = crons.find((c) => c.name === 'ar-digest');
    const hb = crons.find((c) => c.name === 'heartbeat');
    expect(digest?.enabled).toBe(false); // would have been true before the fix
    expect(hb?.enabled).toBe(true); // absent !== false
  });

  // -------------------------------------------------------------------------
  // ROUND-TRIP PRESERVATION — coordinator's assertion, 2026-08-13.
  //
  // The first version of this fix DECLARED `description` and `disabled_reason`
  // on CronEntry and claimed in the PR that all three fields were preserved.
  // They were not: convertEntry never read them, so recurring descriptions
  // vanished, disabled descriptions were overwritten by generic migration text,
  // and disabled_reason had no counterpart on CronDefinition at all. The Codex
  // review caught it with live evidence — reviewer's config supplies a reason for
  // usage-rate-guard and every boot discarded it.
  //
  // Declaring a field and preserving it are different things. This test makes
  // the difference provable instead of claimed.
  // -------------------------------------------------------------------------
  it('an entry carrying all three operator fields round-trips through a boot reconcile', () => {
    const agentDir = join(tmpFrameworkRoot, 'orgs', 'testorg', 'agents', 'lambda4');
    writeConfigJson(agentDir, [
      {
        name: 'usage-rate-guard',
        type: 'recurring',
        cron: '0 9 * * *',
        prompt: 'Guard the rate.',
        enabled: false,
        description: 'Operator description that must survive',
        disabled_reason: 'paused pending budget decision',
      },
    ]);
    const configPath = join(agentDir, 'config.json');

    migrateCronsForAgent('lambda4', configPath, tmpCtxRoot);
    const first = readCrons('lambda4')[0];
    expect(first.enabled).toBe(false);
    expect(first.description).toBe('Operator description that must survive');
    expect(first.disabled_reason).toBe('paused pending budget decision');

    // The generic migration string must NOT have clobbered the operator's text.
    expect(first.description).not.toContain('Migrated from config.json');

    // And it all survives the next boot's reconcile, unchanged.
    migrateCronsForAgent('lambda4', configPath, tmpCtxRoot, { force: true });
    const second = readCrons('lambda4')[0];
    expect(second.enabled).toBe(false);
    expect(second.description).toBe(first.description);
    expect(second.disabled_reason).toBe(first.disabled_reason);
  });

  // -------------------------------------------------------------------------
  // MATCHED-ENTRY MERGE — the path my first round-trip test did NOT exercise.
  //
  // Codex review, second pass: conversion had started populating disabled_reason,
  // but BOTH merge paths still dropped it. When a cron already exists in
  // crons.json, the merge starts from the prior definition and copies only
  // CONFIG_AUTHORITATIVE_FIELDS plus a special-cased `description` — so a reason
  // added or changed in config never reached disk for any existing cron.
  //
  // My earlier test passed because migrateCronsForAgent({force:true}) re-migrates
  // rather than merging, so it never touched this code. A test that passes by
  // avoiding the real path is the shape this suite exists to prevent, and it is
  // the second time on this PR that the shipped-path and the tested-path differed.
  // -------------------------------------------------------------------------
  // Path 1 casualty — the INITIAL MIGRATION merge (cron-migration.ts ~433-445).
  // reviewer's ask: both matched-entry paths need their own casualty, because I
  // fixed two and had proved one. A fix verified on one of two paths is half a
  // fix with full confidence attached.
  it('carries a CHANGED disabled_reason through the initial migration merge', () => {
    const agentDir = join(tmpFrameworkRoot, 'orgs', 'testorg', 'agents', 'lambda6');
    writeConfigJson(agentDir, [
      {
        name: 'ar-digest', type: 'recurring', cron: '0 8 * * 1-5',
        prompt: 'Digest.', enabled: false, disabled_reason: 'first reason',
      },
    ]);
    const configPath = join(agentDir, 'config.json');

    migrateCronsForAgent('lambda6', configPath, tmpCtxRoot);
    expect(readCrons('lambda6')[0].disabled_reason).toBe('first reason');

    // Same-named entry now exists in crons.json, so a forced re-migration takes
    // the matched-entry branch (`const prior = existingByName.get(...)`) rather
    // than converting fresh.
    writeConfigJson(agentDir, [
      {
        name: 'ar-digest', type: 'recurring', cron: '0 8 * * 1-5',
        prompt: 'Digest.', enabled: false, disabled_reason: 'second reason after review',
      },
    ]);
    migrateCronsForAgent('lambda6', configPath, tmpCtxRoot, { force: true });

    const after = readCrons('lambda6')[0];
    expect(after.disabled_reason).toBe('second reason after review');
    expect(after.enabled).toBe(false);
  });

  it('carries a CHANGED disabled_reason through the boot-time reload merge', () => {
    const agentDir = join(tmpFrameworkRoot, 'orgs', 'testorg', 'agents', 'lambda5');
    writeConfigJson(agentDir, [
      {
        name: 'bank-rec-am', type: 'recurring', cron: '0 8 * * 1-5',
        prompt: 'Reconcile.', enabled: false,
        disabled_reason: 'original reason',
      },
    ]);
    const configPath = join(agentDir, 'config.json');

    migrateCronsForAgent('lambda5', configPath, tmpCtxRoot);
    expect(readCrons('lambda5')[0].disabled_reason).toBe('original reason');

    // Operator edits the reason in config. The cron already exists in crons.json,
    // so the next boot takes the MATCHED-ENTRY MERGE path, not a fresh convert.
    writeConfigJson(agentDir, [
      {
        name: 'bank-rec-am', type: 'recurring', cron: '0 8 * * 1-5',
        prompt: 'Reconcile.', enabled: false,
        disabled_reason: 'updated reason after budget review',
      },
    ]);
    const reload = reloadCronsForAgent('lambda5', configPath);

    // ASSERT THE SUBJECT: this test is only meaningful if the reload took the
    // MATCHED-ENTRY MERGE path. If the cron is reported as ADDED, the reload
    // converted it fresh and never touched the merge code — which is exactly how
    // the first version of this test passed against a mutant.
    // THREE-WAY disposition, not a permissive OR. The earlier version accepted
    // `updated OR unchanged`, which cannot fail on a WRONG disposition — and it
    // did not: the merge wrote the new reason to disk while definitionChanged
    // omitted disabled_reason, so the reload reported `unchanged` and the test
    // passed anyway. An assertion that admits both answers is not an assertion.
    expect(reload.updated).toContain('bank-rec-am');
    expect(reload.unchanged ?? []).not.toContain('bank-rec-am');
    expect(reload.added).not.toContain('bank-rec-am');

    const after = readCrons('lambda5')[0];
    expect(after.disabled_reason).toBe('updated reason after budget review');
    expect(after.enabled).toBe(false); // and the disable itself still survives
  });

  it('a disabled cron STAYS disabled across a re-reconciliation (boot survival)', () => {
    const agentDir = join(tmpFrameworkRoot, 'orgs', 'testorg', 'agents', 'lambda3');
    writeConfigJson(agentDir, [
      { name: 'bank-rec-am', type: 'recurring', cron: '0 8 * * 1-5', prompt: 'Reconcile.', enabled: false },
    ]);
    const configPath = join(agentDir, 'config.json');

    migrateCronsForAgent('lambda3', configPath, tmpCtxRoot);
    expect(readCrons('lambda3')[0].enabled).toBe(false);

    // Simulate the next agent boot re-running the config -> crons.json
    // reconciliation. THIS is the step that re-armed operator's five crons.
    migrateCronsForAgent('lambda3', configPath, tmpCtxRoot, { force: true });
    expect(readCrons('lambda3')[0].enabled).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Test 13: readCrons round-trip — verify migrated definitions survive a disk round-trip
// ---------------------------------------------------------------------------

describe('disk round-trip via readCrons()', () => {
  it('migrated crons survive JSON serialization and are readable by readCrons()', () => {
    const agentDir = join(tmpFrameworkRoot, 'orgs', 'testorg', 'agents', 'mu');
    writeConfigJson(agentDir, [
      { name: 'heartbeat', type: 'recurring', interval: '6h', prompt: 'Run heartbeat.' },
      { name: 'weekly', cron: '0 16 * * 1', prompt: 'Weekly.' },
    ]);
    const configPath = join(agentDir, 'config.json');

    migrateCronsForAgent('mu', configPath, tmpCtxRoot);

    // Read back via readCrons() — not the raw file
    const crons = readCrons('mu');
    expect(crons).toHaveLength(2);

    const hb = crons.find(c => c.name === 'heartbeat');
    const wk = crons.find(c => c.name === 'weekly');

    expect(hb).toBeDefined();
    expect(hb!.schedule).toBe('6h');
    expect(hb!.prompt).toBe('Run heartbeat.');
    expect(hb!.enabled).toBe(true);

    expect(wk).toBeDefined();
    expect(wk!.schedule).toBe('0 16 * * 1');
    expect(wk!.prompt).toBe('Weekly.');
    expect(wk!.enabled).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// F1: read-merge-fail-loud — migration must never blind-overwrite a populated
// crons.json (e.g. runtime-added crons via `bus add-cron`), and must fail loud
// (preserve, not wipe) on corrupt config OR corrupt state.
// See reports/2026-06-03-fix-specs-roadmap.md PR-3 / fix-spec F1.
// ---------------------------------------------------------------------------
describe('F1: read-merge-fail-loud (no blind overwrite)', () => {
  function seedCronsJson(agentName: string, crons: CronDefinition[]): void {
    const dir = join(tmpCtxRoot, CRONS_DIR, agentName);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, CRONS_FILE),
      JSON.stringify({ updated_at: '2026-01-01T00:00:00.000Z', crons }),
      'utf-8',
    );
  }

  const runtimeCron = {
    name: 'runtime-only',
    prompt: 'Added at runtime via bus add-cron.',
    schedule: '30m',
    enabled: true,
    created_at: '2026-01-01T00:00:00.000Z',
    last_fired_at: '2026-01-02T03:04:05.000Z',
  } as CronDefinition;

  it('preserves runtime-added crons not present in config.json', () => {
    const agentDir = join(tmpFrameworkRoot, 'orgs', 'testorg', 'agents', 'merge1');
    seedCronsJson('merge1', [runtimeCron]);
    writeConfigJson(agentDir, [
      { name: 'config-cron', interval: '6h', prompt: 'From config.' },
    ]);
    const configPath = join(agentDir, 'config.json');

    const result = migrateCronsForAgent('merge1', configPath, tmpCtxRoot);
    expect(result.status).toBe('migrated');

    const crons = readCrons('merge1');
    expect(crons.map(c => c.name).sort()).toEqual(['config-cron', 'runtime-only']);

    const preserved = crons.find(c => c.name === 'runtime-only')!;
    expect(preserved.created_at).toBe('2026-01-01T00:00:00.000Z');
    expect(preserved.last_fired_at).toBe('2026-01-02T03:04:05.000Z');
  });

  it('force re-migration does not drop runtime crons', () => {
    const agentDir = join(tmpFrameworkRoot, 'orgs', 'testorg', 'agents', 'merge2');
    writeConfigJson(agentDir, [
      { name: 'config-cron', interval: '6h', prompt: 'From config.' },
    ]);
    const configPath = join(agentDir, 'config.json');

    migrateCronsForAgent('merge2', configPath, tmpCtxRoot);
    const afterFirst = readCrons('merge2');
    // Simulate an operator adding a runtime cron after the first migration.
    seedCronsJson('merge2', [...afterFirst, runtimeCron]);

    const forced = migrateCronsForAgent('merge2', configPath, tmpCtxRoot, { force: true });
    expect(forced.status).toBe('migrated');
    expect(readCrons('merge2').map(c => c.name).sort()).toEqual(['config-cron', 'runtime-only']);
  });

  it('empty crons[] in config preserves a populated crons.json (no wipe)', () => {
    const agentDir = join(tmpFrameworkRoot, 'orgs', 'testorg', 'agents', 'merge3');
    seedCronsJson('merge3', [runtimeCron]);
    writeConfigJson(agentDir, []);
    const configPath = join(agentDir, 'config.json');

    const result = migrateCronsForAgent('merge3', configPath, tmpCtxRoot);
    expect(result.status).toBe('no-crons');
    expect(readCrons('merge3')).toHaveLength(1);
    expect(readCrons('merge3')[0].name).toBe('runtime-only');
    expect(markerExists(tmpCtxRoot, 'merge3')).toBe(true);
  });

  it('corrupt config.json does not wipe crons.json and does not write the marker', () => {
    const agentDir = join(tmpFrameworkRoot, 'orgs', 'testorg', 'agents', 'merge4');
    mkdirSync(agentDir, { recursive: true });
    seedCronsJson('merge4', [runtimeCron]);
    writeFileSync(join(agentDir, 'config.json'), '{ this is not valid json', 'utf-8');
    const configPath = join(agentDir, 'config.json');

    const result = migrateCronsForAgent('merge4', configPath, tmpCtxRoot);
    expect(result.status).toBe('no-crons');
    // Existing crons untouched; marker NOT written so a later boot retries.
    expect(readCrons('merge4')).toHaveLength(1);
    expect(readCrons('merge4')[0].name).toBe('runtime-only');
    expect(markerExists(tmpCtxRoot, 'merge4')).toBe(false);
  });

  it('corrupt crons.json (no .bak) aborts migration loud — file left untouched', () => {
    const agentDir = join(tmpFrameworkRoot, 'orgs', 'testorg', 'agents', 'merge5');
    writeConfigJson(agentDir, [
      { name: 'config-cron', interval: '6h', prompt: 'From config.' },
    ]);
    const configPath = join(agentDir, 'config.json');

    // Populate crons.json with invalid JSON and NO .bak → readCronsWithStatus corrupt:true.
    const dir = join(tmpCtxRoot, CRONS_DIR, 'merge5');
    mkdirSync(dir, { recursive: true });
    const cronsPath = join(dir, CRONS_FILE);
    writeFileSync(cronsPath, '{ broken crons json', 'utf-8');

    const result = migrateCronsForAgent('merge5', configPath, tmpCtxRoot);
    expect(result.status).toBe('no-crons');
    expect(markerExists(tmpCtxRoot, 'merge5')).toBe(false);
    // The broken crons.json must be left exactly as-is (not overwritten with []).
    const { readFileSync: fsRead } = require('fs') as typeof import('fs');
    expect(fsRead(cronsPath, 'utf-8')).toBe('{ broken crons json');
  });
});
