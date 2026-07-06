import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const repoRoot = join(__dirname, '../../..');
const scriptPath = join(repoRoot, 'scripts', 'forge-load-gate.mjs');

// The gate refuses to run without a REAL YAML parser (never regex). The repo
// carries `yaml` as a devDependency for exactly this; CTX_FRAMEWORK_ROOT lets
// deployed agents resolve it from the framework checkout.
const env = { ...process.env, CTX_FRAMEWORK_ROOT: repoRoot };

function run(args: string[]) {
  try {
    const stdout = execFileSync(process.execPath, [scriptPath, ...args], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
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

const GOOD_SKILL = `---
name: demo-skill
description: "You MUST use this skill when the demo trigger fires: it proves the gate."
model: haiku
context: fork
triggers: ["demo trigger"]
---

Parse $ARGUMENTS and run the demo.
`;

let tmp: string;
function seed(name: string, content: string): string {
  const dir = join(tmp, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), content, 'utf-8');
  return dir;
}

// Each test spawns ≥1 child process; 10 s is tight under full-suite parallelism.
describe('forge-load-gate', { timeout: 30000 }, () => {
  afterEach(() => {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  });

  it('passes a fully-featured skill mechanically and still requires the fire-smoke', () => {
    tmp = mkdtempSync(join(tmpdir(), 'forge-gate-'));
    const dir = seed('demo-skill', GOOD_SKILL);
    const res = run([dir]);
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('PASS (mechanical)');
    expect(res.stdout).toContain('MANUAL fire-smoke');
    expect(res.stdout).toContain('"demo trigger"');
  });

  it('fails on the unquoted colon-space break that regex smoke masked (PR #99)', () => {
    tmp = mkdtempSync(join(tmpdir(), 'forge-gate-'));
    const dir = seed('bad-colon', GOOD_SKILL.replace(
      /description: .*/,
      'description: intake: read the meld and triage it',
    ).replace('name: demo-skill', 'name: bad-colon'));
    const res = run([dir]);
    expect(res.status).toBe(1);
    expect(res.stdout).toContain('REAL-YAML rejection');
  });

  it('fails an unquoted free-text description even when it happens to parse', () => {
    tmp = mkdtempSync(join(tmpdir(), 'forge-gate-'));
    const dir = seed('unquoted', GOOD_SKILL.replace(
      /description: .*/,
      'description: plain unquoted text that parses today',
    ).replace('name: demo-skill', 'name: unquoted'));
    const res = run([dir]);
    expect(res.status).toBe(1);
    expect(res.stdout).toContain('not quoted');
  });

  it('fails when name does not match the directory (undiscoverable)', () => {
    tmp = mkdtempSync(join(tmpdir(), 'forge-gate-'));
    const dir = seed('other-dir', GOOD_SKILL);
    const res = run([dir]);
    expect(res.status).toBe(1);
    expect(res.stdout).toContain('!= directory');
  });

  it('fails when the three ship features are missing (forge hard rule 2)', () => {
    tmp = mkdtempSync(join(tmpdir(), 'forge-gate-'));
    const dir = seed('bare-skill', `---
name: bare-skill
description: "End-of-day review workflow without the required features."
---

A body with no arguments hook.
`);
    const res = run([dir]);
    expect(res.status).toBe(1);
    expect(res.stdout).toContain('missing `model`');
    expect(res.stdout).toContain('context: fork');
    expect(res.stdout).toContain('triggers');
    expect(res.stdout).toContain('$ARGUMENTS');
    expect(res.stdout).toContain('imperative');
  });

  it('downgrades ship-feature failures to warnings with --lenient (legacy audit only)', () => {
    tmp = mkdtempSync(join(tmpdir(), 'forge-gate-'));
    const dir = seed('bare-skill', `---
name: bare-skill
description: "Legacy skill being audited, not shipped."
---

Legacy body.
`);
    const res = run([dir, '--lenient']);
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('[lenient]');
  });

  it('fails a referenced skill that does not resolve from the target home tracked tree', () => {
    tmp = mkdtempSync(join(tmpdir(), 'forge-gate-'));
    execFileSync('git', ['init', '-q', tmp]);
    const dir = seed('handoff-skill', GOOD_SKILL.replace('name: demo-skill', 'name: handoff-skill')
      .replace('run the demo.', 'run the demo, then hand off to the `vendor-assign` skill.'));
    const res = run([dir, '--target-home', tmp]);
    expect(res.status).toBe(1);
    expect(res.stdout).toContain('`vendor-assign` does not resolve from target home');
  });

  it('resolves a reference tracked in the SAME target home (anchored, no false-red)', () => {
    tmp = mkdtempSync(join(tmpdir(), 'forge-gate-'));
    execFileSync('git', ['init', '-q', tmp]);
    // target-home is the skills HOME (the dir directly containing skill subdirs).
    const home = join(tmp, 'community', 'skills');
    const refDir = join(home, 'vendor-assign');
    mkdirSync(refDir, { recursive: true });
    writeFileSync(join(refDir, 'SKILL.md'), GOOD_SKILL.replace('name: demo-skill', 'name: vendor-assign'), 'utf-8');
    execFileSync('git', ['-C', tmp, 'add', '.']);
    const dir = seed('handoff-skill', GOOD_SKILL.replace('name: demo-skill', 'name: handoff-skill')
      .replace('run the demo.', 'run the demo, then hand off to the `vendor-assign` skill.'));
    // The sibling `vendor-assign` lives at <home>/vendor-assign — the anchored
    // resolution finds it from a skills-subdir home (the old `*skills/` glob from
    // a subdir cwd false-RED'd this exact case).
    const res = run([dir, '--target-home', home]);
    expect(res.status).toBe(0);
    expect(res.stdout).not.toContain('vendor-assign` does not resolve');
  });

  it('rejects a reference present ELSEWHERE in the repo but absent from the target home (no false-green)', () => {
    tmp = mkdtempSync(join(tmpdir(), 'forge-gate-'));
    execFileSync('git', ['init', '-q', tmp]);
    // vendor-assign is tracked in a DIFFERENT home (templates/other/.claude/skills).
    const otherHome = join(tmp, 'templates', 'other', '.claude', 'skills', 'vendor-assign');
    mkdirSync(otherHome, { recursive: true });
    writeFileSync(join(otherHome, 'SKILL.md'), GOOD_SKILL.replace('name: demo-skill', 'name: vendor-assign'), 'utf-8');
    execFileSync('git', ['-C', tmp, 'add', '.']);
    const dir = seed('handoff-skill', GOOD_SKILL.replace('name: demo-skill', 'name: handoff-skill')
      .replace('run the demo.', 'run the demo, then hand off to the `vendor-assign` skill.'));
    // target-home = REPO ROOT (the case the unanchored `*skills/` glob FALSE-GREENED
    // by matching vendor-assign anywhere in the monorepo). Anchored resolution keys
    // off <home>/vendor-assign/SKILL.md — absent here — so it correctly REJECTS.
    const res = run([dir, '--target-home', tmp]);
    expect(res.status).toBe(1);
    expect(res.stdout).toContain('`vendor-assign` does not resolve from target home');
  });
});
