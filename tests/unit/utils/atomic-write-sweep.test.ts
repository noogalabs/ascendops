/**
 * Wire-boundary regression tests for the non-atomic-write sweep
 * (framework-bughunt findings #4–#7, Class E).
 *
 * These do NOT re-test atomicWriteSync itself (covered by atomic.test.ts).
 * They prove that the CONVERTED CALL SITES route their JSON-state writes
 * through the temp-file + rename path, so a torn/interrupted write can't
 * corrupt the target file. The observable signature of that path is:
 *   - the final write lands via fs.renameSync FROM a `.tmp.*` source, and
 *   - no `.tmp.*` partial file is left behind on success.
 *
 * A site that still did a direct `writeFileSync(target, ...)` would write
 * the target without any rename — which these tests would catch.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  existsSync,
} from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { scanFile } from '../../../src/utils/cron-teaching-scanner';
import { cronAudit } from '../../../src/bus/cron-audit';
import { installCommunityItem } from '../../../src/bus/catalog';

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return { ...actual };
});

/** Returns all `.tmp.*` partials directly inside `dir`. */
function tmpPartials(dir: string): string[] {
  return readdirSync(dir).filter((f) => f.startsWith('.tmp.'));
}

describe('non-atomic-write sweep — call sites use temp+rename', () => {
  let workDir: string;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'atomic-sweep-'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(workDir, { recursive: true, force: true });
  });

  describe('cron-teaching-scanner.scanFile (#7)', () => {
    it('apply=true writes via a `.tmp.*`→rename and leaves no partial', () => {
      const fp = join(workDir, 'AGENTS.md');
      // Content the safe-substitution rewrites; ends with a newline already.
      writeFileSync(fp, 'Heartbeat cron (configured in config.json) fires.\n', 'utf-8');

      const renameSpy = vi.spyOn(fs, 'renameSync');

      const r = scanFile(fp, { apply: true });
      expect(r.applied).toBeGreaterThan(0);

      // The substituted content is present (newline-tolerant assertion — the
      // atomic writer appends its own trailing \n, which is fine here).
      const out = readFileSync(fp, 'utf-8');
      expect(out).toContain('(configured via cortextos bus add-cron)');
      expect(out).not.toContain('(configured in config.json)');

      // Proof of atomic path: a rename FROM a .tmp.* source targeted this file.
      const renamedHere = renameSpy.mock.calls.filter(
        ([, dest]) => dest === fp,
      );
      expect(renamedHere.length).toBe(1);
      expect(String(renamedHere[0][0])).toContain('.tmp.');

      // No partial left behind.
      expect(tmpPartials(workDir)).toEqual([]);
    });
  });

  describe('cron-audit.cronAudit --fix (#7)', () => {
    it('writes config.json + SKILL.md via temp+rename, valid JSON, no partials', () => {
      const org = 'testorg';
      const agentDir = join(workDir, 'orgs', org, 'agents', 'moss');
      mkdirSync(agentDir, { recursive: true });

      const longPrompt = 'X'.repeat(300); // over the default 100-char threshold
      writeFileSync(
        join(agentDir, 'config.json'),
        JSON.stringify(
          { crons: [{ name: 'morning_report', interval: '0 13 * * *', prompt: longPrompt }] },
          null,
          2,
        ),
        'utf-8',
      );

      const renameSpy = vi.spyOn(fs, 'renameSync');

      const report = cronAudit(workDir, org, { fix: true });
      expect(report.totalFixed).toBe(1);

      const configPath = join(agentDir, 'config.json');
      const skillPath = join(agentDir, '.claude', 'skills', 'morning-report', 'SKILL.md');

      // Both files written and parse cleanly.
      const cfg = JSON.parse(readFileSync(configPath, 'utf-8'));
      expect(cfg.crons[0].prompt).toMatch(/SKILL\.md/);
      expect(existsSync(skillPath)).toBe(true);
      expect(readFileSync(skillPath, 'utf-8')).toContain(longPrompt);

      // Both writes went through a .tmp.* rename.
      const cfgRename = renameSpy.mock.calls.find(([, d]) => d === configPath);
      const skillRename = renameSpy.mock.calls.find(([, d]) => d === skillPath);
      expect(cfgRename && String(cfgRename[0])).toContain('.tmp.');
      expect(skillRename && String(skillRename[0])).toContain('.tmp.');

      // No partials in either directory.
      expect(tmpPartials(agentDir)).toEqual([]);
      expect(tmpPartials(join(agentDir, '.claude', 'skills', 'morning-report'))).toEqual([]);
    });
  });

  describe('catalog.installCommunityItem → writeInstalled (#6)', () => {
    it('writes the installed-community manifest via temp+rename', () => {
      const frameworkRoot = mkdtempSync(join(tmpdir(), 'sweep-fw-'));
      const ctxRoot = mkdtempSync(join(tmpdir(), 'sweep-ctx-'));
      const agentDir = mkdtempSync(join(tmpdir(), 'sweep-agent-'));
      try {
        mkdirSync(join(frameworkRoot, 'community', 'skills', 'tasks'), { recursive: true });
        writeFileSync(join(frameworkRoot, 'community', 'skills', 'tasks', 'SKILL.md'), '# tasks');
        writeFileSync(
          join(frameworkRoot, 'community', 'catalog.json'),
          JSON.stringify({
            version: '1.0.0',
            updated_at: '2026-04-15T00:00:00Z',
            items: [{
              name: 'tasks', description: 't', author: 'a', type: 'skill',
              version: '1.0.0', tags: [], dependencies: [],
              install_path: 'community/skills/tasks',
            }],
          }),
        );

        const renameSpy = vi.spyOn(fs, 'renameSync');

        const r = installCommunityItem(frameworkRoot, ctxRoot, 'tasks', { agentDir });
        expect(r.status).toBe('installed');

        // The installed manifest lives directly under ctxRoot.
        const installedPath = join(ctxRoot, '.installed-community.json');
        expect(existsSync(installedPath)).toBe(true);
        expect(() => JSON.parse(readFileSync(installedPath, 'utf-8'))).not.toThrow();

        const manifestRename = renameSpy.mock.calls.find(([, d]) => d === installedPath);
        expect(manifestRename && String(manifestRename[0])).toContain('.tmp.');
        expect(tmpPartials(ctxRoot)).toEqual([]);
      } finally {
        rmSync(frameworkRoot, { recursive: true, force: true });
        rmSync(ctxRoot, { recursive: true, force: true });
        rmSync(agentDir, { recursive: true, force: true });
      }
    });
  });
});
