import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createSkillPr } from '../../../src/bus/skill-autopr.js';
import { resolveSkillPrTarget } from '../../../src/bus/skill-pr-target.js';

const roots: string[] = [];
function fixture(target?: string) {
  const root = mkdtempSync(join(tmpdir(), 'skill-pr-target-'));
  roots.push(root);
  execFileSync('git', ['init', '-q'], { cwd: root });
  if (target) execFileSync('git', ['config', '--local', 'cortextos.skillPrTarget', target], { cwd: root });
  const skillDir = join(root, 'community', 'skills', 'demo');
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, 'SKILL.md'), `---\nname: demo\ndescription: demo skill\ntriggers: [demo]\nexternal_calls: []\nlicense: MIT\n---\n\n# Demo\n`);
  const bin = join(root, 'bin');
  mkdirSync(bin);
  const ghLog = join(root, 'gh.log');
  const gh = join(bin, 'gh');
  writeFileSync(gh, `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(ghLog)}\nprintf '%s\\n' 'https://github.test/existing'\n`);
  chmodSync(gh, 0o755);
  return { root, ghLog, path: `${bin}:${process.env.PATH || ''}` };
}

afterEach(() => {
  delete process.env.CTX_FRAMEWORK_ROOT;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('D5 install-scoped skill PR target', () => {
  for (const [label, target] of [
    ['NAMED MEMBER INSTALL PRODUCTION ENTRY TARGETS HUB', 'noogalabs/ascendops'],
    ['NAMED CANONICAL INSTALL PRODUCTION ENTRY TARGETS OWEN', 'grandamenium/cortextos'],
  ] as const) {
    it(label, async () => {
      const fx = fixture(target);
      process.env.CTX_FRAMEWORK_ROOT = fx.root;
      const oldPath = process.env.PATH;
      process.env.PATH = fx.path;
      try { await createSkillPr('demo'); } finally { process.env.PATH = oldPath; }
      expect(readFileSync(fx.ghLog, 'utf8')).toContain(`pr list --repo ${target}`);
    });
  }

  it('NAMED MISSING INSTALL TARGET ABORTS BEFORE SKILL OR NETWORK ACTION', async () => {
    const fx = fixture();
    rmSync(join(fx.root, 'community'), { recursive: true });
    process.env.CTX_FRAMEWORK_ROOT = fx.root;
    const oldPath = process.env.PATH;
    process.env.PATH = fx.path;
    try {
      await expect(createSkillPr('demo')).rejects.toThrow(/Missing install-level.*Re-run install\.mjs/);
    } finally { process.env.PATH = oldPath; }
    expect(existsSync(fx.ghLog)).toBe(false);
  });

  it('NAMED INVALID INSTALL TARGET ABORTS FAIL-CLOSED', () => {
    const fx = fixture('attacker/repository');
    expect(() => resolveSkillPrTarget(fx.root)).toThrow(/Invalid install-level.*Allowed values/);
    expect(existsSync(fx.ghLog)).toBe(false);
  });
});
