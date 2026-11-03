import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const { postMessage, tokenSeen } = vi.hoisted(() => ({
  postMessage: vi.fn().mockResolvedValue(undefined), tokenSeen: vi.fn(),
}));
vi.mock('../../../src/slack/api.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/slack/api.js')>();
  return { ...actual, SlackAPI: class {
    constructor(token: string) { tokenSeen(token); }
    postMessage = postMessage;
  } };
});

import { busCommand } from '../../../src/cli/bus.js';

describe('send-slack thread and outbound route', () => {
  let root: string;
  let agentDir: string;
  let previousExitCode: typeof process.exitCode;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'send-slack-thread-'));
    const framework = join(root, 'framework');
    agentDir = join(framework, 'orgs', 'testorg', 'agents', 'test-agent');
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(join(agentDir, '.env'), 'SLACK_BOT_TOKEN=test-token\n');
    vi.stubEnv('CTX_ROOT', join(root, 'state'));
    vi.stubEnv('CTX_INSTANCE_ID', 'default');
    vi.stubEnv('CTX_AGENT_NAME', 'test-agent');
    vi.stubEnv('CTX_ORG', 'testorg');
    vi.stubEnv('CTX_AGENT_DIR', agentDir);
    vi.stubEnv('CTX_FRAMEWORK_ROOT', framework);
    vi.stubEnv('CTX_PROJECT_ROOT', framework);
    vi.stubEnv('SLACK_BOT_TOKEN', '');
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    previousExitCode = process.exitCode;
    process.exitCode = undefined;
    postMessage.mockReset().mockResolvedValue(undefined);
    tokenSeen.mockClear();
    // Commander reuses this module's command object in unit tests. Real CLI
    // invocations have a fresh process, so reset only the per-command option.
    busCommand.commands.find((command) => command.name() === 'send-slack')!.setOptionValue('threadTs', undefined);
  });
  afterEach(() => {
    process.exitCode = previousExitCode;
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    rmSync(root, { recursive: true, force: true });
  });
  const run = (args: string[]) => busCommand.parseAsync(['send-slack', ...args], { from: 'user' });
  const allow = () => writeFileSync(join(agentDir, 'slack.json'), JSON.stringify({
    allowed_channels: ['D-approved'], allowed_users: ['T-test:U-test'],
  }));

  it('passes the original parent timestamp through the actual command parser', async () => {
    allow();
    await run(['D-approved', 'case update', '--thread-ts', '1762182234.000001']);
    expect(postMessage).toHaveBeenCalledWith('D-approved', 'case update', expect.anything(), {
      thread_ts: '1762182234.000001',
    });
    expect(process.exitCode).toBeUndefined();
  });

  it('rejects an unapproved conversation before sending', async () => {
    allow();
    await run(['D-other', 'case update']);
    expect(postMessage).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('allowed_channels'));
  });

  it('rejects channel-name aliases for routed agents', async () => {
    allow();
    await run(['#general', 'case update']);
    expect(postMessage).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it('fails safely on a malformed present route instead of using legacy sending', async () => {
    writeFileSync(join(agentDir, 'slack.json'), '{bad-json');
    await run(['D-approved', 'case update']);
    expect(postMessage).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('routing is invalid'));
  });

  it('rejects a malformed timestamp before sending', async () => {
    await run(['D-approved', 'case update', '--thread-ts', '1e9']);
    expect(postMessage).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it('preserves top-level legacy sending when no route file is configured', async () => {
    await run(['#general', 'status']);
    expect(postMessage).toHaveBeenCalledWith('#general', 'status', undefined, { thread_ts: undefined });
    expect(process.exitCode).toBeUndefined();
  });

  it.each(['send-slack', 'slack-test-send'])('reads quoted credentials consistently in %s', async (command) => {
    writeFileSync(join(agentDir, '.env'), '\uFEFFSLACK_BOT_TOKEN="quoted-test-token"\r\n');
    await busCommand.parseAsync([command, 'D-approved', 'status'], { from: 'user' });
    expect(tokenSeen).toHaveBeenCalledWith('quoted-test-token');
    expect(process.exitCode).toBeUndefined();
  });

  it.each(['send-slack', 'slack-test-send'])('refuses ambient credentials when %s has an unreadable env path', async (command) => {
    rmSync(join(agentDir, '.env'));
    mkdirSync(join(agentDir, '.env'));
    vi.stubEnv('SLACK_BOT_TOKEN', 'ambient-wrong-agent-token');
    await busCommand.parseAsync([command, 'D-approved', 'status'], { from: 'user' });
    expect(tokenSeen).not.toHaveBeenCalled();
    expect(postMessage).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('refusing ambient credentials'));
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain('ambient-wrong-agent-token');
  });

  it('refuses ambient credentials for a broken secrets symlink', async () => {
    rmSync(join(agentDir, '.env'));
    symlinkSync(join(root, 'missing-secrets'), join(agentDir, '.env'));
    vi.stubEnv('SLACK_BOT_TOKEN', 'ambient-wrong-agent-token');
    await run(['D-approved', 'status']);
    expect(tokenSeen).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it('keeps environment-only legacy credentials working when the file is genuinely absent', async () => {
    rmSync(join(agentDir, '.env'));
    vi.stubEnv('SLACK_BOT_TOKEN', 'environment-only-token');
    await run(['D-approved', 'status']);
    expect(tokenSeen).toHaveBeenCalledWith('environment-only-token');
    expect(process.exitCode).toBeUndefined();
  });

  it.each(['send-slack', 'slack-test-send'].flatMap((command) => [
    [command, 'SLACK_APP_TOKEN=own-app-token\n'],
    [command, 'SLACK_BOT_TOKEN=\n'],
    [command, 'SLACK_BOT_TOKEN="  "\n'],
  ]))('%s refuses to fill a partial routed secrets file with ambient credentials', async (command, content) => {
    allow();
    writeFileSync(join(agentDir, '.env'), content);
    vi.stubEnv('SLACK_BOT_TOKEN', 'ambient-wrong-agent-token');
    await busCommand.parseAsync([command, 'D-approved', 'status'], { from: 'user' });
    expect(tokenSeen).not.toHaveBeenCalled();
    expect(postMessage).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('refusing ambient credentials for routed agents'));
  });

  it.each(['send-slack', 'slack-test-send'])('%s permits explicitly scoped ambient credentials for a routed agent with no env file', async (command) => {
    allow();
    rmSync(join(agentDir, '.env'));
    vi.stubEnv('SLACK_BOT_TOKEN', 'scoped-environment-token');
    await busCommand.parseAsync([command, 'D-approved', 'status'], { from: 'user' });
    expect(tokenSeen).toHaveBeenCalledWith('scoped-environment-token');
    expect(process.exitCode).toBeUndefined();
  });

  it('preserves readable partial-file ambient fallback for legacy agents without routing', async () => {
    writeFileSync(join(agentDir, '.env'), 'SLACK_BOT_TOKEN=\n');
    vi.stubEnv('SLACK_BOT_TOKEN', 'legacy-environment-token');
    await run(['D-approved', 'status']);
    expect(tokenSeen).toHaveBeenCalledWith('legacy-environment-token');
    expect(process.exitCode).toBeUndefined();
  });

  it.each(['send-slack', 'slack-test-send'])('%s fails nonzero when no bot token is available', async (command) => {
    writeFileSync(join(agentDir, '.env'), '# No Slack credentials\n');
    await busCommand.parseAsync([command, 'D-approved', 'status'], { from: 'user' });
    expect(tokenSeen).not.toHaveBeenCalled();
    expect(postMessage).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it('applies the outbound conversation allowlist to test sends too', async () => {
    allow();
    await busCommand.parseAsync(['slack-test-send', 'D-other', 'test'], { from: 'user' });
    expect(postMessage).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('allowed_channels'));
  });

  it('test sends reject malformed routing instead of bypassing the route check', async () => {
    writeFileSync(join(agentDir, 'slack.json'), '{bad-json');
    await busCommand.parseAsync(['slack-test-send', 'D-approved', 'test'], { from: 'user' });
    expect(postMessage).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it('emits the real API timestamp string as a proactive parent receipt', async () => {
    const { SlackAPI: ActualSlackAPI } = await vi.importActual<typeof import('../../../src/slack/api.js')>('../../../src/slack/api.js');
    writeFileSync(join(agentDir, 'slack.json'), JSON.stringify({
      allowed_channels: ['D12345'], allowed_users: ['T-test:U-test'],
    }));
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      ok: true, ts: '1762182234.000001', channel: 'D12345',
    })));
    vi.stubGlobal('fetch', fetchMock);
    postMessage.mockImplementationOnce((channel, text, identity, options) => new ActualSlackAPI('test-token').postMessage(channel, text, identity, options));
    await run(['D12345', 'New case']);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).not.toHaveProperty('thread_ts');
    const receipt = JSON.parse(String(vi.mocked(console.log).mock.calls.at(-1)![0]));
    expect(receipt).toEqual({
      status: 'sent', channel: 'D12345', ts: '1762182234.000001',
      thread_ts: '1762182234.000001', new_parent: true,
    });
  });

  it('keeps the original parent in a reply receipt instead of replacing it with the new reply timestamp', async () => {
    postMessage.mockResolvedValueOnce({ ts: '1762182235.000002', channel: 'D12345' });
    await run(['D12345', 'Follow-up', '--thread-ts', '1762182234.000001']);
    const receipt = JSON.parse(String(vi.mocked(console.log).mock.calls.at(-1)![0]));
    expect(receipt.ts).toBe('1762182235.000002');
    expect(receipt.thread_ts).toBe('1762182234.000001');
    expect(receipt.new_parent).toBe(false);
  });

  describe('legacy PROJECT_ROOT-only contexts', () => {
    beforeEach(() => {
      vi.stubEnv('CTX_FRAMEWORK_ROOT', '');
      vi.stubEnv('CORTEXTOS_DIR', '');
      // Older agent shells derive their directory from PROJECT_ROOT too.
      vi.stubEnv('CTX_AGENT_DIR', '');
      allow();
    });

    it.each(['send-slack', 'slack-test-send'])('%s still rejects an out-of-route destination', async (command) => {
      await busCommand.parseAsync([command, 'D-other', 'status'], { from: 'user' });
      expect(postMessage).not.toHaveBeenCalled();
      expect(tokenSeen).not.toHaveBeenCalled();
      expect(process.exitCode).toBe(1);
      expect(console.error).toHaveBeenCalledWith(expect.stringContaining('allowed_channels'));
    });

    it.each(['send-slack', 'slack-test-send'])('%s still rejects partial own credentials instead of borrowing ambient identity', async (command) => {
      writeFileSync(join(agentDir, '.env'), 'SLACK_APP_TOKEN=own-app-token\n');
      vi.stubEnv('SLACK_BOT_TOKEN', 'ambient-wrong-agent-token');
      await busCommand.parseAsync([command, 'D-approved', 'status'], { from: 'user' });
      expect(postMessage).not.toHaveBeenCalled();
      expect(tokenSeen).not.toHaveBeenCalled();
      expect(process.exitCode).toBe(1);
      expect(console.error).toHaveBeenCalledWith(expect.stringContaining('refusing ambient credentials for routed agents'));
    });

    it.each(['send-slack', 'slack-test-send'])('%s sends an approved destination with the routed functional identity', async (command) => {
      await busCommand.parseAsync([command, 'D-approved', 'status'], { from: 'user' });
      expect(postMessage).toHaveBeenCalledTimes(1);
      expect(postMessage.mock.calls[0][0]).toBe('D-approved');
      expect(postMessage.mock.calls[0][2]).toEqual({ username: 'test-agent' });
      expect(tokenSeen).toHaveBeenCalledWith('test-token');
      expect(process.exitCode).toBeUndefined();
    });

    it('infers routing from PROJECT_ROOT for discovery credential loading too', async () => {
      writeFileSync(join(agentDir, '.env'), 'SLACK_BOT_TOKEN=\n');
      vi.stubEnv('SLACK_BOT_TOKEN', 'ambient-wrong-agent-token');
      const exit = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('test exit'); });
      await expect(busCommand.parseAsync(['slack-discover-channels'], { from: 'user' })).rejects.toThrow('test exit');
      expect(exit).toHaveBeenCalledWith(1);
      expect(tokenSeen).not.toHaveBeenCalled();
      expect(console.error).toHaveBeenCalledWith(expect.stringContaining('refusing ambient credentials for routed agents'));
    });
  });
});
