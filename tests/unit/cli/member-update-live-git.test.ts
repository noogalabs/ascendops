import ts from 'typescript';
import { testEnv } from './member-update-test-env.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, copyFileSync, rmSync, chmodSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';

const observed = vi.hoisted(() => ({ build: '', buildEnvs: [] as NodeJS.ProcessEnv[], npmCalls: 0, failInstall: false }));
vi.mock('child_process', async original => {
  const actual = await original<typeof import('child_process')>();
  return { ...actual, execFileSync: (bin: string, args: string[], options: any) => {
    if (bin === 'npm' || bin === 'npm.cmd') {
      observed.npmCalls++;
      if (observed.failInstall) { observed.failInstall = false; throw new Error('fake install failure'); }
      if (args[0] === 'ci') { mkdirSync(join(options.cwd, 'node_modules'), { recursive: true }); return ''; }
      observed.buildEnvs.push(options.env);
      observed.build = actual.execFileSync(process.execPath, ['scripts/prebuild-guard.mjs'], {
        ...options, encoding: 'utf8', stdio: 'pipe',
        cwd: dirname(dirname(options.cwd)),
        env: testEnv({ ASCENDOPS_MEMBER_UPDATE: options.env.ASCENDOPS_MEMBER_UPDATE }),
      });
      mkdirSync(join(options.cwd, 'dist'), { recursive: true });
      writeFileSync(join(options.cwd, 'dist', 'cli.js'), '// built fixture');
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
    writeFileSync(join(source, '.gitignore'), '.cortextos-live-tree\ndist/\nnode_modules/\n/.ascendops-update-backups\n');
    writeFileSync(join(source, 'ecosystem.config.js'), '// tracked PM2 config');
    mkdirSync(join(source, 'scripts'));
    copyFileSync(resolve('scripts/build-branch.mjs'), join(source, 'scripts', 'build-branch.mjs'));
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
    observed.build = ''; observed.buildEnvs = []; observed.npmCalls = 0; observed.failInstall = false;
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
      git(checkout, ['branch', '--set-upstream-to=origin/main', 'main']);
      writeFileSync(join(home, 'git-env.log'), '');
    }
    if (kind === 'fleet') {
      await expect(run('cortextos')).resolves.toBeDefined();
      expect(observed.npmCalls).toBe(0);
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
  for (const unsuitable of ['feature', 'detached', 'wrong-tracking', 'merge', 'rebase-merge', 'rebase-apply'] as const) it(`member preflight refuses ${unsuitable} without changes`, async () => {
    if (unsuitable === 'feature') git(checkout, ['checkout', '-qb', 'feat/example']);
    if (unsuitable === 'detached') git(checkout, ['checkout', '-q', '--detach']);
    if (unsuitable === 'wrong-tracking') git(checkout, ['branch', '--unset-upstream']);
    if (unsuitable === 'merge') writeFileSync(join(checkout, '.git', 'MERGE_HEAD'), git(checkout, ['rev-parse', 'HEAD']) + '\n');
    if (unsuitable.startsWith('rebase-')) mkdirSync(join(checkout, '.git', unsuitable));
    mkdirSync(join(checkout, 'node_modules')); writeFileSync(join(checkout, 'node_modules', 'existing.txt'), 'old dependencies');
    mkdirSync(join(checkout, 'dist')); writeFileSync(join(checkout, 'dist', 'existing.js'), 'old runtime');
    const config = readFileSync(join(checkout, 'ecosystem.config.js'), 'utf8');
    const branch = git(checkout, ['branch', '--show-current']);
    const head = git(checkout, ['rev-parse', 'HEAD']);
    const porcelain = git(checkout, ['status', '--porcelain']);
    await expect(run('ascendops')).rejects.toThrow('exit:1');
    expect(git(checkout, ['rev-parse', 'HEAD'])).toBe(head);
    expect(git(checkout, ['status', '--porcelain'])).toBe(porcelain);
    expect(observed.npmCalls).toBe(0);
    expect(git(checkout, ['branch', '--show-current'])).toBe(branch);
    expect(readFileSync(join(checkout, 'ecosystem.config.js'), 'utf8')).toBe(config);
    expect(readFileSync(join(checkout, 'node_modules', 'existing.txt'), 'utf8')).toBe('old dependencies');
    expect(readFileSync(join(checkout, 'dist', 'existing.js'), 'utf8')).toBe('old runtime');
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('preflight'));
  });
  for (const scenario of ['retry', 'rollback', 'checkpoint-retry'] as const) it(`printed ${scenario} command runs in upstream-only fixture`, async () => {
    const action = scenario === 'rollback' ? 'rollback' : 'retry';
    git(checkout, ['config', 'user.name', 'Example']);
    git(checkout, ['config', 'user.email', 'fixture@example.com']);
    const packageJson = { name: 'cortextos', version: '1.0.0', scripts: { build: 'node scripts/prebuild-guard.mjs && node -e "require(\'fs\').mkdirSync(\'dist\', {recursive:true});require(\'fs\').writeFileSync(\'dist/cli.js\', \'built fixture\')"' } };
    for (const dir of [source, checkout]) {
      writeFileSync(join(dir, 'package.json'), JSON.stringify(packageJson));
      writeFileSync(join(dir, 'package-lock.json'), JSON.stringify({ name: 'cortextos', version: '1.0.0', lockfileVersion: 3, packages: { '': packageJson } }));
      git(dir, ['add', '.']); git(dir, ['commit', '-qm', 'recovery fixture']);
    }
    // Local fixture commits are equal, so upstream can fast-forward rather than conflict.
    git(checkout, ['fetch', 'upstream', 'main']);
    git(checkout, ['reset', '--hard', 'upstream/main']);
    const before = git(checkout, ['rev-parse', 'HEAD']);
    writeFileSync(join(source, 'recovery-update.txt'), 'new tree');
    git(source, ['add', '.']); git(source, ['commit', '-qm', 'recovery update']);
    let checkpoint: string | undefined;
    if (scenario === 'checkpoint-retry') {
      const state = join(checkout, '.ascendops-update-backups'); mkdirSync(state);
      checkpoint = join(state, 'merged-not-built.json');
      writeFileSync(checkpoint, JSON.stringify({ head: before }), { mode: 0o400 });
      expect(() => writeFileSync(checkpoint!, 'forbidden')).toThrow(expect.objectContaining({ code: 'EACCES' }));
    } else observed.failInstall = true;
    await expect(run('ascendops')).rejects.toThrow('exit:1');
    const messages = vi.mocked(console.error).mock.calls.map(([text]) => String(text));
    const recovery = messages.find(text => text.startsWith(scenario === 'checkpoint-retry' ? 'Rebuild checkpoint failed.' : 'Dependency installation failed.'))!;
    if (checkpoint) {
      expect(observed.npmCalls).toBe(0);
      expect(git(checkout, ['rev-parse', 'HEAD'])).toBe(git(source, ['rev-parse', 'HEAD']));
      chmodSync(checkpoint, 0o600);
    }
    expect(recovery.includes('retry with ascendops update')).toBe(true);
    expect(recovery.includes('behind upstream until the next update')).toBe(true);
    expect(recovery.includes('build and dependencies may be inconsistent')).toBe(true);
    expect(recovery.includes('Do not restart your agents until a successful retry')).toBe(true);
    const command = action === 'retry' ? recovery.match(/retry with ([^.]+)\./)![1]
      : recovery.match(/then run: (git reset --hard [0-9a-f]{40})\./)![1];
    expect(command.includes('npm run build') && action === 'retry').toBe(false);
    if (action === 'rollback') expect(command.includes(`git reset --hard ${before}`)).toBe(true);
    const recoveryBin = join(home, 'recovery-bin'); mkdirSync(recoveryBin);
    writeFileSync(join(recoveryBin, 'ascendops'), `#!/bin/sh\nexec "${process.execPath}" "${resolve('node_modules/tsx/dist/cli.mjs')}" "${resolve('src/cli/ascendops.ts')}" "$@"\n`, { mode: 0o700 });
    const cleanPath = process.env.PATH!.split(':').filter(path => path !== join(home, 'bin')).join(':');
    const output = realExec('/bin/sh', ['-c', command], { cwd: checkout, encoding: 'utf8', input: 'y\n',
      env: testEnv({ PATH: recoveryBin + ':' + cleanPath, ASCENDOPS_DIR: checkout,
        npm_config_cache: join(home, 'cache'), TMPDIR: home }) });
    expect(output.includes(action === 'retry' ? 'runtime rebuilt' : 'HEAD is now at')).toBe(true);
    expect(recovery.includes('ALLOW_FEATURE_BUILD')).toBe(false);
    expect(git(checkout, ['rev-parse', 'HEAD'])).toBe(action === 'retry' ? git(source, ['rev-parse', 'HEAD']) : before);
    expect(git(checkout, ['status', '--porcelain'])).toBe('');
    if (action === 'retry') expect(existsSync(join(checkout, '.ascendops-update-backups', 'merged-not-built.json'))).toBe(false);
  });
  it('ordinary up-to-date member checkout is a no-op', async () => {
    git(checkout, ['fetch', 'upstream', 'main']); git(checkout, ['merge', '--ff-only', 'upstream/main']);
    const head = git(checkout, ['rev-parse', 'HEAD']);
    await expect(run('ascendops')).rejects.toThrow('exit:0');
    expect(observed.npmCalls).toBe(0);
    expect(git(checkout, ['rev-parse', 'HEAD'])).toBe(head);
    expect(existsSync(join(checkout, '.ascendops-update-backups'))).toBe(false);
  });
  it('a checkpoint belonging to a different HEAD cannot authorize an automatic rebuild', async () => {
    const oldHead = git(checkout, ['rev-parse', 'HEAD']);
    git(checkout, ['fetch', 'upstream', 'main']); git(checkout, ['merge', '--ff-only', 'upstream/main']);
    const state = join(checkout, '.ascendops-update-backups'); mkdirSync(state);
    writeFileSync(join(state, 'merged-not-built.json'), JSON.stringify({ head: oldHead }));
    await expect(run('ascendops')).rejects.toThrow('exit:0');
    expect(observed.npmCalls).toBe(0);
  });
  for (const kind of ['feature-tracking-main', 'wrong-tracking'] as const) it(`${kind} refuses before changing source or runtime`, async () => {
    if (kind === 'feature-tracking-main') git(checkout, ['checkout', '-qb', 'feature/example', '--track', 'upstream/main']);
    else {
      git(checkout, ['update-ref', 'refs/remotes/upstream/other', 'HEAD']);
      git(checkout, ['branch', '--set-upstream-to=upstream/other', 'main']);
    }
    mkdirSync(join(checkout, 'node_modules'));
    writeFileSync(join(checkout, 'node_modules', 'old.txt'), 'unchanged dependencies');
    const head = git(checkout, ['rev-parse', 'HEAD']);
    const config = readFileSync(join(checkout, 'ecosystem.config.js'), 'utf8');
    const porcelain = git(checkout, ['status', '--porcelain']);
    await expect(run('ascendops')).rejects.toThrow('exit:1');
    expect(git(checkout, ['rev-parse', 'HEAD'])).toBe(head);
    expect(git(checkout, ['status', '--porcelain'])).toBe(porcelain);
    expect(readFileSync(join(checkout, 'ecosystem.config.js'), 'utf8')).toBe(config);
    expect(readFileSync(join(checkout, 'node_modules', 'old.txt'), 'utf8')).toBe('unchanged dependencies');
    expect(observed.npmCalls).toBe(0);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('Member updates require main tracking'));
  });
  it('a dangling rebuild marker is refused without writing through it or merging', async () => {
    const { symlinkSync } = await import('node:fs');
    const state = join(checkout, '.ascendops-update-backups'); mkdirSync(state);
    const outside = join(home, 'must-not-be-created');
    symlinkSync(outside, join(state, 'merged-not-built.json'));
    const head = git(checkout, ['rev-parse', 'HEAD']);
    await expect(run('ascendops')).rejects.toThrow('exit:1');
    expect(git(checkout, ['rev-parse', 'HEAD'])).toBe(head);
    expect(existsSync(outside)).toBe(false);
    expect(observed.npmCalls).toBe(0);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('invalid rebuild marker'));
  });
  it('installer-authorized plain clone allows later manual builds without an updater flag', () => {
    git(checkout, ['fetch', 'upstream', 'main']); git(checkout, ['merge', '--ff-only', 'upstream/main']);
    git(checkout, ['config', '--local', 'ascendops.memberCheckout', 'true']);
    const output = realExec(process.execPath, ['scripts/prebuild-guard.mjs'], { cwd: checkout, encoding: 'utf8', env: testEnv() });
    expect(output).toContain('vs upstream/main');
  });
  for (const gate of ['confirmation', 'non-owner'] as const) it(`real scheduled ${gate} gate preserves source and runtime with zero npm`, () => {
    for (const name of ['dist', 'node_modules']) { mkdirSync(join(checkout, name)); writeFileSync(join(checkout, name, 'original.txt'), `original ${name}`); }
    const npmLog = join(home, 'npm-calls');
    writeFileSync(join(home, 'bin', 'npm'), `#!/bin/sh\nprintf call >> "${npmLog}"\nexit 99\n`, { mode: 0o700 });
    const state = join(home, 'state'); mkdirSync(join(state, 'config'), { recursive: true });
    writeFileSync(join(state, 'config', 'enabled-agents.json'), JSON.stringify({ first: { enabled: true, org: 'fixture' }, second: { enabled: true, org: 'fixture' } }));
    const head = git(checkout, ['rev-parse', 'HEAD']);
    const porcelain = git(checkout, ['status', '--porcelain']);
    const args = [resolve('node_modules/tsx/dist/cli.mjs'), resolve('src/cli/ascendops.ts'), 'bus', 'check-upstream', '--apply', ...(gate === 'non-owner' ? ['--owner-only', '--cron-invocation'] : [])];
    let output = '';
    let exit = 0;
    try {
      output = realExec(process.execPath, args, { cwd: checkout, encoding: 'utf8', timeout: 30000,
        env: testEnv({ PATH: process.env.PATH, ASCENDOPS_DIR: checkout, CTX_ROOT: state, CTX_ORG: 'fixture', CTX_AGENT_NAME: 'second',
          CORTEXTOS_CONFIRM_UPSTREAM_MERGE: gate === 'non-owner' ? 'yes' : '', TEST_GIT_ENV_LOG: join(home, 'git-env.log') }),
      });
    } catch (error) { const child = error as { stdout: string; status: number }; output = String(child.stdout); exit = child.status; }
    expect(() => JSON.parse(output)).not.toThrow();
    const result = JSON.parse(output);
    expect(result.status).toBe(gate === 'confirmation' ? 'error' : 'skipped');
    expect(exit).toBe(gate === 'confirmation' ? 1 : 0);
    expect(git(checkout, ['rev-parse', 'HEAD'])).toBe(head);
    expect(git(checkout, ['status', '--porcelain'])).toBe(porcelain);
    for (const name of ['dist', 'node_modules']) expect(readFileSync(join(checkout, name, 'original.txt'), 'utf8')).toBe(`original ${name}`);
    expect(existsSync(npmLog)).toBe(false);
    expect(existsSync(join(checkout, '.ascendops-update-backups'))).toBe(false);
  });
  for (const cleanupError of [false, true]) it(`two real scheduled member updates retain only the latest previous runtime pair (cleanup error: ${cleanupError})`, () => {
    const pkg = { name: 'cortextos', version: '1.0.0', scripts: { build: 'node -e "require(\'fs\').mkdirSync(\'dist\');require(\'fs\').writeFileSync(\'dist/cli.js\', \'scheduled build\')"' } };
    writeFileSync(join(source, 'package.json'), JSON.stringify(pkg));
    writeFileSync(join(source, 'package-lock.json'), JSON.stringify({ name: pkg.name, version: pkg.version, lockfileVersion: 3, packages: { '': pkg } }));
    git(source, ['add', '.']); git(source, ['commit', '-qm', 'scheduled fixture']);
    const output = realExec(process.execPath, [resolve('node_modules/tsx/dist/cli.mjs'), resolve('src/cli/ascendops.ts'), 'bus', 'check-upstream', '--apply'], {
      cwd: checkout, encoding: 'utf8', timeout: 30000,
      env: testEnv({ PATH: process.env.PATH, ASCENDOPS_DIR: checkout, CORTEXTOS_CONFIRM_UPSTREAM_MERGE: 'yes',
        CTX_HEARTBEAT_SESSION: 'worker:fake-scheduled-session', TEST_GIT_ENV_LOG: join(home, 'git-env.log'),
        npm_config_cache: join(home, 'cache'), TMPDIR: home }),
    });
    expect(output).toContain('Member source, dependencies and runtime updated');
    expect(readFileSync(join(checkout, 'dist', 'cli.js'), 'utf8')).toBe('scheduled build');
    expect(git(checkout, ['rev-parse', 'HEAD'])).toBe(git(source, ['rev-parse', 'HEAD']));
    expect(readFileSync(join(home, 'git-env.log'), 'utf8')).not.toContain('fake-scheduled-session');
    expect(git(checkout, ['config', '--local', '--get', 'ascendops.memberCheckout'])).toBe('true');
    const state = join(checkout, '.ascendops-update-backups');
    const firstStage = readdirSync(state).find(name => name.startsWith('runtime-'))!;
    const failedStage = join(state, 'runtime-failed'); mkdirSync(failedStage); writeFileSync(join(failedStage, '.failed-runtime'), '');
    const blocked = join(state, 'runtime-blocked');
    if (cleanupError) {
      mkdirSync(blocked); writeFileSync(join(blocked, '.failed-runtime'), ''); chmodSync(blocked, 0o000);
      expect(() => readdirSync(blocked)).toThrow(expect.objectContaining({ code: 'EACCES' }));
    }
    pkg.scripts.build = pkg.scripts.build.replace('scheduled build', 'second scheduled build');
    writeFileSync(join(source, 'package.json'), JSON.stringify(pkg));
    writeFileSync(join(source, 'package-lock.json'), JSON.stringify({ name: pkg.name, version: pkg.version, lockfileVersion: 3, packages: { '': pkg } }));
    git(source, ['add', '.']); git(source, ['commit', '-qm', 'second scheduled fixture']);
    let secondOutput = '';
    try { secondOutput = realExec(process.execPath, [resolve('node_modules/tsx/dist/cli.mjs'), resolve('src/cli/ascendops.ts'), 'bus', 'check-upstream', '--apply'], {
      cwd: checkout, encoding: 'utf8', timeout: 30000,
      env: testEnv({ PATH: process.env.PATH, ASCENDOPS_DIR: checkout, CORTEXTOS_CONFIRM_UPSTREAM_MERGE: 'yes', TEST_GIT_ENV_LOG: join(home, 'git-env.log'), npm_config_cache: join(home, 'cache'), TMPDIR: home }),
      stdio: ['ignore', 'pipe', 'pipe'],
    }); } finally { if (cleanupError) chmodSync(blocked, 0o700); }
    const retained = readdirSync(state).filter(name => name.startsWith('runtime-') && name !== 'runtime-blocked');
    expect(secondOutput).toContain('Member source, dependencies and runtime updated');
    if (cleanupError) expect(existsSync(blocked)).toBe(true);
    expect(retained).toHaveLength(1);
    expect(existsSync(join(state, firstStage))).toBe(false);
    expect(existsSync(failedStage)).toBe(false);
    expect(readFileSync(join(state, retained[0], 'previous-runtime', 'dist', 'cli.js'), 'utf8')).toBe('scheduled build');
    expect(readFileSync(join(checkout, 'dist', 'cli.js'), 'utf8')).toBe('second scheduled build');
    expect(existsSync(join(checkout, 'node_modules'))).toBe(true);
    expect(existsSync(join(state, retained[0], 'previous-runtime', 'node_modules'))).toBe(true);
  }, 35000);
  it('static census: every test-side spawn uses testEnv', () => {
    let count = 0;
    for (const name of ['apply', 'root', 'live-git']) {
      const path = resolve(`tests/unit/cli/member-update-${name}.test.ts`);
      const tree = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true);
      function visit(node: ts.Node): void {
        if (ts.isCallExpression(node)) {
          const fn = node.expression;
          const name = ts.isIdentifier(fn) ? fn.text : ts.isPropertyAccessExpression(fn) ? fn.name.text : '';
          if (['realExec', 'execFileSync', 'spawnSync'].includes(name)) {
            count++;
            const options = node.arguments[2];
            const env = options && ts.isObjectLiteralExpression(options)
              ? options.properties.find(prop => ts.isPropertyAssignment(prop) && prop.name.getText(tree) === 'env') : undefined;
            const helperUsed = env && ts.isPropertyAssignment(env) && ts.isCallExpression(env.initializer)
              && ts.isIdentifier(env.initializer.expression) && env.initializer.expression.text === 'testEnv';
            expect(Boolean(helperUsed), `${path}:${tree.getLineAndCharacterOfPosition(node.getStart()).line + 1}`).toBe(true);
          }
        }
        ts.forEachChild(node, visit);
      }
      visit(tree);
    }
    expect(count).toBe(19);
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
    copyFileSync(resolve('scripts/build-branch.mjs'), join(fixture, 'scripts', 'build-branch.mjs'));
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
    vi.stubEnv('MEMBER_TEST_PARENT_SENTINEL', 'fake-guard-parent');
    const guardPath = join(fixture, 'scripts', 'prebuild-guard.mjs');
    const guardSource = readFileSync(guardPath, 'utf8').replace(/^#!.*\n/, '');
    writeFileSync(guardPath, 'console.log("parent-sentinel-absent:" + !Object.hasOwn(process.env, "MEMBER_TEST_PARENT_SENTINEL"));\n' + guardSource);
    const { spawnSync } = require('child_process') as typeof import('child_process');
    const result = spawnSync(process.execPath, ['scripts/prebuild-guard.mjs'], {
      cwd: fixture, encoding: 'utf8', env: testEnv({ ASCENDOPS_MEMBER_UPDATE: layout === 'fleet-upstream' ? '' : '1' }),
    });
    const allowed = layout === 'upstream-contains' || layout === 'fork-origin';
    expect(result.status).toBe(allowed ? 0 : 1);
    const output = result.stdout + result.stderr;
    expect(output.includes('parent-sentinel-absent:true')).toBe(true);
    if (layout === 'origin-behind') expect(output).toContain('from origin/main');
    if (layout === 'upstream-behind') expect(output).toContain('from upstream/main');
    if (layout === 'fork-origin') expect(output).toContain('vs origin/main');
    if (layout === 'fleet-upstream') expect(output).toContain('origin/main not present');
  });

});
