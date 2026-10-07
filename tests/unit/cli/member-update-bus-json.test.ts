import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { testEnv } from './member-update-test-env.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const cli = join(process.cwd(), 'dist', 'ascendops.js');
type Outcome = 'up_to_date' | 'preflight' | 'conflict' | 'build' | 'success';

function fixture(outcome: Outcome) {
  const home = mkdtempSync(join(tmpdir(), 'member-bus-json-')); roots.push(home);
  const upstream = join(home, 'upstream'); const checkout = join(home, 'checkout');
  mkdirSync(upstream); const bin = join(home, 'bin'); mkdirSync(bin);
  const env = testEnv({ HOME: home, TMPDIR: home, ASCENDOPS_DIR: checkout,
    CORTEXTOS_CONFIRM_UPSTREAM_MERGE: 'yes', CTX_HEARTBEAT_SESSION: 'fake:json-test',
    PATH: bin + ':' + process.env.PATH });
  const git = (cwd: string, args: string[]) => execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git(upstream, ['init', '-b', 'main']);
  git(upstream, ['config', 'user.name', 'Fixture']); git(upstream, ['config', 'user.email', 'fixture@example.com']);
  writeFileSync(join(upstream, '.gitignore'), 'dist/\nnode_modules/\n.ascendops-update-backups/\n');
  const pkg = { name: 'ascendops', version: '1.0.0', scripts: { build: 'node build.cjs' } };
  writeFileSync(join(upstream, 'package.json'), JSON.stringify(pkg));
  writeFileSync(join(upstream, 'package-lock.json'), JSON.stringify({ name: pkg.name, version: pkg.version, lockfileVersion: 3, packages: { '': pkg } }));
  writeFileSync(join(upstream, 'content.txt'), 'base\n');
  writeFileSync(join(upstream, 'build.cjs'), "require('fs').mkdirSync('dist',{recursive:true});require('fs').writeFileSync('dist/version.txt','new');console.log('fixture build stdout');console.error('fixture build stderr');");
  git(upstream, ['add', '.']); git(upstream, ['commit', '-m', 'base']);
  git(home, ['clone', upstream, checkout]);
  git(checkout, ['remote', 'add', 'upstream', upstream]);
  git(checkout, ['config', 'user.name', 'Fixture']); git(checkout, ['config', 'user.email', 'fixture@example.com']);
  mkdirSync(join(checkout, 'dist')); writeFileSync(join(checkout, 'dist/version.txt'), 'old');
  mkdirSync(join(checkout, 'node_modules')); writeFileSync(join(checkout, 'node_modules/old.txt'), 'old');
  // Real Git and transaction, deterministic npm stand-in with both output streams.
  writeFileSync(join(bin, 'npm'), '#!/bin/sh\nprintf "fixture npm stdout\\n"\nprintf "fixture npm stderr\\n" >&2\nif [ "$1" = ci ]; then mkdir -p node_modules; else exec "' + process.execPath + '" build.cjs; fi\n', { mode: 0o700 });
  if (outcome !== 'up_to_date') {
    writeFileSync(join(upstream, 'content.txt'), 'upstream\n');
    if (outcome === 'build') writeFileSync(join(upstream, 'build.cjs'), "console.log('fixture broken build stdout');console.error('fixture broken build stderr');process.exit(7);");
    git(upstream, ['add', '.']); git(upstream, ['commit', '-m', 'upstream change']);
  }
  if (outcome === 'preflight') git(checkout, ['checkout', '-b', 'security/local-work']);
  if (outcome === 'conflict') {
    writeFileSync(join(checkout, 'content.txt'), 'local\n');
    git(checkout, ['add', '.']); git(checkout, ['commit', '-m', 'local change']);
  }
  return { home, checkout, env, git };
}

describe('real member bus apply emits one JSON document', () => {
  for (const outcome of ['up_to_date', 'preflight', 'conflict', 'build', 'success'] as const) {
    it(`${outcome}: exactly one JSON stdout, diagnostics stderr, correct exit`, () => {
      expect(existsSync(cli), 'build the member CLI before running this integration cell').toBe(true);
      const f = fixture(outcome);
      const before = f.git(f.checkout, ['rev-parse', 'HEAD']);
      const child = spawnSync(process.execPath, [cli, 'bus', 'check-upstream', '--apply'], {
        cwd: f.home, env: f.env, encoding: 'utf8', timeout: 30000,
      });
      expect(child.error).toBeUndefined();
      const result = JSON.parse(child.stdout);
      const status = outcome === 'success' ? 'applied' : outcome === 'preflight' || outcome === 'build' ? 'error' : outcome;
      expect(result.status).toBe(status);
      expect(child.status).toBe(outcome === 'success' || outcome === 'up_to_date' ? 0 : 1);
      expect(child.stdout).not.toContain('fixture npm');
      expect(child.stdout).not.toContain('fixture build');
      if (outcome === 'up_to_date') expect(child.stderr).toContain('Already up to date');
      else expect(child.stderr).toContain('Upstream updates available');
      if (outcome === 'build' || outcome === 'success') {
        expect(child.stderr).toContain('fixture npm stdout');
        expect(child.stderr).toContain('fixture npm stderr');
        expect(child.stderr).toContain(outcome === 'build' ? 'fixture broken build stdout' : 'fixture build stdout');
        expect(child.stderr).toContain(outcome === 'build' ? 'fixture broken build stderr' : 'fixture build stderr');
      }
      expect(readFileSync(join(f.checkout, 'dist/version.txt'), 'utf8')).toBe(outcome === 'success' ? 'new' : 'old');
      if (outcome === 'preflight' || outcome === 'conflict') expect(f.git(f.checkout, ['rev-parse', 'HEAD'])).toBe(before);
      if (outcome === 'conflict') expect(existsSync(join(f.checkout, '.git/MERGE_HEAD'))).toBe(false);
    }, 40000);
  }
  for (const outcome of ['up_to_date', 'preflight', 'conflict', 'build', 'success'] as const) {
    it(`interactive ${outcome}: retains human stdout and exit code`, () => {
      const f = fixture(outcome);
      const child = spawnSync(process.execPath, [cli, 'update', '--yes'], {
        cwd: f.home, env: f.env, encoding: 'utf8', timeout: 30000,
      });
      expect(child.error).toBeUndefined();
      expect(child.status).toBe(outcome === 'success' || outcome === 'up_to_date' ? 0 : 1);
      expect(child.stdout).toContain(outcome === 'up_to_date' ? 'Already up to date' : 'Upstream updates available');
      if (outcome === 'success') {
        expect(child.stdout).toContain('fixture npm stdout');
        expect(child.stdout).toContain('runtime rebuilt');
      }
    }, 40000);
  }
});
