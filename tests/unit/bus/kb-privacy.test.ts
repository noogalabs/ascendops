import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, writeFileSync, symlinkSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// Spy the ingest spawn so integration checks prove mmrag is never invoked when the
// guard refuses. Only child_process is mocked; the guard's fs path-resolution runs
// for real against real files (this IS the real guard, not a mocked collection-arg).
const execFileSyncSpy = vi.fn();
vi.mock('child_process', () => ({
  execFileSync: (...args: unknown[]) => execFileSyncSpy(...args),
}));

import { ingestKnowledgeBase } from '../../../src/bus/knowledge-base.js';
import { assertNoOwnerPrivatePaths, isOwnerPrivatePath } from '../../../src/bus/kb-privacy.js';

const ROOT = join(tmpdir(), `kb-privacy-${Date.now()}`);
const P = {
  vaultCore: join(ROOT, 'vault', '00-Core', 'USER.md'),
  vaultMemory: join(ROOT, 'vault', '01-Memory', 'daily.md'),
  vaultMigrationBackup: join(ROOT, 'vault', '07-Infrastructure', 'migration-backup', 'export.json'),
  vaultPeople: join(ROOT, 'vault', '03-People', 'family.md'),
  stateEa: join(ROOT, 'state', 'ea', 'secret.md'),
  crm: join(ROOT, 'crm', 'contacts.json'),
  daneMemory: join(ROOT, 'orgs', 'x', 'agents', 'coordinator', 'MEMORY.md'),
  daneMemoryDaily: join(ROOT, 'orgs', 'x', 'agents', 'coordinator', 'memory', '2026-07-11.md'),
  daneMigrated: join(ROOT, 'orgs', 'x', 'agents', 'coordinator', 'migrated', 'legacy.md'),
  daneMemoryDir: join(ROOT, 'orgs', 'x', 'agents', 'coordinator', 'memory'),
  aussieMemory: join(ROOT, 'orgs', 'x', 'agents', 'reviewer', 'MEMORY.md'),
  traversalSpoof: join(ROOT, 'orgs', 'x', 'agents', 'coordinator', '..', 'reviewer', 'MEMORY.md'),
  cleanFile: join(ROOT, 'shared', 'policy.md'),
  symlinkToStateEa: join(ROOT, 'sneaky', 'notes.md'),
  symlinkToAussieMemory: join(ROOT, 'orgs', 'x', 'agents', 'coordinator', 'memory-link.md'),
  mixedDir: join(ROOT, 'mixed'), // own-memory next to a state/ea file
};

function seed(): void {
  for (const f of [
    P.vaultCore, P.vaultMemory, P.vaultMigrationBackup, P.vaultPeople,
    P.stateEa, P.crm, P.daneMemory, P.daneMemoryDaily, P.daneMigrated, P.aussieMemory, P.cleanFile,
  ]) {
    mkdirSync(join(f, '..'), { recursive: true });
    writeFileSync(f, '# fixture\n');
  }
  mkdirSync(join(P.symlinkToStateEa, '..'), { recursive: true });
  symlinkSync(P.stateEa, P.symlinkToStateEa);
  mkdirSync(join(P.symlinkToAussieMemory, '..'), { recursive: true });
  symlinkSync(P.aussieMemory, P.symlinkToAussieMemory);
  mkdirSync(join(P.mixedDir, 'agents', 'coordinator'), { recursive: true });
  writeFileSync(join(P.mixedDir, 'agents', 'coordinator', 'MEMORY.md'), 'own');
  mkdirSync(join(P.mixedDir, 'state', 'ea'), { recursive: true });
  writeFileSync(join(P.mixedDir, 'state', 'ea', 'leak.md'), 'personal');
}

const priv = (agent?: string) => ({ scope: 'private' as const, agent });
const shared = { scope: 'shared' as const };

describe('EA privacy wall — narrowed guard (W1-C, real guard)', () => {
  const previousVaultDir = process.env.OWNER_PRIVATE_VAULT_DIR;
  beforeEach(() => {
    execFileSyncSpy.mockReset();
    process.env.OWNER_PRIVATE_VAULT_DIR = join(ROOT, 'vault'); // env-configured, no hardcoded home
    seed();
  });
  afterEach(() => {
    if (previousVaultDir === undefined) delete process.env.OWNER_PRIVATE_VAULT_DIR;
    else process.env.OWNER_PRIVATE_VAULT_DIR = previousVaultDir;
    rmSync(ROOT, { recursive: true, force: true });
  });

  it('ALLOWS an agent ingesting its OWN memory into its OWN private scope', () => {
    expect(() => assertNoOwnerPrivatePaths([P.daneMemory], priv('coordinator'))).not.toThrow();
    expect(() => assertNoOwnerPrivatePaths([P.daneMemoryDaily], priv('coordinator'))).not.toThrow();
    expect(() => assertNoOwnerPrivatePaths([P.daneMemoryDir], priv('coordinator'))).not.toThrow();
    expect(() => assertNoOwnerPrivatePaths([P.daneMigrated], priv('coordinator'))).not.toThrow();
  });

  // ── memory refusals ──
  it('REFUSES own memory under SHARED scope', () => {
    expect(() => assertNoOwnerPrivatePaths([P.daneMemory], shared)).toThrow(/BLOCKED/);
  });
  it('REFUSES a DIFFERENT agent’s memory in private scope (cross-agent leak)', () => {
    expect(() => assertNoOwnerPrivatePaths([P.aussieMemory], priv('coordinator'))).toThrow(/BLOCKED/);
    expect(() => assertNoOwnerPrivatePaths([P.daneMemory], priv('reviewer'))).toThrow(/BLOCKED/);
  });
  it('REFUSES a traversal spoof: agents/coordinator/../reviewer/MEMORY.md resolves to reviewer', () => {
    expect(() => assertNoOwnerPrivatePaths([P.traversalSpoof], priv('coordinator'))).toThrow(/BLOCKED/);
  });
  it('REFUSES a symlink resolving from own tree to another agent memory', () => {
    expect(() => assertNoOwnerPrivatePaths([P.symlinkToAussieMemory], priv('coordinator'))).toThrow(/BLOCKED/);
  });
  it('REFUSES private own-memory when NO agent is given', () => {
    expect(() => assertNoOwnerPrivatePaths([P.daneMemory], priv(undefined))).toThrow(/BLOCKED/);
  });

  // ── state/ea + crm + vault: always blocked, every scope, no exemption ──
  it('REFUSES state/ea under EVERY scope', () => {
    expect(() => assertNoOwnerPrivatePaths([P.stateEa], shared)).toThrow(/BLOCKED/);
    expect(() => assertNoOwnerPrivatePaths([P.stateEa], priv('coordinator'))).toThrow(/BLOCKED/);
  });
  it('REFUSES crm under every scope', () => {
    expect(() => assertNoOwnerPrivatePaths([P.crm], priv('coordinator'))).toThrow(/BLOCKED/);
  });
  it('REFUSES configured owner-private vault paths (every scope, env-configured root)', () => {
    for (const v of [P.vaultCore, P.vaultMemory, P.vaultMigrationBackup, P.vaultPeople]) {
      expect(() => assertNoOwnerPrivatePaths([v], shared)).toThrow(/BLOCKED/);
      expect(() => assertNoOwnerPrivatePaths([v], priv('coordinator'))).toThrow(/BLOCKED/);
    }
  });
  it('REFUSES a symlink resolving to state/ea', () => {
    expect(() => assertNoOwnerPrivatePaths([P.symlinkToStateEa], priv('coordinator'))).toThrow(/BLOCKED/);
  });

  it('REFUSES a dir where allowed own-memory sits NEXT TO a state/ea file', () => {
    expect(() => assertNoOwnerPrivatePaths([P.mixedDir], priv('coordinator'))).toThrow(/BLOCKED/);
  });

  // ── does not over-block clean content ──
  it('ALLOWS a genuinely shared clean file', () => {
    expect(() => assertNoOwnerPrivatePaths([P.cleanFile], shared)).not.toThrow();
    expect(isOwnerPrivatePath(P.cleanFile)).toBe(false);
  });
  it('isOwnerPrivatePath classifies each surface correctly', () => {
    expect(isOwnerPrivatePath(P.stateEa)).toBe(true);
    expect(isOwnerPrivatePath(P.crm)).toBe(true);
    expect(isOwnerPrivatePath(P.vaultCore)).toBe(true);
    expect(isOwnerPrivatePath(P.daneMemory)).toBe(true);
    expect(isOwnerPrivatePath(P.symlinkToStateEa)).toBe(true);
    expect(isOwnerPrivatePath(P.cleanFile)).toBe(false);
  });

  // ── wired through the real ingestKnowledgeBase entry point ──
  const OPTS = { org: 'ascendops', frameworkRoot: ROOT, instanceId: 'test' };
  it('ingestKnowledgeBase REFUSES state/ea (private) and never spawns mmrag', () => {
    expect(() =>
      ingestKnowledgeBase([P.stateEa], { ...OPTS, scope: 'private', agent: 'coordinator' }),
    ).toThrow(/BLOCKED/);
    expect(execFileSyncSpy).not.toHaveBeenCalled();
  });
  it('ingestKnowledgeBase Node preflight allows own-memory in own-private scope', () => {
    expect(() =>
      ingestKnowledgeBase([P.daneMemory], { ...OPTS, scope: 'private', agent: 'coordinator' }),
    ).not.toThrow(/BLOCKED/);
  });
});
