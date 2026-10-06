import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
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
import { updateCommand } from '../../../src/cli/update.js';
import { detectChatIdCommand } from '../../../src/cli/detect-chat-id.js';

describe('member update apply and chat-ID checkout', () => {
  let root: string;
  let checkout: string;
  let savedArgv: string[];
  const previous = 'a'.repeat(40);
  function run(binary = 'ascendops') {
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
    for (const [, , options] of mocks.exec.mock.calls) expect(options.cwd).toBe(checkout);
    expect(mocks.check.mock.calls).toEqual([[checkout, { apply: false }], [checkout, { apply: true }]]);
    const buildOrder = mocks.exec.mock.invocationCallOrder[npmCalls().length + 1];
    expect(console.log).toHaveBeenLastCalledWith(expect.stringContaining('Restart your agents'));
    expect(console.log).toHaveBeenLastCalledWith(expect.stringContaining('ascendops restart <agent>'));
    expect(console.log).toHaveBeenLastCalledWith(expect.stringContaining('pm2 restart cortextos-daemon'));
    expect(vi.mocked(console.log).mock.invocationCallOrder.at(-1)).toBeGreaterThan(buildOrder);
    expect(process.env.CORTEXTOS_CONFIRM_UPSTREAM_MERGE).toBe('');
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
      expect(console.error).toHaveBeenCalledWith(expect.stringContaining('retry npm'));
      expect(vi.mocked(console.log).mock.calls.some(([text]) => String(text).includes('Updates applied'))).toBe(false);
      if (failure === 'ci') expect(npmCalls().map(([, args]) => args)).toEqual([['ci']]);
    });
  }
  it('dirty checkout refuses before merge or npm commands', async () => {
    mocks.exec.mockImplementation((bin, args) => bin === 'git' && args[0] === 'status' ? ' M local-file' : previous);
    await expect(run()).rejects.toThrow('exit:1');
    expect(mocks.check).toHaveBeenCalledExactlyOnceWith(checkout, { apply: false });
    expect(npmCalls()).toHaveLength(0);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('Commit or stash'));
  });
  it('merge conflict aborts and exits nonzero with no install/build/success', async () => {
    mocks.check.mockImplementation((_root, options) => options.apply ? { status: 'conflict' } : { status: 'updates_available' });
    await expect(run()).rejects.toThrow('exit:1');
    expect(mocks.exec).toHaveBeenCalledWith('git', ['merge', '--abort'], expect.objectContaining({ cwd: checkout }));
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
  it('cortextos update uses the same clean merge install build contract', async () => {
    vi.stubEnv('CORTEXTOS_DIR', checkout);
    await run('cortextos');
    expect(npmCalls().map(([, args]) => args)).toEqual([['ci'], ['run', 'build']]);
    expect(console.log).toHaveBeenLastCalledWith(expect.stringContaining('cortextos restart <agent>'));
  });
});
