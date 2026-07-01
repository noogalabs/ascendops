import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { findTemplateDir, copyTemplateFiles } from '../../../src/cli/add-agent.js';

// Naming standardization: the leasing/maintenance TEMPLATES were renamed to the bare +
// Coordinator form to match the already-published community/catalog names
// (leasing-coordinator, maintenance-coordinator). This is the loader-integrity + scaffold
// proof: add-agent resolves the NEW names, the OLD agent-*/Director names are gone, and a
// scaffold carries the Coordinator role-word.
const ROOT = process.cwd();

describe('naming standardization: add-agent resolves + scaffolds the renamed templates', () => {
  it('findTemplateDir resolves the new bare+Coordinator template names', () => {
    expect(findTemplateDir(ROOT, 'leasing-coordinator')).toBe(join(ROOT, 'templates', 'leasing-coordinator'));
    expect(findTemplateDir(ROOT, 'maintenance-coordinator')).toBe(join(ROOT, 'templates', 'maintenance-coordinator'));
  });

  it('findTemplateDir no longer resolves the old agent-*/Director names (rename complete)', () => {
    expect(findTemplateDir(ROOT, 'agent-leasing-coordinator')).toBeNull();
    expect(findTemplateDir(ROOT, 'agent-maintenance-director')).toBeNull();
  });

  it('add-agent --template maintenance-coordinator scaffolds with the Coordinator role-word (not Director)', () => {
    const dir = findTemplateDir(ROOT, 'maintenance-coordinator');
    expect(dir).not.toBeNull();
    const agentDir = mkdtempSync(join(tmpdir(), 'scaffold-maint-'));
    try {
      copyTemplateFiles(dir as string, agentDir, 'TestMaint', 'testorg');
      expect(existsSync(join(agentDir, 'IDENTITY.md'))).toBe(true);
      const identity = readFileSync(join(agentDir, 'IDENTITY.md'), 'utf-8');
      expect(identity).toContain('Maintenance Coordinator');
      expect(identity).not.toContain('Maintenance Director');
    } finally {
      rmSync(agentDir, { recursive: true, force: true });
    }
  });

  it('add-agent --template leasing-coordinator scaffolds and its maintenance cross-ref is Coordinator', () => {
    const dir = findTemplateDir(ROOT, 'leasing-coordinator');
    expect(dir).not.toBeNull();
    const agentDir = mkdtempSync(join(tmpdir(), 'scaffold-leas-'));
    try {
      copyTemplateFiles(dir as string, agentDir, 'TestLeas', 'testorg');
      expect(existsSync(join(agentDir, 'IDENTITY.md'))).toBe(true);
      expect(readFileSync(join(agentDir, 'IDENTITY.md'), 'utf-8')).not.toContain('Maintenance Director');
    } finally {
      rmSync(agentDir, { recursive: true, force: true });
    }
  });
});
