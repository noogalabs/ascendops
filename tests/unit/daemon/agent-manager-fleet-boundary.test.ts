import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const telegramSendMessageMock = vi.hoisted(() => vi.fn().mockResolvedValue({ ok: true }));
const codexSpawnMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const codexSetTelegramHandleMock = vi.hoisted(() => vi.fn());

const mockCodexAppServerPty = vi.hoisted(() => ({
  sessionNonce: vi.fn().mockReturnValue(null),
  spawn: codexSpawnMock,
  kill: vi.fn(),
  write: vi.fn(),
  getPid: vi.fn().mockReturnValue(process.pid),
  isAlive: vi.fn().mockReturnValue(true),
  onExit: vi.fn(),
  getOutputBuffer: vi.fn().mockReturnValue({ isBootstrapped: vi.fn().mockReturnValue(true) }),
  setTelegramHandle: codexSetTelegramHandleMock,
}));

vi.mock('../../../src/pty/codex-app-server-pty.js', () => ({
  CodexAppServerPTY: function CodexAppServerPTY() { return mockCodexAppServerPty; },
}));

vi.mock('../../../src/pty/agent-pty.js', () => ({
  AgentPTY: function AgentPTY() { return mockCodexAppServerPty; },
}));

vi.mock('../../../src/pty/hermes-pty.js', () => ({
  HermesPTY: function HermesPTY() { return mockCodexAppServerPty; },
  hermesDbExists: vi.fn().mockReturnValue(false),
}));

vi.mock('../../../src/pty/inject.js', () => ({
  injectMessage: vi.fn(),
  MessageDedup: class { isDuplicate() { return false; } },
}));

vi.mock('../../../src/daemon/fast-checker.js', () => ({
  FastChecker: class {
    async start() { /* no-op */ }
    stop() { /* no-op */ }
    wake() { /* no-op */ }
    resetWatchdogState() { /* no-op */ }
  },
}));

vi.mock('../../../src/telegram/api.js', () => ({
  TelegramAPI: class {
    constructor() { /* no-op */ }
    sendMessage = telegramSendMessageMock;
  },
}));

vi.mock('../../../src/telegram/poller.js', () => ({
  TelegramPoller: class {
    start() { /* no-op */ }
    stop() { /* no-op */ }
    onMessage() { /* no-op */ }
    onCallback() { /* no-op */ }
    onReaction() { /* no-op */ }
  },
}));

vi.mock('../../../src/bus/metrics.js', () => ({
  collectTelegramCommands: vi.fn().mockReturnValue([]),
  registerTelegramCommands: vi.fn().mockResolvedValue({ status: 'ok', count: 0 }),
}));

const { AgentManager } = await import('../../../src/daemon/agent-manager.js');

describe('AgentManager fleet back-online wire boundary', () => {
  let testDir: string;
  let ctxRoot: string;
  let frameworkRoot: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'cortextos-fleet-boundary-'));
    ctxRoot = join(testDir, 'instance');
    frameworkRoot = join(testDir, 'framework');
    mkdirSync(join(ctxRoot, 'config'), { recursive: true });
    telegramSendMessageMock.mockClear();
    codexSpawnMock.mockClear();
    codexSetTelegramHandleMock.mockClear();
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  function writeCodexTelegramAgent(name: string): void {
    const agentDir = join(frameworkRoot, 'orgs', 'acme', 'agents', name);
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(
      join(agentDir, '.env'),
      'BOT_TOKEN=123:abc\nCHAT_ID=chat-1\nALLOWED_USER=42\n',
    );
    writeFileSync(
      join(agentDir, 'config.json'),
      JSON.stringify({ runtime: 'codex-app-server', telegram_polling: false }),
    );
  }

  it('suppresses Codex fresh agent-level sends during daemon boot and emits exactly one consolidated notification', async () => {
    writeCodexTelegramAgent('alice');
    writeCodexTelegramAgent('bob');
    const am = new AgentManager('test-instance', ctxRoot, frameworkRoot, 'acme');

    await am.discoverAndStart();

    expect(codexSpawnMock).toHaveBeenCalledTimes(2);
    for (const [, prompt] of codexSpawnMock.mock.calls) {
      expect(prompt).not.toContain('Send a Telegram message to the user saying you are back online.');
    }
    expect(telegramSendMessageMock).toHaveBeenCalledTimes(1);
    expect(telegramSendMessageMock).toHaveBeenCalledWith('chat-1', 'Fleet back online (2/2 agents)');
    expect(telegramSendMessageMock).not.toHaveBeenCalledWith('chat-1', 'Agent alice is back online');
    expect(telegramSendMessageMock).not.toHaveBeenCalledWith('chat-1', 'Agent bob is back online');
  });
});
