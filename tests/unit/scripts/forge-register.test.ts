import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const repoRoot = join(__dirname, '../../..');
const scriptPath = join(repoRoot, 'scripts', 'forge-register.mjs');
// CTX_FRAMEWORK_ROOT lets the load gate resolve a real YAML parser from the repo.
const env = { ...process.env, CTX_FRAMEWORK_ROOT: repoRoot };

function run(args: string[], extraEnv: Record<string, string> = {}) {
  try {
    const stdout = execFileSync(process.execPath, [scriptPath, ...args], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...env, ...extraEnv },
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

// A skill that passes the combined load gate (name==dir, quoted+imperative
// description, model + context:fork, non-empty triggers, $ARGUMENTS in body,
// no external skill references).
const VALID_SKILL = `---
name: stage-test-skill
description: "You MUST use this skill when exercising the stage stale-file regression."
model: haiku
context: fork
triggers: ["stage test trigger"]
---

Body references $ARGUMENTS and names no other skills.
`;

let tmp: string;
let home: string;

function makeSource(dir: string, files: Record<string, string>): string {
  const skillDir = join(dir, 'stage-test-skill');
  mkdirSync(skillDir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(skillDir, name), content, 'utf-8');
  }
  return skillDir;
}

describe('forge-register stage', () => {
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'forge-register-'));
    // Home must be inside a git repo and NOT look like a live agent runtime dir.
    execFileSync('git', ['init', '-q', tmp]);
    home = join(tmp, 'community', 'skills');
    mkdirSync(home, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('clears stale files on re-stage (rm-before-copy, not a merge)', () => {
    // First stage: source has SKILL.md + an extra file.
    const srcA = makeSource(join(tmp, 'srcA'), {
      'SKILL.md': VALID_SKILL,
      'helper.txt': 'first version helper',
    });
    const first = run(['stage', '--from', srcA, '--home', home]);
    expect(first.status).toBe(0);
    const dest = join(home, 'stage-test-skill');
    expect(existsSync(join(dest, 'helper.txt'))).toBe(true);

    // Re-stage from a source that DROPPED helper.txt. A bare cpSync would merge
    // and leave the stale helper.txt behind; rm-before-copy must remove it.
    const srcB = makeSource(join(tmp, 'srcB'), { 'SKILL.md': VALID_SKILL });
    const second = run(['stage', '--from', srcB, '--home', home]);
    expect(second.status).toBe(0);
    expect(existsSync(join(dest, 'SKILL.md'))).toBe(true);
    expect(existsSync(join(dest, 'helper.txt'))).toBe(false); // stale file gone
  });
});

describe('forge registration teaching', () => {
  it('never teaches patching a live agent runtime as the source edit', () => {
    const optimizer = readFileSync(
      join(repoRoot, 'templates/orchestrator/.claude/skills/skill-optimizer/SKILL.md'),
      'utf8',
    );
    expect(optimizer).not.toMatch(/patch\s+<agent>\/\.claude\/skills\//);
    expect(optimizer).not.toMatch(/patch\s+orgs\/[^\s]+\/agents\/[^\s]+\/\.claude\/skills\//);
    expect(optimizer).toContain('patch templates/<role>/.claude/skills/heartbeat/SKILL.md');
  });
});

type ActivationFixture = {
  frameworkRoot: string;
  orgRoot: string;
  registry: string;
  source: string;
  alphaRuntime: string;
  betaRuntime: string;
};

function makeActivationFixture(kind: 'ordinary' | 'shared-symlink' | 'cross-agent-symlink' | 'outside-root-symlink'): ActivationFixture {
  const frameworkRoot = join(tmp, 'framework');
  const orgRoot = join(frameworkRoot, 'orgs', 'acme');
  const source = makeSource(join(frameworkRoot, 'tracked', 'skills'), { 'SKILL.md': VALID_SKILL });
  const alphaRuntime = join(orgRoot, 'agents', 'alpha', '.claude', 'skills');
  const betaRuntime = join(orgRoot, 'agents', 'beta', 'plugins', 'cortextos-agent-skills', 'skills');
  const registry = join(orgRoot, 'fleet-population.json');

  execFileSync('git', ['init', '-q', frameworkRoot]);
  mkdirSync(join(alphaRuntime, '..'), { recursive: true });
  mkdirSync(join(betaRuntime, '..'), { recursive: true });
  mkdirSync(alphaRuntime);
  mkdirSync(betaRuntime);
  writeFileSync(join(orgRoot, 'agents', 'alpha', 'config.json'), '{}\n');
  writeFileSync(join(orgRoot, 'agents', 'beta', 'config.json'), '{}\n');
  writeFileSync(registry, JSON.stringify({
    schemaVersion: 1,
    population: 'acme.agents',
    expectedPopulation: 2,
    root: 'agents',
    discovery: { kind: 'direct-children', marker: 'config.json' },
    layouts: {
      claude: { skillHome: '.claude/skills' },
      codex: { skillHome: 'plugins/cortextos-agent-skills/skills' },
    },
    subjects: [
      { id: 'alpha', layout: 'claude', tracked_root: true, enabled: true },
      { id: 'beta', layout: 'codex', tracked_root: true, enabled: true },
    ],
  }, null, 2));
  execFileSync('git', ['-C', frameworkRoot, 'add', source, registry]);
  execFileSync('git', [
    '-C', frameworkRoot, '-c', 'user.name=Fixture', '-c', 'user.email=fixture.invalid',
    'commit', '-qm', 'fixture source and registry',
  ]);
  if (kind === 'ordinary') {
    mkdirSync(join(alphaRuntime, 'stage-test-skill'));
    mkdirSync(join(betaRuntime, 'stage-test-skill'));
    writeFileSync(join(alphaRuntime, 'stage-test-skill', 'SKILL.md'), 'old alpha copy');
    writeFileSync(join(betaRuntime, 'stage-test-skill', 'SKILL.md'), 'old beta copy');
  } else if (kind === 'shared-symlink') {
    const shared = join(orgRoot, 'shared-stage-test-skill');
    mkdirSync(shared);
    symlinkSync(shared, join(alphaRuntime, 'stage-test-skill'), 'dir');
    symlinkSync(shared, join(betaRuntime, 'stage-test-skill'), 'dir');
  } else if (kind === 'cross-agent-symlink') {
    mkdirSync(join(betaRuntime, 'stage-test-skill'));
    symlinkSync(join(betaRuntime, 'stage-test-skill'), join(alphaRuntime, 'stage-test-skill'), 'dir');
  } else {
    const outside = join(tmp, 'outside-stage-test-skill');
    mkdirSync(outside);
    symlinkSync(outside, join(alphaRuntime, 'stage-test-skill'), 'dir');
    mkdirSync(join(betaRuntime, 'stage-test-skill'));
  }

  return { frameworkRoot, orgRoot, registry, source, alphaRuntime, betaRuntime };
}

function activate(fixture: ActivationFixture, extraArgs: string[] = [], runtime = fixture.alphaRuntime) {
  return run([
    'activate', '--from', fixture.source, '--runtime', runtime,
    '--gate-approved-by', 'coordinator', '--registry', fixture.registry,
    '--root', fixture.orgRoot, '--population', 'acme.agents', ...extraArgs,
  ]);
}

describe('forge-register activate fanout safety', () => {
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'forge-register-activate-'));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('reports an ordinary fork as missed and activates without a fanout acknowledgement', () => {
    const fixture = makeActivationFixture('ordinary');
    const result = activate(fixture);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('write reaches (1) acme/alpha');
    expect(result.stdout).toContain('registered forks missed (1) acme/beta');
    expect(existsSync(join(fixture.alphaRuntime, 'stage-test-skill', 'SKILL.md'))).toBe(true);
    expect(readFileSync(join(fixture.betaRuntime, 'stage-test-skill', 'SKILL.md'), 'utf-8')).toBe('old beta copy');
  });

  it('refuses a stale multi-member acknowledgement after fanout becomes ordinary', () => {
    const fixture = makeActivationFixture('ordinary');
    const before = readFileSync(join(fixture.alphaRuntime, 'stage-test-skill', 'SKILL.md'), 'utf8');
    const result = activate(fixture, ['--fanout-acknowledged', 'acme/alpha,acme/beta']);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('missing, stale, extra, or duplicate subjects are unsafe');
    expect(readFileSync(join(fixture.alphaRuntime, 'stage-test-skill', 'SKILL.md'), 'utf8')).toBe(before);
  });

  it('uses the Codex-plugin layout from the registry and catches an inbound alias', () => {
    const fixture = makeActivationFixture('cross-agent-symlink');
    const result = activate(fixture, [], fixture.betaRuntime);

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('write reaches (2) acme/alpha, acme/beta');
    expect(result.stderr).toContain('measured runtime fanout requires acknowledgement');
    expect(existsSync(join(fixture.betaRuntime, 'stage-test-skill', 'SKILL.md'))).toBe(false);
  });

  it('refuses a cross-subject whole skill-home alias even with a fanout acknowledgement', () => {
    const fixture = makeActivationFixture('ordinary');
    const target = join(fixture.alphaRuntime, 'stage-test-skill', 'SKILL.md');
    const before = readFileSync(target, 'utf8');
    rmSync(fixture.betaRuntime, { recursive: true });
    symlinkSync(fixture.alphaRuntime, fixture.betaRuntime, 'dir');

    const result = activate(fixture, ['--fanout-acknowledged', 'acme/alpha,acme/beta']);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('SKILL_HOME_OUTSIDE_SUBJECT=beta');
    expect(result.stderr).toContain('ALIASED_SKILL_HOMES=alpha,beta');
    expect(readFileSync(target, 'utf8')).toBe(before);
  });

  it('activates a regular requested path with an inbound alias only after exact acknowledgement', () => {
    const fixture = makeActivationFixture('cross-agent-symlink');
    const result = activate(
      fixture,
      ['--fanout-acknowledged', 'acme/alpha,acme/beta'],
      fixture.betaRuntime,
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('write reaches (2) acme/alpha, acme/beta');
    expect(readFileSync(join(fixture.alphaRuntime, 'stage-test-skill', 'SKILL.md'), 'utf8')).toBe(VALID_SKILL);
    expect(readFileSync(join(fixture.betaRuntime, 'stage-test-skill', 'SKILL.md'), 'utf8')).toBe(VALID_SKILL);
  });

  it('reverse-enumerates symlink fanout and refuses a missing acknowledgement before writes', () => {
    const fixture = makeActivationFixture('shared-symlink');
    const existing = join(fixture.alphaRuntime, 'stage-test-skill');
    writeFileSync(join(existing, 'SKILL.md'), 'old runtime copy');
    const realExisting = realpathSync(existing);

    const result = activate(fixture);

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('write reaches (2) acme/alpha, acme/beta');
    expect(result.stderr).toContain('--fanout-acknowledged "acme/alpha,acme/beta"');
    expect(readFileSync(join(existing, 'SKILL.md'), 'utf-8')).toBe('old runtime copy');
    expect(existsSync(`${realExisting}.forge-activate-tmp`)).toBe(false);
  });

  it('measures a cross-agent symlink as reaching both agent trees', () => {
    const fixture = makeActivationFixture('cross-agent-symlink');
    const result = activate(fixture);

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('write reaches (2) acme/alpha, acme/beta');
    expect(result.stdout).toContain('registered forks missed (0) (none)');
    expect(result.stdout).toContain(`runtime real destination ${realpathSync(join(fixture.betaRuntime, 'stage-test-skill'))}`);
  });

  it.each([
    ['stale', 'acme/alpha'],
    ['extra', 'acme/alpha,acme/beta,acme/ghost'],
    ['duplicate', 'acme/alpha,acme/alpha,acme/beta'],
  ])('refuses a %s fanout acknowledgement without writing', (_label, acknowledgement) => {
    const fixture = makeActivationFixture('shared-symlink');
    const realDestination = realpathSync(join(fixture.alphaRuntime, 'stage-test-skill'));
    const result = activate(fixture, ['--fanout-acknowledged', acknowledgement]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('missing, stale, extra, or duplicate subjects are unsafe');
    expect(existsSync(join(fixture.alphaRuntime, 'stage-test-skill', 'SKILL.md'))).toBe(false);
    expect(existsSync(`${realDestination}.forge-activate-tmp`)).toBe(false);
  });

  it('activates through a symlink only with the exact measured subject set', () => {
    const fixture = makeActivationFixture('shared-symlink');
    const result = activate(fixture, ['--fanout-acknowledged', 'acme/beta,acme/alpha']);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('write reaches (2) acme/alpha, acme/beta');
    expect(readFileSync(join(fixture.alphaRuntime, 'stage-test-skill', 'SKILL.md'), 'utf-8')).toBe(VALID_SKILL);
    expect(readFileSync(join(fixture.betaRuntime, 'stage-test-skill', 'SKILL.md'), 'utf-8')).toBe(VALID_SKILL);
  });

  it('refuses registry declaration drift before creating a temp or changing runtime bytes', () => {
    const fixture = makeActivationFixture('ordinary');
    const parsed = JSON.parse(readFileSync(fixture.registry, 'utf8'));
    parsed.subjects.pop();
    writeFileSync(fixture.registry, JSON.stringify(parsed, null, 2));
    execFileSync('git', ['-C', fixture.frameworkRoot, 'add', fixture.registry]);
    execFileSync('git', [
      '-C', fixture.frameworkRoot, '-c', 'user.name=Fixture', '-c', 'user.email=fixture.invalid',
      'commit', '-qm', 'reviewed registry count drift',
    ]);
    const before = readFileSync(join(fixture.alphaRuntime, 'stage-test-skill', 'SKILL.md'), 'utf8');

    const result = activate(fixture);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('REGISTRY_COUNT_MISMATCH');
    expect(result.stderr).toContain('EXTRA=beta');
    expect(readFileSync(join(fixture.alphaRuntime, 'stage-test-skill', 'SKILL.md'), 'utf8')).toBe(before);
    expect(existsSync(join(fixture.alphaRuntime, 'stage-test-skill.forge-activate-tmp'))).toBe(false);
  });

  it('refuses an agent runtime without the complete population-registry inputs', () => {
    const fixture = makeActivationFixture('ordinary');
    const before = readFileSync(join(fixture.alphaRuntime, 'stage-test-skill', 'SKILL.md'), 'utf8');
    const result = run([
      'activate', '--from', fixture.source, '--runtime', fixture.alphaRuntime,
      '--gate-approved-by', 'coordinator',
    ]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('agent runtime activation requires --registry, --root, and --population');
    expect(readFileSync(join(fixture.alphaRuntime, 'stage-test-skill', 'SKILL.md'), 'utf8')).toBe(before);
  });

  it('refuses an external alias to an agent runtime when population inputs are absent', () => {
    const fixture = makeActivationFixture('ordinary');
    const runtimeAlias = join(tmp, 'runtime-alias');
    symlinkSync(fixture.alphaRuntime, runtimeAlias, 'dir');
    const target = join(fixture.alphaRuntime, 'stage-test-skill', 'SKILL.md');
    const before = readFileSync(target, 'utf8');
    const result = run([
      'activate', '--from', fixture.source, '--runtime', runtimeAlias,
      '--gate-approved-by', 'coordinator',
    ]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('agent runtime activation requires --registry, --root, and --population');
    expect(readFileSync(target, 'utf8')).toBe(before);
    expect(existsSync(join(fixture.alphaRuntime, 'stage-test-skill.forge-activate-tmp'))).toBe(false);
  });

  it('refuses an untracked population registry before writes', () => {
    const fixture = makeActivationFixture('ordinary');
    execFileSync('git', ['-C', fixture.frameworkRoot, 'rm', '--cached', '-q', fixture.registry]);
    const before = readFileSync(join(fixture.alphaRuntime, 'stage-test-skill', 'SKILL.md'), 'utf8');
    const result = activate(fixture);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('population registry is dirty relative to HEAD/index');
    expect(readFileSync(join(fixture.alphaRuntime, 'stage-test-skill', 'SKILL.md'), 'utf8')).toBe(before);
  });

  it('refuses a dirty registry layout lie that hides an inbound runtime alias', () => {
    const fixture = makeActivationFixture('cross-agent-symlink');
    const parsed = JSON.parse(readFileSync(fixture.registry, 'utf8'));
    parsed.layouts.alternate = { skillHome: '.alternate/skills' };
    parsed.subjects[0].layout = 'alternate';
    writeFileSync(fixture.registry, JSON.stringify(parsed, null, 2));
    const alternate = join(fixture.orgRoot, 'agents', 'alpha', '.alternate', 'skills', 'stage-test-skill');
    mkdirSync(alternate, { recursive: true });
    writeFileSync(join(alternate, 'SKILL.md'), 'unrelated alternate copy');
    const realTarget = join(fixture.betaRuntime, 'stage-test-skill');
    const targetFile = join(realTarget, 'SKILL.md');
    writeFileSync(targetFile, 'old shared bytes');
    const before = readFileSync(targetFile, 'utf8');
    const tmpSibling = `${realTarget}.forge-activate-tmp`;

    const result = activate(fixture, [], fixture.betaRuntime);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('population registry is dirty relative to HEAD/index');
    expect(readFileSync(targetFile, 'utf8')).toBe(before);
    expect(existsSync(tmpSibling)).toBe(false);
  });

  it.each([
    ['assume-unchanged', '--assume-unchanged'],
    ['skip-worktree', '--skip-worktree'],
  ])('refuses unchanged registry bytes with %s visibility state', (_label, flag) => {
    const fixture = makeActivationFixture('ordinary');
    const registryRel = 'orgs/acme/fleet-population.json';
    execFileSync('git', ['-C', fixture.frameworkRoot, 'update-index', flag, '--', registryRel]);
    const target = join(fixture.alphaRuntime, 'stage-test-skill', 'SKILL.md');
    const before = readFileSync(target, 'utf8');
    const tmpSibling = join(fixture.alphaRuntime, 'stage-test-skill.forge-activate-tmp');

    const result = activate(fixture);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('population registry index contains assume-unchanged, skip-worktree, or non-normal visibility state');
    expect(readFileSync(target, 'utf8')).toBe(before);
    expect(existsSync(tmpSibling)).toBe(false);
  });

  it('refuses a tracked source directory replaced by an outside symlink', () => {
    const fixture = makeActivationFixture('ordinary');
    const target = join(fixture.alphaRuntime, 'stage-test-skill', 'SKILL.md');
    const before = readFileSync(target, 'utf8');
    const outside = makeSource(join(tmp, 'outside-source'), {
      'SKILL.md': VALID_SKILL.replace('Body references', 'Outside bytes reference'),
    });
    const outsideRepo = join(tmp, 'outside-source');
    execFileSync('git', ['init', '-q', outsideRepo]);
    execFileSync('git', ['-C', outsideRepo, 'add', '.']);
    execFileSync('git', [
      '-C', outsideRepo, '-c', 'user.name=Fixture', '-c', 'user.email=fixture.invalid',
      'commit', '-qm', 'outside reviewed source',
    ]);
    rmSync(fixture.source, { recursive: true });
    symlinkSync(outside, fixture.source, 'dir');

    const result = activate(fixture);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('tracked source must be a lexical non-symlink directory');
    expect(readFileSync(target, 'utf8')).toBe(before);
  });

  it('refuses a modified tracked source file before runtime writes', () => {
    const fixture = makeActivationFixture('ordinary');
    const target = join(fixture.alphaRuntime, 'stage-test-skill', 'SKILL.md');
    const before = readFileSync(target, 'utf8');
    writeFileSync(join(fixture.source, 'SKILL.md'), `${VALID_SKILL}\nlocal mutation\n`);

    const result = activate(fixture);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('tracked source is dirty relative to HEAD/index');
    expect(readFileSync(target, 'utf8')).toBe(before);
  });

  it('refuses assume-unchanged source bytes that porcelain hides', () => {
    const fixture = makeActivationFixture('ordinary');
    const target = join(fixture.alphaRuntime, 'stage-test-skill', 'SKILL.md');
    const before = readFileSync(target, 'utf8');
    const sourceRel = 'tracked/skills/stage-test-skill/SKILL.md';
    execFileSync('git', ['-C', fixture.frameworkRoot, 'update-index', '--assume-unchanged', '--', sourceRel]);
    writeFileSync(join(fixture.source, 'SKILL.md'), `${VALID_SKILL}\nhidden assume-unchanged bytes\n`);
    expect(execFileSync('git', [
      '-C', fixture.frameworkRoot, 'status', '--porcelain=v1', '--', sourceRel,
    ], { encoding: 'utf8' }).trim()).toBe('');

    const result = activate(fixture);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('assume-unchanged, skip-worktree, or non-normal visibility state');
    expect(readFileSync(target, 'utf8')).toBe(before);
  });

  it('refuses skip-worktree source bytes that porcelain hides', () => {
    const fixture = makeActivationFixture('ordinary');
    const target = join(fixture.alphaRuntime, 'stage-test-skill', 'SKILL.md');
    const before = readFileSync(target, 'utf8');
    const sourceRel = 'tracked/skills/stage-test-skill/SKILL.md';
    execFileSync('git', ['-C', fixture.frameworkRoot, 'update-index', '--skip-worktree', '--', sourceRel]);
    writeFileSync(join(fixture.source, 'SKILL.md'), `${VALID_SKILL}\nhidden skip-worktree bytes\n`);
    expect(execFileSync('git', [
      '-C', fixture.frameworkRoot, 'status', '--porcelain=v1', '--', sourceRel,
    ], { encoding: 'utf8' }).trim()).toBe('');

    const result = activate(fixture);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('assume-unchanged, skip-worktree, or non-normal visibility state');
    expect(readFileSync(target, 'utf8')).toBe(before);
  });

  it.each([
    ['assume-unchanged', '--assume-unchanged'],
    ['skip-worktree', '--skip-worktree'],
  ])('refuses %s visibility state even when source bytes are unchanged', (_label, flag) => {
    const fixture = makeActivationFixture('ordinary');
    const target = join(fixture.alphaRuntime, 'stage-test-skill', 'SKILL.md');
    const before = readFileSync(target, 'utf8');
    const sourceRel = 'tracked/skills/stage-test-skill/SKILL.md';
    execFileSync('git', ['-C', fixture.frameworkRoot, 'update-index', flag, '--', sourceRel]);

    const result = activate(fixture);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('assume-unchanged, skip-worktree, or non-normal visibility state');
    expect(readFileSync(target, 'utf8')).toBe(before);
  });

  it('refuses an untracked child inside the source tree before runtime writes', () => {
    const fixture = makeActivationFixture('ordinary');
    const target = join(fixture.alphaRuntime, 'stage-test-skill', 'SKILL.md');
    const before = readFileSync(target, 'utf8');
    writeFileSync(join(fixture.source, 'unreviewed.txt'), 'untracked bytes\n');

    const result = activate(fixture);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('tracked source is dirty relative to HEAD/index');
    expect(readFileSync(target, 'utf8')).toBe(before);
  });

  it('refuses an ignored child that porcelain omits but the complete-tree check finds', () => {
    const fixture = makeActivationFixture('ordinary');
    const target = join(fixture.alphaRuntime, 'stage-test-skill', 'SKILL.md');
    const before = readFileSync(target, 'utf8');
    writeFileSync(join(fixture.frameworkRoot, '.git', 'info', 'exclude'), 'unreviewed.txt\n');
    writeFileSync(join(fixture.source, 'unreviewed.txt'), 'ignored unreviewed bytes\n');

    const result = activate(fixture);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('source worktree file set does not exactly match the stage-0 index');
    expect(readFileSync(target, 'utf8')).toBe(before);
  });

  it('refuses a per-skill alias whose real destination escapes the registry root', () => {
    const fixture = makeActivationFixture('outside-root-symlink');
    const result = activate(fixture, ['--fanout-acknowledged', 'acme/alpha']);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('runtime skill destination escapes registry root');
    expect(existsSync(join(tmp, 'outside-stage-test-skill', 'SKILL.md'))).toBe(false);
  });
});
