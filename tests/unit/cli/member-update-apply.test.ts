import { testEnv } from './member-update-test-env.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync, symlinkSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Command } from 'commander';

const mocks = vi.hoisted(() => ({ home: '', check: vi.fn(), exec: vi.fn() }));
vi.mock('os', async original => ({ ...await original<typeof import('node:os')>(), homedir: () => mocks.home }));
vi.mock('child_process', () => ({ execFileSync: mocks.exec }));
vi.mock('../../../src/bus/metrics.js', () => ({ checkUpstream: mocks.check }));
vi.mock('../../../src/telegram/api.js', () => ({ TelegramAPI: class {
  async getMe() { return { result: { username: 'example_bot', id: 1 } }; }
  async getUpdates() { return { result: [{ message: { text: '/start', chat: { id: 2 }, from: { id: 3 } } }] }; }
} }));
import { generateEcosystem } from '../../../src/cli/ecosystem.js';
import { updateCommand } from '../../../src/cli/update.js';
import { detectChatIdCommand } from '../../../src/cli/detect-chat-id.js';

describe('member update apply and chat-ID checkout', () => {
  let root: string;
  let checkout: string;
  let savedArgv: string[];
  const previous = 'a'.repeat(40);
  function run(binary = 'ascendops') {
    const implementation = mocks.exec.getMockImplementation();
    mocks.exec.mockImplementation((bin, args, options) => {
      if (bin === 'git' && !existsSync(join(checkout, '.git'))) {
        if (args[0] === 'symbolic-ref') return 'main';
        if (args[0] === 'remote') return 'fixture';
        if (args.includes('@{upstream}')) return 'origin/main';
        if (args.includes('--git-path')) return join(root, 'no-operation');
      }
      const result = implementation?.(bin, args, options);
      if (bin === 'npm' || bin === 'npm.cmd') {
        const name = args[0] === 'ci' ? 'node_modules' : 'dist';
        mkdirSync(join(options.cwd, name), { recursive: true });
        if (name === 'dist') writeFileSync(join(options.cwd, name, 'cli.js'), '// built fixture');
      }
      return result;
    });
    updateCommand.setOptionValue('check', false);
    return new Command(binary).addCommand(updateCommand).parseAsync(['node', binary, 'update', '--yes']);
  }
  function capture(binary = 'ascendops') {
    return new Command(binary).addCommand(detectChatIdCommand).parseAsync([
      'node', binary, 'detect-chat-id', '--agent', 'worker', '--org', 'example-org', '--token', '1:example', '--yes', '--json',
    ]);
  }
  function npmCalls() { return mocks.exec.mock.calls.filter(([bin]) => bin === 'npm' || bin === 'npm.cmd'); }
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'member-apply-'));
    mocks.home = root;
    vi.stubEnv('HOME', root);
    for (const key of ['ASCENDOPS_DIR', 'CORTEXTOS_DIR', 'CTX_FRAMEWORK_ROOT', 'CTX_PROJECT_ROOT', 'BOT_TOKEN', 'CORTEXTOS_CONFIRM_UPSTREAM_MERGE']) vi.stubEnv(key, '');
    checkout = join(root, 'ascendops');
    mkdirSync(checkout);
    writeFileSync(join(checkout, 'package.json'), JSON.stringify({ name: 'cortextos' }));
    const unrelated = join(root, 'unrelated');
    mkdirSync(unrelated);
    vi.spyOn(process, 'cwd').mockReturnValue(unrelated);
    savedArgv = process.argv;
    process.argv = [process.execPath, join(unrelated, 'command.js')];
    vi.spyOn(process, 'exit').mockImplementation(code => { throw new Error(`exit:${code}`); });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    mocks.check.mockReset().mockImplementation((_root, options) => options.apply ? { status: 'merged' } : { status: 'updates_available', commits: 1 });
    mocks.exec.mockReset().mockImplementation((bin, args) => bin === 'git' && args[0] === 'rev-parse' ? previous : '');
  });
  afterEach(() => {
    process.argv = savedArgv;
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  });
  it('installs locked dependencies then builds in the resolved checkout before success', async () => {
    await expect(run()).resolves.toBeDefined();
    expect(npmCalls().map(([, args]) => args)).toEqual([['ci'], ['run', 'build']]);
    for (const [bin, , options] of mocks.exec.mock.calls) {
      if (bin === 'git') expect(options.cwd).toBe(checkout);
      else if (bin === 'npm') expect(options.cwd.startsWith(join(checkout, '.ascendops-update-backups'))).toBe(true);
    }
    expect(mocks.check.mock.calls.map(([dir, options]) => [dir, options.apply])).toEqual([[checkout, false], [checkout, true]]);
    const buildOrder = mocks.exec.mock.invocationCallOrder[npmCalls().length + 1];
    expect(console.log).toHaveBeenLastCalledWith(expect.stringContaining('Restart your agents'));
    expect(console.log).toHaveBeenLastCalledWith(expect.stringContaining('ascendops restart <agent>'));
    expect(console.log).toHaveBeenLastCalledWith(expect.stringContaining('pm2 restart cortextos-daemon'));
    expect(vi.mocked(console.log).mock.invocationCallOrder.at(-1)).toBeGreaterThan(buildOrder);
    expect(process.env.CORTEXTOS_CONFIRM_UPSTREAM_MERGE).toBe('');
  });
  it('update Git, dependency install and build do not inherit a planted session credential', async () => {
    vi.stubEnv('CTX_HEARTBEAT_SESSION', 'worker:planted-session-nonce');
    await run();
    expect(mocks.exec.mock.calls.length).toBeGreaterThanOrEqual(4);
    for (const [, , options] of mocks.exec.mock.calls) {
      expect(Boolean(options.env)).toBe(true);
      expect(options.env?.CTX_HEARTBEAT_SESSION).toBeUndefined();
      expect(options.env.PATH).toBe(process.env.PATH);
    }
    expect(process.env.CTX_HEARTBEAT_SESSION).toBe('worker:planted-session-nonce');
  });
  for (const [failure, expected] of [['ci', 'Dependency installation'], ['build', 'Build']] as const) {
    it(`${failure} failure exits nonzero without success and gives retry and rollback`, async () => {
      mocks.exec.mockImplementation((bin, args) => {
        if ((bin === 'npm' || bin === 'npm.cmd') && args.includes(failure)) throw new Error('fixture failure');
        return bin === 'git' && args[0] === 'rev-parse' ? previous : '';
      });
      await expect(run()).rejects.toThrow('exit:1');
      expect(console.error).toHaveBeenCalledWith(expect.stringContaining(`${expected} failed.`));
      expect(console.error).toHaveBeenCalledWith(expect.stringContaining('merged but the runtime is not rebuilt'));
      expect(console.error).toHaveBeenCalledWith(expect.stringContaining(`git reset --hard ${previous}`));
      expect(console.error).toHaveBeenCalledWith(expect.stringContaining('retry with ascendops update'));
      expect(vi.mocked(console.log).mock.calls.some(([text]) => String(text).includes('Updates applied'))).toBe(false);
      if (failure === 'ci') expect(npmCalls().map(([, args]) => args)).toEqual([['ci']]);
    });
  }
  it('dirty checkout refuses before merge or npm commands', async () => {
    mocks.exec.mockImplementation((bin, args) => bin === 'git' && args[0] === 'status' ? ' M local-file' : previous);
    await expect(run()).rejects.toThrow('exit:1');
    expect(mocks.check.mock.calls.map(([dir, options]) => [dir, options.apply])).toEqual([[checkout, false]]);
    expect(npmCalls()).toHaveLength(0);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('Commit or stash'));
  });
  for (const outcome of ['success', 'regeneration-failure', 'install-failure', 'build-failure', 'merge-failure', 'interrupt', 'other-dirt', 'untracked-dirt'] as const) it(`real generated config ${outcome}: saved and restored before merge`, async () => {
    vi.stubEnv('CTX_HEARTBEAT_SESSION', 'worker:planted-session-nonce');
    const { execFileSync: realExec } = await vi.importActual<typeof import('child_process')>('child_process');
    const git = (args: string[]) => realExec('git', args, { cwd: checkout, encoding: 'utf8', env: testEnv() });
    git(['init', '-qb', 'main']);
    git(['config', 'user.name', 'Example Contributors']);
    git(['config', 'user.email', 'fixture@example.com']);
    writeFileSync(join(checkout, '.gitignore'), 'orgs/\n/.ascendops-update-backups\n');
    writeFileSync(join(checkout, 'ecosystem.config.js'), '// tracked template\n');
    git(['add', '.']);
    git(['commit', '-qm', 'fixture']); git(['remote', 'add', 'origin', '.']); git(['update-ref', 'refs/remotes/origin/main', 'HEAD']); git(['branch', '--set-upstream-to=origin/main', 'main']);
    const before = git(['rev-parse', 'HEAD']).trim();
    git(['checkout', '-qb', 'next']);
    writeFileSync(join(checkout, 'ecosystem.config.js'), '// upstream template change\n');
    git(['add', 'ecosystem.config.js']);
    git(['commit', '-qm', 'new template']);
    git(['checkout', '-q', 'main']);
    mkdirSync(join(checkout, 'orgs', 'example-org', 'agents', 'worker'), { recursive: true });
    generateEcosystem({ instance: 'other', org: 'example-org', output: join(checkout, 'ecosystem.config.js') }, checkout);
    const generated = readFileSync(join(checkout, 'ecosystem.config.js'), 'utf8');
    expect(git(['status', '--porcelain'])).toBe(' M ecosystem.config.js\n');
    if (outcome === 'other-dirt') writeFileSync(join(checkout, 'package.json'), JSON.stringify({ name: 'cortextos', local: true }));
    if (outcome === 'untracked-dirt') writeFileSync(join(checkout, 'notes.txt'), 'local work');
    mocks.exec.mockImplementation((bin, args, options) => {
      expect(Boolean(options.env)).toBe(true);
      expect(options.env?.CTX_HEARTBEAT_SESSION).toBeUndefined();
      if (bin === 'npm' && ((outcome === 'install-failure' && args[0] === 'ci') || (outcome === 'build-failure' && args[1] === 'build'))) throw new Error('fixture npm failure');
      if (bin === 'git') return realExec(bin, args, { ...options, env: testEnv({ CTX_HEARTBEAT_SESSION: options.env.CTX_HEARTBEAT_SESSION }) });
      if (bin === process.execPath) {
        if (outcome === 'regeneration-failure') throw new Error('fixture regeneration failure');
        expect(args.slice(1, 6)).toEqual(['ecosystem', '--instance', 'other', '--org', 'example-org']);
        expect(args[6]).toBe('--output');
        expect(args).toContain('--quiet');
        expect(options.env.CTX_FRAMEWORK_ROOT).toBe(checkout);
        expect(options.env.CTX_PROJECT_ROOT).toBe(checkout);
        generateEcosystem({ instance: 'other', org: 'example-org', output: args[7], quiet: true }, checkout);
      }
      return '';
    });
    const signalsBefore = { SIGINT: process.listenerCount('SIGINT'), SIGTERM: process.listenerCount('SIGTERM') };
    let observation: { sigint: number; sigterm: number; porcelain: string; template: string } | undefined;
    let interruptObservation: { exit: string; bytes: string; message: string } | undefined;
    mocks.check.mockImplementation((_root, options) => {
      if (!options.apply) return { status: 'updates_available' };
      observation = {
        sigint: process.listenerCount('SIGINT'), sigterm: process.listenerCount('SIGTERM'),
        porcelain: git(['status', '--porcelain']),
        template: readFileSync(join(checkout, 'ecosystem.config.js'), 'utf8'),
      };
      if (outcome === 'interrupt') {
        let exit = '';
        try { process.emit('SIGINT'); } catch (error) { exit = String(error); }
        interruptObservation = {
          exit, bytes: readFileSync(join(checkout, 'ecosystem.config.js'), 'utf8'),
          message: String(vi.mocked(console.error).mock.calls.find(([text]) => String(text).startsWith('Update interrupted (SIGINT)'))?.[0]),
        };
        return { status: 'error' }; // process.exit is intercepted by the fixture
      }
      if (outcome === 'merge-failure') return { status: 'error' };
      git(['merge', '--ff-only', 'next']);
      return { status: 'merged' };
    });
    if (outcome === 'success') {
      await expect(run()).resolves.toBeDefined();
      expect(readFileSync(join(checkout, 'ecosystem.config.js'), 'utf8')).toBe(generated);
    } else {
      await expect(run()).rejects.toThrow('exit:1');
      expect(readFileSync(join(checkout, 'ecosystem.config.js'), 'utf8')).toBe(generated);
      const step = { 'regeneration-failure': 'PM2 config regeneration failed', 'install-failure': 'Dependency installation failed', 'build-failure': 'Build failed', 'merge-failure': 'Upstream merge failed', 'interrupt': 'Update interrupted (SIGINT)', 'other-dirt': 'Update refused', 'untracked-dirt': 'Update refused' }[outcome];
      expect(console.error).toHaveBeenCalledWith(expect.stringContaining(step));
      expect(vi.mocked(console.log).mock.calls.some(([text]) => String(text).includes('Updates applied'))).toBe(false);
    }
    if (outcome !== 'other-dirt' && outcome !== 'untracked-dirt') {
      expect(observation).toEqual({ sigint: signalsBefore.SIGINT + 1, sigterm: signalsBefore.SIGTERM + 1, porcelain: '', template: '// tracked template\n' });
    }
    if (outcome === 'interrupt') {
      expect(interruptObservation?.exit).toContain('exit:130');
      expect(interruptObservation?.bytes).toBe(generated);
      expect(interruptObservation?.message).toContain(join(checkout, '.ascendops-update-backups'));
    }
    expect(process.listenerCount('SIGINT')).toBe(signalsBefore.SIGINT);
    expect(process.listenerCount('SIGTERM')).toBe(signalsBefore.SIGTERM);
    const preflightChatter = vi.mocked(console.log).mock.calls.filter(([text]) => String(text).includes('pm2 start '));
    expect(preflightChatter).toHaveLength(1); // only the fixture's initial generator, never update's probes
    const expectedNpm = ['other-dirt', 'untracked-dirt', 'merge-failure', 'interrupt'].includes(outcome) ? [] : outcome === 'install-failure' ? [['ci']] : [['ci'], ['run', 'build']];
    expect(npmCalls().map(([, args]) => args)).toEqual(expectedNpm);
    if (outcome === 'other-dirt' || outcome === 'untracked-dirt') return;
    if (outcome !== 'merge-failure' && outcome !== 'interrupt') expect(git(['show', 'HEAD:ecosystem.config.js'])).toBe('// upstream template change\n');
    const calls = outcome === 'success' ? vi.mocked(console.log).mock.calls : vi.mocked(console.error).mock.calls;
    const message = calls.find(([text]) => String(text).includes('config is saved at '))?.[0] as string;
    const backup = message.split('saved at ')[1].slice(0, -1);
    expect(backup.startsWith(join(checkout, '.ascendops-update-backups') + '/')).toBe(true);
    expect(git(['check-ignore', backup]).trim()).toBe(backup);
    expect(readFileSync(backup, 'utf8')).toBe(generated);
    rmSync(join(backup, '..'), { recursive: true, force: true });
  });
  it('hand-edited generated config is refused and preserved (real generator, real git)', async () => {
    const { execFileSync: realExec } = await vi.importActual<typeof import('child_process')>('child_process');
    const git = (args: string[]) => realExec('git', args, { cwd: checkout, encoding: 'utf8', env: testEnv() });
    git(['init', '-qb', 'main']); git(['config', 'user.name', 'Example']); git(['config', 'user.email', 'fixture@example.com']);
    writeFileSync(join(checkout, '.gitignore'), 'orgs/\n/.ascendops-update-backups\n');
    writeFileSync(join(checkout, 'ecosystem.config.js'), '// tracked template\n');
    git(['add', '.']); git(['commit', '-qm', 'fixture']); git(['remote', 'add', 'origin', '.']); git(['update-ref', 'refs/remotes/origin/main', 'HEAD']); git(['branch', '--set-upstream-to=origin/main', 'main']);
    mkdirSync(join(checkout, 'orgs', 'example-org', 'agents', 'worker'), { recursive: true });
    generateEcosystem({ instance: 'other', org: 'example-org', output: join(checkout, 'ecosystem.config.js') }, checkout);
    const edited = readFileSync(join(checkout, 'ecosystem.config.js'), 'utf8') + '// member edit\n';
    writeFileSync(join(checkout, 'ecosystem.config.js'), edited);
    expect(git(['status', '--porcelain'])).toBe(' M ecosystem.config.js\n');
    mocks.exec.mockImplementation((bin, args, options) => bin === 'git' ? realExec(bin, args, { ...options, env: testEnv({ CTX_HEARTBEAT_SESSION: options.env.CTX_HEARTBEAT_SESSION }) }) : '');
    mocks.check.mockImplementation((_r, o) => o.apply ? { status: 'merged' } : { status: 'updates_available', commits: 1 });
    await expect(run()).rejects.toThrow('exit:1');
    expect(readFileSync(join(checkout, 'ecosystem.config.js'), 'utf8')).toBe(edited);
    expect(npmCalls()).toHaveLength(0);
  });
  it('backup-directory symlink refuses and preserves config and outside data', async () => {
    const { execFileSync: realExec } = await vi.importActual<typeof import('child_process')>('child_process');
    const git = (args: string[]) => realExec('git', args, { cwd: checkout, encoding: 'utf8', env: testEnv() });
    git(['init', '-qb', 'main']); git(['config', 'user.name', 'Example']); git(['config', 'user.email', 'fixture@example.com']);
    writeFileSync(join(checkout, '.gitignore'), 'orgs/\n/.ascendops-update-backups\n');
    writeFileSync(join(checkout, 'ecosystem.config.js'), '// tracked template\n');
    git(['add', '.']); git(['commit', '-qm', 'fixture']); git(['remote', 'add', 'origin', '.']); git(['update-ref', 'refs/remotes/origin/main', 'HEAD']); git(['branch', '--set-upstream-to=origin/main', 'main']);
    mkdirSync(join(checkout, 'orgs', 'example-org', 'agents', 'worker'), { recursive: true });
    generateEcosystem({ instance: 'other', org: 'example-org', output: join(checkout, 'ecosystem.config.js'), quiet: true }, checkout);
    const generated = readFileSync(join(checkout, 'ecosystem.config.js'), 'utf8');
    const outside = join(root, 'outside'); mkdirSync(outside);
    symlinkSync(outside, join(checkout, '.ascendops-update-backups'), 'dir');
    expect(git(['status', '--porcelain'])).toBe(' M ecosystem.config.js\n');
    mocks.exec.mockImplementation((bin, args, options) => bin === 'git' ? realExec(bin, args, { ...options, env: testEnv({ CTX_HEARTBEAT_SESSION: options.env.CTX_HEARTBEAT_SESSION }) }) : '');
    await expect(run()).rejects.toThrow('exit:1');
    expect(readFileSync(join(checkout, 'ecosystem.config.js'), 'utf8')).toBe(generated);
    expect(readdirSync(outside)).toEqual([]);
    expect(npmCalls()).toHaveLength(0);
    expect(mocks.check.mock.calls).toHaveLength(1);
  });
  it('a handwritten config change is refused and preserved', async () => {
    writeFileSync(join(checkout, 'ecosystem.config.js'), '// personal changes\n');
    mocks.exec.mockImplementation((_bin, args) => args[0] === 'status' ? ' M ecosystem.config.js\n' : previous);
    await expect(run()).rejects.toThrow('exit:1');
    expect(readFileSync(join(checkout, 'ecosystem.config.js'), 'utf8')).toBe('// personal changes\n');
    expect(npmCalls()).toHaveLength(0);
  });
  it('merge conflict aborts and exits nonzero with no install/build/success', async () => {
    mocks.check.mockImplementation((_root, options) => options.apply ? { status: 'conflict' } : { status: 'updates_available' });
    await expect(run()).rejects.toThrow('exit:1');
    expect(mocks.exec.mock.calls.map(([bin, args, options]) => [bin, args, options.cwd])).toContainEqual(['git', ['merge', '--abort'], checkout]);
    expect(npmCalls()).toHaveLength(0);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('Upstream merge failed'));
    expect(vi.mocked(console.log).mock.calls.some(([text]) => String(text).includes('Updates applied'))).toBe(false);
  });
  it('merge error exits nonzero and never installs or reports success', async () => {
    mocks.check.mockImplementation((_root, options) => options.apply ? { status: 'error' } : { status: 'updates_available' });
    await expect(run()).rejects.toThrow('exit:1');
    expect(npmCalls()).toHaveLength(0);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining(`git reset --hard ${previous}`));
  });
  it('chat-ID capture writes only to the member agent from unrelated cwd with legacy also present', async () => {
    const relative = join('orgs', 'example-org', 'agents', 'worker');
    const memberAgent = join(checkout, relative);
    const legacyAgent = join(root, 'cortextos', relative);
    mkdirSync(memberAgent, { recursive: true });
    mkdirSync(legacyAgent, { recursive: true });
    vi.stubEnv('CORTEXTOS_DIR', join(root, 'cortextos'));
    await capture();
    expect(existsSync(join(memberAgent, '.env'))).toBe(true);
    expect(readFileSync(join(memberAgent, '.env'), 'utf8')).toContain('CHAT_ID=2');
    expect(() => readFileSync(join(legacyAgent, '.env'))).toThrow();
  });
  it('chat-ID capture refuses upstream-only member mode', async () => {
    // Leave the member package present but with no orgs; legacy orgs cannot win.
    mkdirSync(join(root, 'cortextos', 'orgs', 'example-org', 'agents', 'worker'), { recursive: true });
    vi.stubEnv('ASCENDOPS_DIR', join(root, 'missing-install'));
    mocks.home = join(root, 'other-home');
    await expect(capture()).rejects.toThrow('AscendOps checkout not found');
  });
  it('chat-ID override wins over the home member checkout', async () => {
    const override = join(root, 'override');
    const relative = join('orgs', 'example-org', 'agents', 'worker');
    mkdirSync(join(override, relative), { recursive: true });
    writeFileSync(join(override, 'package.json'), JSON.stringify({ name: 'cortextos' }));
    mkdirSync(join(checkout, relative), { recursive: true });
    vi.stubEnv('ASCENDOPS_DIR', override);
    await capture();
    expect(readFileSync(join(override, relative, '.env'), 'utf8')).toContain('CHAT_ID=2');
    expect(() => readFileSync(join(checkout, relative, '.env'))).toThrow();
  });
  it('cortextos chat-ID capture retains its legacy resolver', async () => {
    const agent = join(root, 'cortextos', 'orgs', 'example-org', 'agents', 'worker');
    mkdirSync(agent, { recursive: true });
    vi.stubEnv('CORTEXTOS_DIR', join(root, 'cortextos'));
    await capture('cortextos');
    expect(readFileSync(join(agent, '.env'), 'utf8')).toContain('CHAT_ID=2');
  });
  it('cortextos update retains the operator merge-only contract', async () => {
    vi.stubEnv('CORTEXTOS_DIR', checkout);
    await run('cortextos');
    expect(npmCalls()).toHaveLength(0);
    expect(mocks.check).toHaveBeenLastCalledWith(checkout, { apply: true });
  });
});
