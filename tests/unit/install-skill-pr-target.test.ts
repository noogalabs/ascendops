import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { persistSkillPrTarget, skillPrTargetForOrigin } from '../../scripts/install-skill-pr-target.mjs';

const roots: string[] = [];
function repo(origin?: string) {
  const root = mkdtempSync(join(tmpdir(), 'install-skill-pr-target-'));
  roots.push(root);
  execFileSync('git', ['init', '-q'], { cwd: root });
  if (origin) execFileSync('git', ['remote', 'add', 'origin', origin], { cwd: root });
  return root;
}
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

describe('installer persists the real install role', () => {
  it('NAMED REAL MEMBER-FORK INSTALL EMITS HUB TARGET', () => {
    const root = repo('https://github.com/member/ascendops.git');
    expect(persistSkillPrTarget(root)).toBe('noogalabs/ascendops');
    expect(execFileSync('git', ['config', '--local', '--get', 'cortextos.skillPrTarget'], { cwd: root, encoding: 'utf8' }).trim()).toBe('noogalabs/ascendops');
  });

  it('NAMED REAL CANONICAL INSTALL EMITS OWEN TARGET', () => {
    const root = repo();
    expect(persistSkillPrTarget(root)).toBe('grandamenium/cortextos');
    expect(execFileSync('git', ['config', '--local', '--get', 'cortextos.skillPrTarget'], { cwd: root, encoding: 'utf8' }).trim()).toBe('grandamenium/cortextos');
  });

  it('NAMED EXISTING CANONICAL ORIGIN MIGRATION CLASSIFIES CANONICAL', () => {
    expect(skillPrTargetForOrigin('https://github.com/noogalabs/ascendops.git')).toBe('grandamenium/cortextos');
    expect(skillPrTargetForOrigin('git@github.com:grandamenium/cortextos.git')).toBe('grandamenium/cortextos');
  });
});
