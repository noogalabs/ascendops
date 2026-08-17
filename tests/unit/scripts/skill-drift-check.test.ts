import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const repoRoot = join(__dirname, '../../..');
const scriptPath = join(repoRoot, 'scripts', 'skill-drift-check.mjs');

function run(root: string, args: string[] = []) {
  try {
    const stdout = execFileSync(process.execPath, [scriptPath, '--root', root, ...args], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { status: 0, stdout, stderr: '' };
  } catch (err: any) {
    return {
      status: err.status ?? 1,
      stdout: err.stdout?.toString() ?? '',
      stderr: err.stderr?.toString() ?? '',
    };
  }
}

function seedSkill(root: string, path: string, files: Record<string, string>) {
  for (const [file, content] of Object.entries(files)) {
    const abs = join(root, path, file);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, content, 'utf-8');
  }
}

function seedManifest(root: string, mirrors: string[], expectedTrackedPopulation = 0) {
  mkdirSync(join(root, 'scripts'), { recursive: true });
  writeFileSync(join(root, 'scripts', 'skill-mirrors.json'), JSON.stringify([
    {
      skill: 'demo',
      canonical: 'templates/base/.claude/skills/demo',
      expectedPopulation: mirrors.length + 1,
      expectedTrackedPopulation,
      mirrors,
      note: 'test group',
    },
  ], null, 2));
}

function seedPopulationManifest(root: string, includeBetaOnDisk = true) {
  mkdirSync(join(root, 'scripts'), { recursive: true });
  writeFileSync(join(root, 'scripts/skill-mirrors.json'), JSON.stringify([{
    skill: 'demo',
    canonical: 'templates/alpha/.claude/skills/demo',
    population: 'test.templates',
    layouts: ['claude'],
  }]));
  writeFileSync(join(root, 'scripts/fleet-populations.json'), JSON.stringify([{
    schemaVersion: 1,
    population: 'test.templates',
    expectedPopulation: 2,
    root: 'templates',
    discovery: { kind: 'direct-children', marker: 'AGENTS.md' },
    layouts: { claude: { skillHome: '.claude/skills' } },
    subjects: [
      { id: 'alpha', layout: 'claude', tracked_root: true },
      { id: 'beta', layout: 'claude', tracked_root: true },
    ],
  }]));
  for (const id of includeBetaOnDisk ? ['alpha', 'beta'] : ['alpha']) {
    mkdirSync(join(root, `templates/${id}`), { recursive: true });
    writeFileSync(join(root, `templates/${id}/AGENTS.md`), `${id}\n`);
  }
}

describe('skill-drift-check', () => {
  let root = '';

  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it('exits 0 when a mirror is identical', () => {
    root = mkdtempSync(join(tmpdir(), 'skill-drift-'));
    seedManifest(root, ['templates/other/.claude/skills/demo']);
    seedSkill(root, 'templates/base/.claude/skills/demo', {
      'SKILL.md': 'same\n',
      'scripts/a.sh': 'echo same\n',
    });
    seedSkill(root, 'templates/other/.claude/skills/demo', {
      'SKILL.md': 'same\n',
      'scripts/a.sh': 'echo same\n',
    });

    const result = run(root);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('OK templates/other/.claude/skills/demo');
  });

  it('fails loud and names the differing file for a one-character drift', () => {
    root = mkdtempSync(join(tmpdir(), 'skill-drift-'));
    seedManifest(root, ['templates/other/.claude/skills/demo']);
    seedSkill(root, 'templates/base/.claude/skills/demo', { 'SKILL.md': 'same\n' });
    seedSkill(root, 'templates/other/.claude/skills/demo', { 'SKILL.md': 'same!\n' });

    const result = run(root);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('DRIFT templates/other/.claude/skills/demo');
    expect(result.stdout).toContain('different: SKILL.md');
  });

  it('fails loud when a canonical file is missing from a mirror', () => {
    root = mkdtempSync(join(tmpdir(), 'skill-drift-'));
    seedManifest(root, ['templates/other/.claude/skills/demo']);
    seedSkill(root, 'templates/base/.claude/skills/demo', {
      'SKILL.md': 'same\n',
      'scripts/a.sh': 'echo same\n',
    });
    seedSkill(root, 'templates/other/.claude/skills/demo', { 'SKILL.md': 'same\n' });

    const result = run(root);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('missing: scripts/a.sh');
  });

  it('--fix dry-run writes nothing', () => {
    root = mkdtempSync(join(tmpdir(), 'skill-drift-'));
    seedManifest(root, ['templates/other/.claude/skills/demo']);
    seedSkill(root, 'templates/base/.claude/skills/demo', { 'SKILL.md': 'canonical\n' });
    seedSkill(root, 'templates/other/.claude/skills/demo', { 'SKILL.md': 'mirror\n' });
    const before = readFileSync(join(root, 'templates/other/.claude/skills/demo/SKILL.md'), 'utf-8');

    const result = run(root, ['--fix']);
    const after = readFileSync(join(root, 'templates/other/.claude/skills/demo/SKILL.md'), 'utf-8');

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('would copy canonical');
    expect(after).toBe(before);
  });

  it('--fix --write overwrites only declared mirror files and warns', () => {
    root = mkdtempSync(join(tmpdir(), 'skill-drift-'));
    seedManifest(root, ['templates/other/.claude/skills/demo']);
    seedSkill(root, 'templates/base/.claude/skills/demo', { 'SKILL.md': 'canonical\n' });
    seedSkill(root, 'templates/other/.claude/skills/demo', { 'SKILL.md': 'mirror\n' });
    seedSkill(root, 'templates/unlisted/.claude/skills/demo', { 'SKILL.md': 'do not touch\n' });

    const result = run(root, ['--fix', '--write']);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('WARNING overwrite templates/other/.claude/skills/demo/SKILL.md');
    expect(readFileSync(join(root, 'templates/other/.claude/skills/demo/SKILL.md'), 'utf-8')).toBe('canonical\n');
    expect(readFileSync(join(root, 'templates/unlisted/.claude/skills/demo/SKILL.md'), 'utf-8')).toBe('do not touch\n');
  });

  it('--tier ci skips untracked deployed mirrors while local checks them', () => {
    root = mkdtempSync(join(tmpdir(), 'skill-drift-'));
    execFileSync('git', ['init'], { cwd: root, stdio: 'ignore' });
    seedManifest(root, [
      'templates/other/.claude/skills/demo',
      'orgs/example/agents/live/.claude/skills/demo',
    ], 2);
    seedSkill(root, 'templates/base/.claude/skills/demo', { 'SKILL.md': 'same\n' });
    seedSkill(root, 'templates/other/.claude/skills/demo', { 'SKILL.md': 'same\n' });
    execFileSync('git', ['add', 'scripts/skill-mirrors.json', 'templates/base/.claude/skills/demo/SKILL.md', 'templates/other/.claude/skills/demo/SKILL.md'], { cwd: root });

    const ci = run(root, ['--tier', 'ci']);
    const local = run(root, ['--tier', 'local']);

    expect(ci.status).toBe(0);
    expect(ci.stdout).toContain('SKIP orgs/example/agents/live/.claude/skills/demo: not present in tracked tree');
    expect(local.status).toBe(1);
    expect(local.stdout).toContain('FAIL orgs/example/agents/live/.claude/skills/demo: missing skill directory');
  });

  it('--fix refuses to clobber extra mirror files as agent-customized conflicts', () => {
    root = mkdtempSync(join(tmpdir(), 'skill-drift-'));
    seedManifest(root, ['templates/other/.claude/skills/demo']);
    seedSkill(root, 'templates/base/.claude/skills/demo', { 'SKILL.md': 'same\n' });
    seedSkill(root, 'templates/other/.claude/skills/demo', {
      'SKILL.md': 'same\n',
      'local-note.md': 'custom\n',
    });

    const result = run(root, ['--fix', '--write']);

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('CONFLICT templates/other/.claude/skills/demo');
    expect(existsSync(join(root, 'templates/other/.claude/skills/demo/local-note.md'))).toBe(true);
  });

  it('fails preflight when a declared mirror row disappears without changing the pinned denominator', () => {
    root = mkdtempSync(join(tmpdir(), 'skill-drift-'));
    seedManifest(root, [
      'templates/other/.claude/skills/demo',
      'templates/third/.claude/skills/demo',
    ]);
    seedSkill(root, 'templates/base/.claude/skills/demo', { 'SKILL.md': 'canonical\n' });
    seedSkill(root, 'templates/other/.claude/skills/demo', { 'SKILL.md': 'mirror\n' });
    seedSkill(root, 'templates/third/.claude/skills/demo', { 'SKILL.md': 'third\n' });
    const before = readFileSync(join(root, 'templates/other/.claude/skills/demo/SKILL.md'), 'utf8');
    const manifestPath = join(root, 'scripts/skill-mirrors.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    manifest[0].mirrors.pop();
    writeFileSync(manifestPath, JSON.stringify(manifest));

    const result = run(root, ['--fix', '--write']);
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain('total population mismatch: expected=3 declared=2');
    expect(readFileSync(join(root, 'templates/other/.claude/skills/demo/SKILL.md'), 'utf8')).toBe(before);
  });

  it('uses a population receipt to resolve mirror members', () => {
    root = mkdtempSync(join(tmpdir(), 'skill-drift-'));
    seedPopulationManifest(root);
    seedSkill(root, 'templates/alpha/.claude/skills/demo', { 'SKILL.md': 'same\n' });
    seedSkill(root, 'templates/beta/.claude/skills/demo', { 'SKILL.md': 'same\n' });

    const result = run(root);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('population=test.templates');
    expect(result.stdout).toContain('resolved_targets=2');
    expect(result.stdout).toContain('OK templates/beta/.claude/skills/demo');
  });

  it('completes topology preflight before --fix --write and never skips a missing member', () => {
    root = mkdtempSync(join(tmpdir(), 'skill-drift-'));
    seedPopulationManifest(root, false);
    seedSkill(root, 'templates/alpha/.claude/skills/demo', { 'SKILL.md': 'canonical\n' });
    const before = readFileSync(join(root, 'templates/alpha/.claude/skills/demo/SKILL.md'), 'utf8');

    const result = run(root, ['--tier', 'ci', '--fix', '--write']);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('MISSING=beta');
    expect(result.stdout).not.toContain('SKIP templates/beta');
    expect(readFileSync(join(root, 'templates/alpha/.claude/skills/demo/SKILL.md'), 'utf8')).toBe(before);
  });

  it('pins count fields for every checked-in static mirror group', () => {
    const manifest = JSON.parse(readFileSync(join(repoRoot, 'scripts', 'skill-mirrors.json'), 'utf8'));
    const staticGroups = manifest.filter((group: { population?: string }) => !group.population);

    expect(staticGroups.length).toBeGreaterThan(0);
    for (const group of staticGroups) {
      expect(Number.isSafeInteger(group.expectedPopulation), `${group.skill} total count`).toBe(true);
      expect(group.expectedPopulation).toBe(1 + group.mirrors.length);
      expect(Number.isSafeInteger(group.expectedTrackedPopulation), `${group.skill} tracked count`).toBe(true);
      expect(group.expectedTrackedPopulation).toBeGreaterThanOrEqual(0);
      expect(group.expectedTrackedPopulation).toBeLessThanOrEqual(group.expectedPopulation);
    }
  });
});
