import { testEnv } from './member-update-test-env.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, copyFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const observed = vi.hoisted(() => ({ build: '', buildEnvs: [] as NodeJS.ProcessEnv[] }));
vi.mock('child_process', async original => {
  const actual = await original<typeof import('child_process')>();
  return { ...actual, execFileSync: (bin: string, args: string[], options: any) => {
    if (bin === 'npm' || bin === 'npm.cmd') {
      if (args[0] === 'ci') return ''; // fresh locked install is independently verified
      observed.buildEnvs.push(options.env);
      observed.build = actual.execFileSync(process.execPath, ['scripts/prebuild-guard.mjs'], {
        ...options, encoding: 'utf8', stdio: 'pipe',
        env: testEnv({ ASCENDOPS_MEMBER_UPDATE: options.env.ASCENDOPS_MEMBER_UPDATE }),
      });
      return '';
    }
    return actual.execFileSync(bin, args, { ...options, env: testEnv({
      PATH: options.env.PATH,
      HOME: options.env.HOME,
      CTX_HEARTBEAT_SESSION: options.env.CTX_HEARTBEAT_SESSION,
      TEST_GIT_ENV_LOG: options.env.TEST_GIT_ENV_LOG,
    }) });
  } };
});
import { updateCommand } from '../../../src/cli/update.js';
import { checkUpstream } from '../../../src/bus/metrics.js';

describe('member update real Git children and live build guard', () => {
  let home: string;
  let checkout: string;
  let source: string;
  let savedArgv: string[];
  let realExec: typeof import('child_process').execFileSync;
  const secret = 'worker:planted-session-nonce';
  const git = (dir: string, args: string[]) => realExec('git', args, { cwd: dir, encoding: 'utf8', env: testEnv() }).trim();
  beforeEach(async () => {
    ({ execFileSync: realExec } = await vi.importActual<typeof import('child_process')>('child_process'));
    savedArgv = process.argv;
    home = mkdtempSync(join(tmpdir(), 'member-real-git-'));
    source = join(home, 'source'); checkout = join(home, 'ascendops'); mkdirSync(source);
    git(source, ['init', '-qb', 'main']);
    git(source, ['config', 'user.name', 'Example']); git(source, ['config', 'user.email', 'fixture@example.com']);
    writeFileSync(join(source, 'package.json'), JSON.stringify({ name: 'cortextos' }));
    writeFileSync(join(source, '.gitignore'), '.cortextos-live-tree\ndist/\n');
    mkdirSync(join(source, 'scripts'));
    copyFileSync(resolve('scripts/prebuild-guard.mjs'), join(source, 'scripts', 'prebuild-guard.mjs'));
    git(source, ['add', '.']); git(source, ['commit', '-qm', 'base']);
    git(home, ['clone', '-q', source, checkout]);
    git(checkout, ['remote', 'rename', 'origin', 'upstream']);
    writeFileSync(join(source, 'new-runtime.txt'), 'new runtime');
    git(source, ['add', '.']); git(source, ['commit', '-qm', 'update']);
    writeFileSync(join(checkout, '.cortextos-live-tree'), '');
    for (const [key, value] of Object.entries({ HOME: home, ASCENDOPS_DIR: checkout, CORTEXTOS_DIR: checkout, CTX_FRAMEWORK_ROOT: '', CTX_PROJECT_ROOT: '', CI: '', GITHUB_ACTIONS: '', ALLOW_FEATURE_BUILD: '', ASCENDOPS_MEMBER_UPDATE: '', CTX_HEARTBEAT_SESSION: secret, CORTEXTOS_CONFIRM_UPSTREAM_MERGE: '', TEST_GIT_ENV_LOG: join(home, 'git-env.log') })) vi.stubEnv(key, value);
    const realGit = realExec('which', ['git'], { encoding: 'utf8', env: testEnv() }).trim();
    const binDir = join(home, 'bin'); mkdirSync(binDir);
    writeFileSync(join(binDir, 'git'), `#!/bin/sh\n# WIPER_TRAP_GUARD_MARKER: test observer delegates to guarded Git\ncase "$1:$2" in rev-parse:--show-toplevel) printf 'resolve:%s\n' "\${CTX_HEARTBEAT_SESSION-unset}" >> "$TEST_GIT_ENV_LOG";; esac\ncase "$1" in fetch|merge) printf '%s:%s\n' "$1" "\${CTX_HEARTBEAT_SESSION-unset}" >> "$TEST_GIT_ENV_LOG";; esac\nexec "${realGit}" "$@"\n`, { mode: 0o700 });
    vi.stubEnv('PATH', binDir + ':' + process.env.PATH);
    writeFileSync(join(checkout, '.git', 'hooks', 'post-merge'), `#!/bin/sh\nprintf 'post-merge:%s\n' "\${CTX_HEARTBEAT_SESSION-unset}" >> "$TEST_GIT_ENV_LOG"\n`, { mode: 0o700 });
    observed.build = ''; observed.buildEnvs = [];
    updateCommand.setOptionValue('check', false);
    vi.spyOn(process, 'exit').mockImplementation(code => { throw new Error(`exit:${code}`); });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => { process.argv = savedArgv; vi.restoreAllMocks(); vi.unstubAllEnvs(); rmSync(home, { recursive: true, force: true }); });
  const run = (binary: string) => new Command(binary).addCommand(updateCommand).parseAsync(['node', binary, 'update', '--yes']);
  for (const kind of ['plain-clone', 'fork', 'fleet'] as const) it(`${kind}: real update fetch/merge children and build guard`, async () => {
    if (kind === 'plain-clone') {
      mkdirSync(join(checkout, 'dist')); writeFileSync(join(checkout, 'dist', 'ascendops.js'), '');
      process.argv = [process.execPath, join(checkout, 'dist', 'ascendops.js')];
    }
    if (kind === 'fork') {
      git(checkout, ['remote', 'add', 'origin', source]);
      git(checkout, ['fetch', 'origin', 'main']);
      writeFileSync(join(home, 'git-env.log'), '');
    }
    if (kind === 'fleet') {
      await expect(run('cortextos')).rejects.toThrow('exit:1');
      expect(console.error).toHaveBeenCalledWith(expect.stringContaining('Build failed'));
      expect(observed.buildEnvs[0].ASCENDOPS_MEMBER_UPDATE).toBe('');
    } else {
      await expect(run('ascendops')).resolves.toBeDefined();
      expect(observed.build).toContain('decision=live-main');
      expect(observed.build).toContain(kind === 'plain-clone' ? 'vs upstream/main' : 'vs origin/main');
      expect(console.log).toHaveBeenLastCalledWith(expect.stringContaining('runtime rebuilt'));
      expect(observed.buildEnvs[0].ASCENDOPS_MEMBER_UPDATE).toBe('1');
    }
    const childLines = readFileSync(join(home, 'git-env.log'), 'utf8').trim().split('\n');
    expect(childLines.filter(line => line.startsWith('fetch:')).length).toBeGreaterThanOrEqual(2);
    expect(childLines).toContain('merge:unset');
    expect(childLines).toContain('post-merge:unset');
    if (kind === 'plain-clone') expect(childLines).toContain('resolve:unset');
    expect(childLines.every(line => line.endsWith(':unset'))).toBe(true);
    expect(process.env.CTX_HEARTBEAT_SESSION).toBe(secret);
    expect(readFileSync(join(checkout, 'new-runtime.txt'), 'utf8')).toBe('new runtime');
  });
  it('test children exclude a planted parent sentinel', () => {
    vi.stubEnv('MEMBER_TEST_PARENT_SENTINEL', 'fake-parent-sentinel');
    const result = realExec(process.execPath, ['-e',
      'process.stdout.write(String(Object.hasOwn(process.env, "MEMBER_TEST_PARENT_SENTINEL")))'],
      { encoding: 'utf8', env: testEnv() });
    expect(result === 'false').toBe(true);
  });
  it('checkUpstream strips real fetch and post-merge children for every caller', () => {
    process.env.CORTEXTOS_CONFIRM_UPSTREAM_MERGE = 'yes';
    expect(checkUpstream(checkout, { apply: true }).status).toBe('merged');
    const lines = readFileSync(join(home, 'git-env.log'), 'utf8').trim().split('\n');
    expect(lines).toContain('fetch:unset');
    expect(lines).toContain('post-merge:unset');
    expect(lines).toContain('merge:unset');
  });
  for (const layout of ['origin-behind', 'upstream-contains', 'upstream-behind', 'no-remotes', 'fork-origin', 'fleet-upstream'] as const) it(`real prebuild guard ${layout}`, () => {
    const fixture = join(home, 'guard-case'); mkdirSync(fixture); mkdirSync(join(fixture, 'scripts'));
    copyFileSync(resolve('scripts/prebuild-guard.mjs'), join(fixture, 'scripts', 'prebuild-guard.mjs'));
    writeFileSync(join(fixture, 'package.json'), JSON.stringify({ name: 'cortextos' }));
    writeFileSync(join(fixture, '.gitignore'), '.cortextos-live-tree\n');
    git(fixture, ['init', '-qb', 'main']); git(fixture, ['config', 'user.name', 'Example']); git(fixture, ['config', 'user.email', 'fixture@example.com']);
    git(fixture, ['add', '.']); git(fixture, ['commit', '-qm', 'base']);
    const base = git(fixture, ['rev-parse', 'HEAD']);
    git(fixture, ['checkout', '-qb', 'future']); writeFileSync(join(fixture, 'future.txt'), 'future');
    git(fixture, ['add', '.']); git(fixture, ['commit', '-qm', 'future']); const future = git(fixture, ['rev-parse', 'HEAD']);
    git(fixture, ['checkout', '-q', 'main']); writeFileSync(join(fixture, '.cortextos-live-tree'), '');
    if (layout !== 'no-remotes') {
      git(fixture, ['remote', 'add', 'upstream', source]);
      git(fixture, ['update-ref', 'refs/remotes/upstream/main', layout === 'upstream-behind' || layout === 'fork-origin' ? future : base]);
    }
    if (layout === 'origin-behind' || layout === 'fork-origin') {
      git(fixture, ['remote', 'add', 'origin', source]);
      git(fixture, ['update-ref', 'refs/remotes/origin/main', layout === 'origin-behind' ? future : base]);
    }
    const { spawnSync } = require('child_process') as typeof import('child_process');
    const result = spawnSync(process.execPath, ['scripts/prebuild-guard.mjs'], {
      cwd: fixture, encoding: 'utf8', env: testEnv({ ASCENDOPS_MEMBER_UPDATE: layout === 'fleet-upstream' ? '' : '1' }),
    });
    const allowed = layout === 'upstream-contains' || layout === 'fork-origin';
    expect(result.status).toBe(allowed ? 0 : 1);
    const output = result.stdout + result.stderr;
    if (layout === 'origin-behind') expect(output).toContain('from origin/main');
    if (layout === 'upstream-behind') expect(output).toContain('from upstream/main');
    if (layout === 'fork-origin') expect(output).toContain('vs origin/main');
    if (layout === 'fleet-upstream') expect(output).toContain('origin/main not present');
  });

});
