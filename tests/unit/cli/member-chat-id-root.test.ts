import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Command } from 'commander';

const mocks = vi.hoisted(() => ({ home: '', exec: vi.fn() }));
vi.mock('os', async original => ({ ...await original<typeof import('node:os')>(), homedir: () => mocks.home }));
vi.mock('child_process', () => ({ execFileSync: mocks.exec }));
vi.mock('../../../src/telegram/api.js', () => ({ TelegramAPI: class {
  async getMe() { return { result: { username: 'example_bot', id: 1 } }; }
  async getUpdates() { return { result: [{ message: { text: '/start', chat: { id: 2 }, from: { id: 3 } } }] }; }
} }));
import { detectChatIdCommand } from '../../../src/cli/detect-chat-id.js';

describe('member chat-ID checkout', () => {
  let root: string;
  let checkout: string;
  let savedArgv: string[];
  function capture(binary = 'ascendops') {
    return new Command(binary).addCommand(detectChatIdCommand).parseAsync([
      'node', binary, 'detect-chat-id', '--agent', 'worker', '--org', 'example-org', '--token', '1:example', '--yes', '--json',
    ]);
  }
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'member-chat-'));
    mocks.home = root;
    vi.stubEnv('HOME', root);
    for (const key of ['ASCENDOPS_DIR', 'CORTEXTOS_DIR', 'CTX_FRAMEWORK_ROOT', 'CTX_PROJECT_ROOT', 'BOT_TOKEN']) vi.stubEnv(key, '');
    checkout = join(root, 'ascendops'); mkdirSync(checkout);
    writeFileSync(join(checkout, 'package.json'), JSON.stringify({ name: 'cortextos' }));
    const unrelated = join(root, 'unrelated'); mkdirSync(unrelated);
    vi.spyOn(process, 'cwd').mockReturnValue(unrelated);
    savedArgv = process.argv; process.argv = [process.execPath, join(unrelated, 'command.js')];
    vi.spyOn(process, 'exit').mockImplementation(code => { throw new Error(`exit:${code}`); });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    mocks.exec.mockReset().mockReturnValue('');
  });
  afterEach(() => {
    process.argv = savedArgv; vi.restoreAllMocks(); vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
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
  it('binary-bound member checkout strips the planted credential during Git discovery', async () => {
    const binaryRoot = join(root, 'linked-member');
    const agent = join(binaryRoot, 'orgs', 'example-org', 'agents', 'worker');
    mkdirSync(agent, { recursive: true }); mkdirSync(join(binaryRoot, 'dist'));
    writeFileSync(join(binaryRoot, 'package.json'), JSON.stringify({ name: 'cortextos' }));
    writeFileSync(join(binaryRoot, 'dist', 'ascendops.js'), '');
    process.argv = [process.execPath, join(binaryRoot, 'dist', 'ascendops.js')];
    vi.stubEnv('CTX_HEARTBEAT_SESSION', 'worker:fake-planted-nonce');
    mocks.exec.mockReturnValue(binaryRoot);
    await capture();
    expect(readFileSync(join(agent, '.env'), 'utf8')).toContain('CHAT_ID=2');
    expect(mocks.exec.mock.calls.length > 0).toBe(true);
    for (const [, , options] of mocks.exec.mock.calls) expect(Boolean(options.env.CTX_HEARTBEAT_SESSION)).toBe(false);
  });
});
