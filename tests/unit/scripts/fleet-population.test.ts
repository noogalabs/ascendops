import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const script = join(process.cwd(), 'scripts/fleet-population.mjs');
const roots: string[] = [];

function fixture(subjects = [
  { id: 'alpha', layout: 'claude', tracked_root: true },
  { id: 'beta', layout: 'codex', tracked_root: true },
]) {
  const root = mkdtempSync(join(tmpdir(), 'fleet-population-'));
  roots.push(root);
  mkdirSync(join(root, 'members'), { recursive: true });
  const registry = {
    schemaVersion: 1,
    population: 'test.members',
    expectedPopulation: subjects.length,
    root: 'members',
    discovery: { kind: 'direct-children', marker: 'config.json' },
    layouts: {
      claude: { skillHome: '.claude/skills' },
      codex: { skillHome: 'plugins/test/skills' },
    },
    subjects,
  };
  writeFileSync(join(root, 'registry.json'), JSON.stringify(registry, null, 2));
  for (const subject of subjects.filter((s) => s.tracked_root)) {
    const home = subject.layout === 'claude' ? '.claude/skills' : 'plugins/test/skills';
    mkdirSync(join(root, 'members', subject.id, home, 'comms'), { recursive: true });
    writeFileSync(join(root, 'members', subject.id, 'config.json'), '{}\n');
    writeFileSync(join(root, 'members', subject.id, home, 'comms/SKILL.md'), `${subject.id}\n`);
  }
  return root;
}

function run(root: string, operation = 'check', extra: string[] = []) {
  try {
    const stdout = execFileSync(process.execPath, [script, operation, '--registry', join(root, 'registry.json'), '--root', root, '--population', 'test.members', ...extra], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { status: 0, stdout, stderr: '' };
  } catch (error: any) {
    return { status: error.status ?? 1, stdout: error.stdout?.toString() ?? '', stderr: error.stderr?.toString() ?? '' };
  }
}

function hash(path: string) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe('fleet population registry', () => {
  it('teaches receipt commands as explicit pre-mutation status gates, never tee-masked pipelines', () => {
    const weekly = readFileSync(join(process.cwd(), 'templates/orchestrator/.claude/skills/weekly-review/SKILL.md'), 'utf8');
    const sweep = readFileSync(join(process.cwd(), 'templates/orchestrator/.claude/skills/fleet-sweep/SKILL.md'), 'utf8');
    expect(weekly).not.toMatch(/fleet-population\.mjs[\s\S]{0,300}\|\s*tee/);
    expect(sweep).not.toMatch(/fleet-population\.mjs[\s\S]{0,300}\|\s*tee/);
    expect(weekly.match(/if ! node scripts\/fleet-population\.mjs paths/g)).toHaveLength(3);
    expect(sweep).toContain('if ! node "$CTX_FRAMEWORK_ROOT/scripts/fleet-population.mjs" paths');
    expect(weekly.indexOf('if ! node scripts/fleet-population.mjs paths')).toBeLessThan(weekly.indexOf('patch --dry-run'));
    expect(weekly).toContain('cat "$FRAMEWORK_TARGETS" >&2; exit 1');
    expect(weekly).toContain('cat "$ORG_TARGETS" >&2; exit 1');
  });

  it('prints a complete receipt and returns layout-resolved paths', () => {
    const root = fixture();
    const checked = run(root);
    expect(checked.status).toBe(0);
    expect(checked.stdout).toContain('expected_population=2');
    expect(checked.stdout).toContain('registry_enumerated_population=2');
    expect(checked.stdout).toContain('registry_subjects=alpha,beta');
    expect(checked.stdout).toContain('observed_population=2');
    expect(checked.stdout).toContain('status=OK');

    const paths = run(root, 'paths', ['--skill', 'comms', '--format', 'json']);
    expect(paths.status).toBe(0);
    const payload = JSON.parse(paths.stdout.trim().split('\n').at(-1)!);
    expect(payload.targets.map((target: any) => target.id)).toEqual(['alpha', 'beta']);
    expect(payload.targets[1].path).toMatch(/members\/beta\/plugins\/test\/skills\/comms$/);
  });

  it('censuses disabled public templates without treating them as canonical skill targets', () => {
    const root = fixture([
      { id: 'canonical', layout: 'claude', tracked_root: true },
      { id: 'public-legacy', layout: 'claude', tracked_root: true, enabled: false },
    ]);
    const paths = run(root, 'paths', ['--skill', 'comms', '--format', 'json']);
    expect(paths.status).toBe(0);
    expect(paths.stdout).toContain('expected_population=2');
    expect(paths.stdout).toContain('observed_population=2');
    expect(paths.stdout).toContain('resolved_targets=1');
    expect(JSON.parse(paths.stdout.trim().split('\n').at(-1)!).targets.map((target: any) => target.id)).toEqual([
      'canonical',
    ]);
  });

  it('replays the seven-of-eight comms glob miss and fails a removed Codex row', () => {
    const subjects = [
      ...Array.from({ length: 7 }, (_, i) => ({ id: `claude-${i}`, layout: 'claude', tracked_root: true })),
      { id: 'agent-codex', layout: 'codex', tracked_root: true },
    ];
    const root = fixture(subjects);
    const oldGlobCount = subjects.filter((s) => s.layout === 'claude').length;
    expect(oldGlobCount).toBe(7);
    expect(JSON.parse(run(root, 'paths', ['--skill', 'comms', '--format', 'json']).stdout.trim().split('\n').at(-1)!).targets).toHaveLength(8);

    const registry = JSON.parse(readFileSync(join(root, 'registry.json'), 'utf8'));
    registry.subjects.pop();
    writeFileSync(join(root, 'registry.json'), JSON.stringify(registry));
    const failed = run(root);
    expect(failed.status).not.toBe(0);
    expect(failed.stdout).toContain('expected_population=8');
    expect(failed.stdout).toContain('registry_enumerated_population=7');
    expect(failed.stdout).toContain('observed_population=8');
    expect(failed.stdout).toContain('EXTRA=agent-codex');
    expect(failed.stdout).not.toContain('status=OK');
  });

  it('replays the heartbeat six-of-ten miss before binding checks', () => {
    const subjects = [
      ...Array.from({ length: 7 }, (_, i) => ({ id: `claude-${i}`, layout: 'claude', tracked_root: true })),
      ...Array.from({ length: 3 }, (_, i) => ({ id: `codex-${i}`, layout: 'codex', tracked_root: true })),
    ];
    const root = fixture(subjects);
    expect(subjects.filter((subject) => subject.layout === 'claude')).toHaveLength(7);
    expect(subjects.slice(0, 6)).toHaveLength(6);
    const result = run(root, 'paths', ['--skill', 'comms', '--format', 'json']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('expected_population=10');
    expect(result.stdout).toContain('registry_enumerated_population=10');
    expect(result.stdout).toContain('observed_population=10');
    expect(JSON.parse(result.stdout.trim().split('\n').at(-1)!).targets).toHaveLength(10);
  });

  it('keeps declared-untracked members in membership but requires their roots absent', () => {
    const root = fixture([
      { id: 'tracked', layout: 'claude', tracked_root: true },
      { id: 'declared-untracked', layout: 'codex', tracked_root: false },
    ]);
    const green = run(root);
    expect(green.status).toBe(0);
    expect(green.stdout).toContain('expected_population=2');
    expect(green.stdout).toContain('tracked_expected=1');
    expect(green.stdout).toContain('tracked_observed=1');
    expect(green.stdout).toContain('declared_untracked_absent=1');

    mkdirSync(join(root, 'members/declared-untracked/plugins/test/skills'), { recursive: true });
    writeFileSync(join(root, 'members/declared-untracked/config.json'), '{}');
    const red = run(root);
    expect(red.status).not.toBe(0);
    expect(red.stdout).toContain('DECLARED_UNTRACKED_PRESENT=declared-untracked');
  });

  it('requires declared-untracked roots for live path resolution while tracked check requires them absent', () => {
    const root = fixture([
      { id: 'tracked', layout: 'claude', tracked_root: true },
      { id: 'owner-local', layout: 'codex', tracked_root: false },
    ]);

    const absent = run(root, 'paths', ['--skill', 'comms', '--format', 'json']);
    expect(absent.status).not.toBe(0);
    expect(absent.stdout).toContain('materialization=all');
    expect(absent.stdout).toContain('MISSING=owner-local');
    expect(absent.stdout).not.toContain('status=OK');

    mkdirSync(join(root, 'members/owner-local/plugins/test/skills/comms'), { recursive: true });
    writeFileSync(join(root, 'members/owner-local/config.json'), '{}\n');
    writeFileSync(join(root, 'members/owner-local/plugins/test/skills/comms/SKILL.md'), 'owner-local\n');
    const live = run(root, 'paths', ['--skill', 'comms', '--format', 'json']);
    expect(live.status).toBe(0);
    expect(live.stdout).toContain('materialization=all');
    expect(live.stdout).toContain('resolved_targets=2');
    expect(JSON.parse(live.stdout.trim().split('\n').at(-1)!).targets.map((target: any) => target.id)).toEqual([
      'tracked', 'owner-local',
    ]);

    const liveRoots = run(root, 'paths', ['--format', 'json']);
    expect(liveRoots.status).toBe(0);
    expect(JSON.parse(liveRoots.stdout.trim().split('\n').at(-1)!).targets.map((target: any) => target.id)).toEqual([
      'tracked', 'owner-local',
    ]);

    const tracked = run(root);
    expect(tracked.status).not.toBe(0);
    expect(tracked.stdout).toContain('materialization=tracked');
    expect(tracked.stdout).toContain('DECLARED_UNTRACKED_PRESENT=owner-local');
  });

  it('fails closed for an eleventh member, omission, layout drift, and duplicate/case IDs', () => {
    const root = fixture();
    const before = hash(join(root, 'members/alpha/.claude/skills/comms/SKILL.md'));
    mkdirSync(join(root, 'members/eleven/.claude/skills/comms'), { recursive: true });
    writeFileSync(join(root, 'members/eleven/config.json'), '{}');
    const extra = run(root);
    expect(extra.status).not.toBe(0);
    expect(extra.stdout).toContain('EXTRA=eleven');
    expect(hash(join(root, 'members/alpha/.claude/skills/comms/SKILL.md'))).toBe(before);

    rmSync(join(root, 'members/eleven'), { recursive: true });
    const registry = JSON.parse(readFileSync(join(root, 'registry.json'), 'utf8'));
    registry.subjects.pop();
    writeFileSync(join(root, 'registry.json'), JSON.stringify(registry));
    expect(run(root).stdout).toMatch(/REGISTRY_COUNT_MISMATCH|registry_enumerated_population=1/);

    registry.subjects.push({ id: 'ALPHA', layout: 'claude', tracked_root: true });
    writeFileSync(join(root, 'registry.json'), JSON.stringify(registry));
    expect(run(root).stderr).toMatch(/case|duplicate/i);
  });

  it('counts and rejects a rogue direct-child symlink instead of hiding it from observation', () => {
    const root = fixture([{ id: 'alpha', layout: 'claude', tracked_root: true }]);
    symlinkSync('alpha', join(root, 'members/rogue'));

    const red = run(root);
    expect(red.status).not.toBe(0);
    expect(red.stdout).toContain('observed_population=2');
    expect(red.stdout).toContain('INVALID_SYMLINK_SUBJECT_ROOT=rogue');
    expect(red.stdout).toContain('EXTRA=rogue');
    expect(red.stdout).not.toContain('status=OK');
  });

  it('rejects a skill home that aliases another subjects owned home', () => {
    const root = fixture([
      { id: 'alpha', layout: 'claude', tracked_root: true },
      { id: 'beta', layout: 'claude', tracked_root: true },
    ]);
    rmSync(join(root, 'members/alpha/.claude/skills'), { recursive: true });
    symlinkSync('../../beta/.claude/skills', join(root, 'members/alpha/.claude/skills'));

    const red = run(root, 'paths', ['--skill', 'comms', '--format', 'json']);
    expect(red.status).not.toBe(0);
    expect(red.stdout).toContain('SKILL_HOME_OUTSIDE_SUBJECT=alpha');
    expect(red.stdout).toContain('ALIASED_SKILL_HOMES=alpha,beta');
    expect(red.stdout).not.toContain('status=OK');
  });

  it('rejects missing markers, unknown layouts, and unsafe or wrong symlinks', () => {
    const root = fixture();
    rmSync(join(root, 'members/alpha/config.json'));
    expect(run(root).stdout).toContain('MISSING=alpha');

    writeFileSync(join(root, 'members/alpha/config.json'), '{}');
    const registry = JSON.parse(readFileSync(join(root, 'registry.json'), 'utf8'));
    registry.subjects[0].layout = 'other';
    writeFileSync(join(root, 'registry.json'), JSON.stringify(registry));
    expect(run(root).stderr).toMatch(/unknown layout/i);

    registry.subjects[0].layout = 'claude';
    registry.bindings = { comms: { layouts: ['claude'], representation: 'symlink', canonical: 'shared/comms' } };
    writeFileSync(join(root, 'registry.json'), JSON.stringify(registry));
    mkdirSync(join(root, 'shared/comms'), { recursive: true });
    rmSync(join(root, 'members/alpha/.claude/skills/comms'), { recursive: true });
    symlinkSync('../../../../../outside', join(root, 'members/alpha/.claude/skills/comms'));
    expect(run(root, 'paths', ['--skill', 'comms', '--format', 'json']).stdout).toMatch(/BROKEN_SYMLINK|OUT_OF_ROOT/);
  });

  it('changes layouts through data without framework changes', () => {
    const root = fixture();
    const registry = JSON.parse(readFileSync(join(root, 'registry.json'), 'utf8'));
    rmSync(join(root, 'members/alpha/.claude'), { recursive: true });
    mkdirSync(join(root, 'members/alpha/new/skills/comms'), { recursive: true });
    writeFileSync(join(root, 'members/alpha/new/skills/comms/SKILL.md'), 'alpha\n');
    expect(run(root, 'paths', ['--skill', 'comms', '--format', 'json']).status).not.toBe(0);
    registry.layouts.new = { skillHome: 'new/skills' };
    registry.subjects[0].layout = 'new';
    writeFileSync(join(root, 'registry.json'), JSON.stringify(registry));
    expect(run(root, 'paths', ['--skill', 'comms', '--format', 'json']).status).toBe(0);
  });

  it('makes pointer representation depend on one exact declared reference', () => {
    const root = fixture();
    const registry = JSON.parse(readFileSync(join(root, 'registry.json'), 'utf8'));
    registry.bindings = {
      comms: {
        subjects: {
          beta: {
            canonical: 'canonical/HEARTBEAT.md',
            pointerReference: 'beta',
            representation: 'pointer',
          },
        },
      },
    };
    mkdirSync(join(root, 'canonical'), { recursive: true });
    writeFileSync(join(root, 'canonical/HEARTBEAT.md'), 'canonical\n');
    writeFileSync(join(root, 'registry.json'), JSON.stringify(registry));
    expect(run(root, 'paths', ['--skill', 'comms', '--format', 'json']).status).toBe(0);

    writeFileSync(join(root, 'members/beta/plugins/test/skills/comms/SKILL.md'), 'not a pointer\n');
    const red = run(root, 'paths', ['--skill', 'comms', '--format', 'json']);
    expect(red.status).not.toBe(0);
    expect(red.stdout).toContain('POINTER_REFERENCE_MISMATCH=beta:occurrences-0');
  });

  it('rejects an unowned requested skill path and malformed registry', () => {
    const root = fixture();
    mkdirSync(join(root, 'members/alpha/alternate/skills/comms'), { recursive: true });
    writeFileSync(join(root, 'members/alpha/alternate/skills/comms/SKILL.md'), 'unowned\n');
    const unowned = run(root, 'paths', ['--skill', 'comms', '--format', 'json']);
    expect(unowned.status).not.toBe(0);
    expect(unowned.stdout).toContain('UNOWNED_TARGET=members/alpha/alternate/skills/comms');
    expect(unowned.stdout).not.toContain('status=OK');

    writeFileSync(join(root, 'registry.json'), '{bad json');
    const malformed = run(root);
    expect(malformed.status).toBe(2);
    expect(malformed.stderr).toContain('Malformed registry');
  });
});
