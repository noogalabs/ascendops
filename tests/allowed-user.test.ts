import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { rawDaemonInjection } from '../src/utils/validate.js';

type TelegramMessageHandler = (msg: {
  from?: { id?: number; first_name?: string; username?: string };
  chat?: { id?: number | string };
  text?: string;
}) => void;

const fastCheckerInstances: Array<{
  options: { telegramApi?: unknown; chatId?: string; allowedUserId?: number; allowedUserIds?: number[] };
  queued: string[];
}> = [];

const pollerInstances: Array<{
  onMessageHandler?: TelegramMessageHandler;
  start: ReturnType<typeof vi.fn>;
}> = [];

vi.mock('../src/daemon/agent-process.js', () => ({
  AgentProcess: class {
    private name: string;
    private config: Record<string, unknown>;

    constructor(name: string, _dir: unknown, config: Record<string, unknown> = {}) {
      this.name = name;
      this.config = config;
    }

    setTelegramHandle() { /* no-op */ }
    onStatusChanged() { /* no-op */ }
    onExit() { /* no-op */ }
    async start() { /* no-op */ }
    async stop() { /* no-op */ }
    getStatus() { return { name: this.name, status: 'running' }; }
    getConfig() { return this.config; }
  },
}));

vi.mock('../src/daemon/fast-checker.js', () => ({
  FastChecker: class {
    queued: string[] = [];
    options: { telegramApi?: unknown; chatId?: string; allowedUserId?: number; allowedUserIds?: number[] };

    constructor(_agentProcess: unknown, _paths: unknown, _frameworkRoot: string, options: { telegramApi?: unknown; chatId?: string; allowedUserId?: number; allowedUserIds?: number[] }) {
      this.options = options;
      fastCheckerInstances.push(this);
    }

    static formatTelegramTextMessage(_from: string, _chatId: string | number, text: string) {
      return rawDaemonInjection(text);
    }

    static readLastSent() {
      return null;
    }

    isDuplicate() {
      return false;
    }

    queueTelegramMessage(formatted: { kind: 'raw'; content: string }) {
      this.queued.push(formatted.content);
    }

    resetWatchdogState() { /* no-op */ }
    async start() { /* no-op */ }
    stop() { /* no-op */ }
    wake() { /* no-op */ }
  },
}));

vi.mock('../src/telegram/api.js', () => ({
  TelegramAPI: class {
    async sendMessage() { /* no-op */ }
  },
}));

vi.mock('../src/telegram/poller.js', () => ({
  TelegramPoller: class {
    onMessageHandler?: TelegramMessageHandler;
    start = vi.fn();

    constructor() {
      pollerInstances.push(this);
    }

    onMessage(handler: TelegramMessageHandler) {
      this.onMessageHandler = handler;
    }

    onCallback() { /* no-op */ }
    onReaction() { /* no-op */ }
    stop() { /* no-op */ }
  },
}));

vi.mock('../src/daemon/cron-migration.js', () => ({
  migrateCronsForAgent: vi.fn(),
}));

vi.mock('../src/bus/metrics.js', () => ({
  collectTelegramCommands: () => [],
  registerTelegramCommands: () => Promise.resolve({ status: 'ok', count: 0 }),
}));

const { AgentManager } = await import('../src/daemon/agent-manager.js');
const { normalizeAllowedUser } = await import('../src/daemon/allowed-user.js');
const {
  SUPPORT_ACCESS_ID,
  addSupportAccess,
  removeSupportAccess,
  getStatus,
} = await import('../src/cli/support-access-core.js');
const {
  SUPPORT_ACCESS_CONFIRMATION,
  confirmSupportAccessOnFirstContact,
  formatSupportAccessShareInstruction,
  resolveAgentHandle,
} = await import('../src/cli/support-access-notify.js');

describe('normalizeAllowedUser', () => {
  it.each([
    ['', null],
    ['123', '123'],
    [' 123 , 456 ', '123,456'],
    ['123,123', '123,123'],
    [',123,456,', '123,456'],
    ['123,abc', null],
    ['   ', null],
  ])('normalizes %j to %j', (input, expected) => {
    expect(normalizeAllowedUser(input)).toBe(expected);
  });
});

describe('AgentManager ALLOWED_USER normalization characterization', () => {
  let testDir: string;
  let agentDir: string;

  beforeEach(() => {
    fastCheckerInstances.length = 0;
    pollerInstances.length = 0;
    testDir = mkdtempSync(join(tmpdir(), 'cortextos-allowed-user-'));
    agentDir = join(testDir, 'framework', 'orgs', 'acme', 'agents', 'alice');
    mkdirSync(agentDir, { recursive: true });
    mkdirSync(join(testDir, 'instance', 'state'), { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  async function startWithEnv(env: string) {
    writeFileSync(join(agentDir, '.env'), env);
    const am = new AgentManager('test-instance', join(testDir, 'instance'), join(testDir, 'framework'), 'acme');
    await am.startAgent('alice', agentDir, { runtime: 'codex-app-server', telegram_polling: true }, 'acme');
  }

  it('accepts comma-separated numeric IDs after trimming whitespace and blank segments', async () => {
    await startWithEnv([
      'BOT_TOKEN=123456:ABC_def-123',
      'CHAT_ID=9999',
      'ALLOWED_USER= 123 , , 456 ',
    ].join('\n'));

    expect(fastCheckerInstances[0].options.allowedUserId).toBe(123);
    expect(fastCheckerInstances[0].options.allowedUserIds).toEqual([123, 456]);
    expect(pollerInstances).toHaveLength(1);

    pollerInstances[0].onMessageHandler?.({
      from: { id: 456, first_name: 'Support' },
      chat: { id: 9999 },
      text: 'allowed through current multi-user gate',
    });

    expect(fastCheckerInstances[0].queued).toEqual(['allowed through current multi-user gate']);
  });

  it('rejects the whole Telegram setup when any ALLOWED_USER token is non-numeric', async () => {
    await startWithEnv([
      'BOT_TOKEN=123456:ABC_def-123',
      'CHAT_ID=9999',
      'ALLOWED_USER=123,abc',
    ].join('\n'));

    expect(fastCheckerInstances[0].options.telegramApi).toBeUndefined();
    expect(fastCheckerInstances[0].options.allowedUserId).toBeUndefined();
    expect(pollerInstances).toHaveLength(0);
  });

  it('accepts SUPPORT_ACCESS_ID after enable and rejects it after disable', async () => {
    const originalCtxRoot = process.env.CTX_ROOT;
    const ctxRoot = join(testDir, 'instance');
    process.env.CTX_ROOT = ctxRoot;
    const envPath = join(agentDir, '.env');
    try {
      writeFileSync(envPath, [
        'BOT_TOKEN=123456:ABC_def-123',
        'CHAT_ID=9999',
        'ALLOWED_USER=111',
      ].join('\n'));
      expect(addSupportAccess(envPath, ctxRoot).ok).toBe(true);

      let am = new AgentManager('test-instance', join(testDir, 'instance'), join(testDir, 'framework'), 'acme');
      await am.startAgent('alice', agentDir, { runtime: 'codex-app-server', telegram_polling: true }, 'acme');
      pollerInstances[0].onMessageHandler?.({
        from: { id: Number(SUPPORT_ACCESS_ID), first_name: 'David' },
        chat: { id: Number(SUPPORT_ACCESS_ID) },
        text: 'support accepted after enable',
      });
      expect(fastCheckerInstances[0].queued).toEqual(['support accepted after enable']);

      expect(removeSupportAccess(envPath, ctxRoot).ok).toBe(true);
      fastCheckerInstances.length = 0;
      pollerInstances.length = 0;

      am = new AgentManager('test-instance', join(testDir, 'instance'), join(testDir, 'framework'), 'acme');
      await am.startAgent('alice', agentDir, { runtime: 'codex-app-server', telegram_polling: true }, 'acme');
      pollerInstances[0].onMessageHandler?.({
        from: { id: Number(SUPPORT_ACCESS_ID), first_name: 'David' },
        chat: { id: Number(SUPPORT_ACCESS_ID) },
        text: 'support rejected after disable',
      });
      expect(fastCheckerInstances[0].queued).toEqual([]);
    } finally {
      if (originalCtxRoot === undefined) {
        delete process.env.CTX_ROOT;
      } else {
        process.env.CTX_ROOT = originalCtxRoot;
      }
    }
  });
});

describe('support-access core ALLOWED_USER mutation', () => {
  let testDir: string;
  let envPath: string;
  let originalCtxRoot: string | undefined;

  beforeEach(() => {
    originalCtxRoot = process.env.CTX_ROOT;
    testDir = mkdtempSync(join(tmpdir(), 'cortextos-support-access-'));
    const agentDir = join(testDir, 'orgs', 'acme', 'agents', 'alice');
    mkdirSync(agentDir, { recursive: true });
    envPath = join(agentDir, '.env');
    process.env.CTX_ROOT = testDir;
  });

  afterEach(() => {
    if (originalCtxRoot === undefined) {
      delete process.env.CTX_ROOT;
    } else {
      process.env.CTX_ROOT = originalCtxRoot;
    }
    rmSync(testDir, { recursive: true, force: true });
  });

  it('adds support access to an already-populated ALLOWED_USER without clobbering existing IDs or keys', () => {
    writeFileSync(envPath, [
      '# existing env',
      'BOT_TOKEN=123456:ABC_def-123',
      'CHAT_ID=9999',
      'ALLOWED_USER=111,222',
      'OTHER_KEY=keep-me',
      '',
    ].join('\n'));

    const result = addSupportAccess(envPath, testDir);
    const content = readFileSync(envPath, 'utf-8');
    const consentPath = join(testDir, 'state', 'alice', 'support-access.jsonl');
    const consentEvents = readFileSync(consentPath, 'utf-8').trim().split('\n').map((line) => JSON.parse(line));

    expect(result).toEqual({ ok: true, allowedUser: `111,222,${SUPPORT_ACCESS_ID}`, changed: true });
    expect(content).toContain('BOT_TOKEN=123456:ABC_def-123');
    expect(content).toContain('CHAT_ID=9999');
    expect(content).toContain('OTHER_KEY=keep-me');
    expect(content).toContain(`ALLOWED_USER=111,222,${SUPPORT_ACCESS_ID}`);
    expect(getStatus(envPath)).toMatchObject({ ok: true, enabled: true });
    expect(consentEvents).toHaveLength(1);
    expect(consentEvents[0]).toMatchObject({
      agent: 'alice',
      action: 'grant',
      supportId: SUPPORT_ACCESS_ID,
    });
  });

  it('is idempotent when support access is already present', () => {
    writeFileSync(envPath, `ALLOWED_USER=111,${SUPPORT_ACCESS_ID}\n`);

    const result = addSupportAccess(envPath, testDir);
    const content = readFileSync(envPath, 'utf-8');

    expect(result).toEqual({ ok: true, allowedUser: `111,${SUPPORT_ACCESS_ID}`, changed: false });
    expect(content.match(new RegExp(SUPPORT_ACCESS_ID, 'g'))).toHaveLength(1);
  });

  it('refuses malformed existing ALLOWED_USER and does not write', () => {
    const original = 'BOT_TOKEN=123456:ABC_def-123\nALLOWED_USER=111,bad\n';
    writeFileSync(envPath, original);

    const result = addSupportAccess(envPath, testDir);

    expect(result.ok).toBe(false);
    expect(result.changed).toBe(false);
    expect(readFileSync(envPath, 'utf-8')).toBe(original);
  });

  it('removes only the support ID and appends a revoke consent record without losing grant history', () => {
    writeFileSync(envPath, 'BOT_TOKEN=123456:ABC_def-123\nALLOWED_USER=111,222\n');

    addSupportAccess(envPath, testDir);
    const result = removeSupportAccess(envPath, testDir);
    const content = readFileSync(envPath, 'utf-8');
    const consentPath = join(testDir, 'state', 'alice', 'support-access.jsonl');
    const consentEvents = readFileSync(consentPath, 'utf-8').trim().split('\n').map((line) => JSON.parse(line));

    expect(result).toEqual({ ok: true, allowedUser: '111,222', changed: true });
    expect(content).toContain('ALLOWED_USER=111,222');
    expect(content).not.toContain(SUPPORT_ACCESS_ID);
    expect(existsSync(consentPath)).toBe(true);
    expect(consentEvents.map((event) => event.action)).toEqual(['grant', 'revoke']);
    expect(consentEvents[1]).toMatchObject({
      agent: 'alice',
      action: 'revoke',
      supportId: SUPPORT_ACCESS_ID,
    });
  });

  it('refuses removal that would leave BOT_TOKEN without ALLOWED_USER', () => {
    const original = `BOT_TOKEN=123456:ABC_def-123\nALLOWED_USER=${SUPPORT_ACCESS_ID}\n`;
    writeFileSync(envPath, original);

    const result = removeSupportAccess(envPath, testDir);

    expect(result.ok).toBe(false);
    expect(result.changed).toBe(false);
    expect(readFileSync(envPath, 'utf-8')).toBe(original);
  });
});

describe('support-access notify behavior', () => {
  let testDir: string;
  let envPath: string;
  let originalCtxRoot: string | undefined;

  beforeEach(() => {
    originalCtxRoot = process.env.CTX_ROOT;
    testDir = mkdtempSync(join(tmpdir(), 'cortextos-support-notify-'));
    const agentDir = join(testDir, 'orgs', 'acme', 'agents', 'alice');
    mkdirSync(agentDir, { recursive: true });
    envPath = join(agentDir, '.env');
    process.env.CTX_ROOT = testDir;
  });

  afterEach(() => {
    if (originalCtxRoot === undefined) {
      delete process.env.CTX_ROOT;
    } else {
      process.env.CTX_ROOT = originalCtxRoot;
    }
    rmSync(testDir, { recursive: true, force: true });
  });

  function readConsentActions(): string[] {
    const consentPath = join(testDir, 'state', 'alice', 'support-access.jsonl');
    if (!existsSync(consentPath)) return [];
    return readFileSync(consentPath, 'utf-8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line).action);
  }

  it('resolves the bot handle via getMe and formats the share instruction', async () => {
    const handle = await resolveAgentHandle({
      getMe: async () => ({ ok: true, result: { username: 'alice_bot' } }),
    });

    expect(handle).toBe('@alice_bot');
    expect(formatSupportAccessShareInstruction(handle)).toContain('@alice_bot');
    expect(formatSupportAccessShareInstruction(handle)).toContain(SUPPORT_ACCESS_ID);
  });

  it('falls back to a configured handle when getMe is unavailable', async () => {
    const handle = await resolveAgentHandle({
      getMe: async () => { throw new Error('offline'); },
    }, 'fallback_bot');

    expect(handle).toBe('@fallback_bot');
  });

  it('confirms live access once to SUPPORT_ACCESS_ID after a grant', async () => {
    writeFileSync(envPath, 'BOT_TOKEN=123456:ABC_def-123\nALLOWED_USER=111\n');
    addSupportAccess(envPath, testDir);
    const sendMessage = vi.fn(async () => undefined);

    await expect(confirmSupportAccessOnFirstContact({
      agentEnvPath: envPath,
      ctxRoot: testDir,
      api: { sendMessage },
      fromId: Number(SUPPORT_ACCESS_ID),
    })).resolves.toBe(true);

    await expect(confirmSupportAccessOnFirstContact({
      agentEnvPath: envPath,
      ctxRoot: testDir,
      api: { sendMessage },
      fromId: Number(SUPPORT_ACCESS_ID),
    })).resolves.toBe(false);

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith(SUPPORT_ACCESS_ID, SUPPORT_ACCESS_CONFIRMATION, undefined, { parseMode: null });
    expect(readConsentActions()).toEqual(['grant', 'confirmed-live']);
  });

  it('uses explicit daemon ctxRoot for confirmed-live even when process CTX_ROOT is stale', async () => {
    const daemonRoot = join(testDir, 'daemon-root');
    const staleRoot = join(testDir, 'stale-root');
    mkdirSync(daemonRoot, { recursive: true });
    mkdirSync(staleRoot, { recursive: true });
    writeFileSync(envPath, 'BOT_TOKEN=123456:ABC_def-123\nALLOWED_USER=111\n');
    addSupportAccess(envPath, daemonRoot);

    process.env.CTX_ROOT = staleRoot;
    const sendMessage = vi.fn(async () => undefined);

    await expect(confirmSupportAccessOnFirstContact({
      agentEnvPath: envPath,
      ctxRoot: daemonRoot,
      api: { sendMessage },
      fromId: Number(SUPPORT_ACCESS_ID),
    })).resolves.toBe(true);

    const daemonEvents = readFileSync(join(daemonRoot, 'state', 'alice', 'support-access.jsonl'), 'utf-8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line).action);
    expect(daemonEvents).toEqual(['grant', 'confirmed-live']);
    expect(existsSync(join(staleRoot, 'state', 'alice', 'support-access.jsonl'))).toBe(false);
  });

  it('does not confirm for other users or before a grant', async () => {
    writeFileSync(envPath, 'BOT_TOKEN=123456:ABC_def-123\nALLOWED_USER=111\n');
    const sendMessage = vi.fn(async () => undefined);

    await expect(confirmSupportAccessOnFirstContact({
      agentEnvPath: envPath,
      ctxRoot: testDir,
      api: { sendMessage },
      fromId: Number(SUPPORT_ACCESS_ID),
    })).resolves.toBe(false);

    addSupportAccess(envPath, testDir);
    await expect(confirmSupportAccessOnFirstContact({
      agentEnvPath: envPath,
      ctxRoot: testDir,
      api: { sendMessage },
      fromId: 111,
    })).resolves.toBe(false);

    expect(sendMessage).not.toHaveBeenCalled();
    expect(readConsentActions()).toEqual(['grant']);
  });
});
