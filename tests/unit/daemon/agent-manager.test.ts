import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { buildReplyContext } from '../../../src/daemon/agent-manager.js';

const telegramSendMessageMock = vi.hoisted(() => vi.fn().mockResolvedValue({ ok: true }));
const agentStatusCallbacks = vi.hoisted(() => new Map<string, (status: any) => void>());

// Mock the PTY layer so we don't load native bindings or spawn real processes.
// AgentManager → AgentProcess → AgentPTY → node-pty. We mock at AgentProcess.
vi.mock('../../../src/daemon/agent-process.js', () => ({
  AgentProcess: class {
    name: string;
    dir: any;
    config: any;
    telegramApi: { sendMessage: (chatId: string, text: string) => Promise<unknown> } | null = null;
    telegramChatId: string | null = null;
    constructor(name: string, dir: any, config?: any) {
      this.name = name;
      this.dir = dir;
      this.config = config ?? {};
    }
    async start(options?: { partOfFleetStart?: boolean }) {
      // Fresh-start wire-boundary model: without the fleet marker, the
      // agent-level back-online path may send an individual notification.
      // Fleet batches must suppress that path and leave exactly one
      // consolidated send to AgentManager.
      if (!options?.partOfFleetStart && this.telegramApi && this.telegramChatId) {
        await this.telegramApi.sendMessage(this.telegramChatId, `Agent ${this.name} is back online`);
      }
    }
    async stop() { /* no-op */ }
    getStatus() { return { name: this.name, status: 'running' }; }
    setTelegramHandle(api: { sendMessage: (chatId: string, text: string) => Promise<unknown> }, chatId: string) {
      this.telegramApi = api;
      this.telegramChatId = chatId;
    }
    getAgentDir() { return typeof this.dir === 'string' ? this.dir : this.dir?.agentDir; }
    getConfig() { return this.config; }
    injectMessage() { return true; }
    onExit() { /* no-op */ }
    onStatusChanged(cb: (status: any) => void) {
      agentStatusCallbacks.set(this.name, cb);
    }
  },
}));

// Mock FastChecker so it doesn't try to spawn anything either.
vi.mock('../../../src/daemon/fast-checker.js', () => ({
  FastChecker: class {
    async start() { /* no-op */ }
    stop() { /* no-op */ }
    wake() { /* no-op */ }
    resetWatchdogState() { /* no-op */ }
  },
}));

// Mock Telegram so we don't try to make HTTP calls.
vi.mock('../../../src/telegram/api.js', () => ({
  TelegramAPI: class {
    constructor() { /* no-op */ }
    sendMessage = telegramSendMessageMock;
  },
}));

vi.mock('../../../src/telegram/poller.js', () => ({
  TelegramPoller: class {
    // 'stopped-externally' makes startAgent's Conflict-restart wrapper exit
    // after the first (no-op) start() instead of looping with real 30s sleeps.
    lastExitReason = 'stopped-externally';
    start() { /* no-op */ }
    stop() { /* no-op */ }
    onMessage() { /* no-op */ }
    onCallback() { /* no-op */ }
    onReaction() { /* no-op */ }
  },
}));

// Mock WorkerProcess so spawnWorker tests don't spawn real PTY sessions.
// workerSpawnMock captures the CtxEnv passed to spawn() for org assertions.
const workerSpawnMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock('../../../src/daemon/worker-process.js', () => ({
  WorkerProcess: class {
    constructor() { /* no-op */ }
    onDone() { /* no-op */ }
    isFinished() { return true; }
    spawn = workerSpawnMock;
  },
}));

const { AgentManager } = await import('../../../src/daemon/agent-manager.js');

describe('AgentManager.discoverAndStart - BUG-028 fix', () => {
  let testDir: string;
  let ctxRoot: string;
  let frameworkRoot: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'cortextos-am-test-'));
    ctxRoot = join(testDir, 'instance');
    frameworkRoot = join(testDir, 'framework');
    mkdirSync(join(ctxRoot, 'config'), { recursive: true });
    mkdirSync(join(frameworkRoot, 'orgs', 'acme', 'agents', 'alice'), { recursive: true });
    mkdirSync(join(frameworkRoot, 'orgs', 'acme', 'agents', 'bob'), { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('skips agents marked enabled: false in enabled-agents.json', async () => {
    // Mark alice as disabled at the instance level (the file the CLI writes to)
    writeFileSync(
      join(ctxRoot, 'config', 'enabled-agents.json'),
      JSON.stringify({ alice: { enabled: false, org: 'acme' } }),
    );

    const am = new AgentManager('test-instance', ctxRoot, frameworkRoot, 'acme');
    const startSpy = vi.spyOn(am, 'startAgent').mockResolvedValue();

    await am.discoverAndStart();

    // alice should be skipped (disabled in instance file), bob should be started
    expect(startSpy).toHaveBeenCalledTimes(1);
    // BUG-043: startAgent now accepts a 4th `org` argument
    expect(startSpy).toHaveBeenCalledWith('bob', expect.any(String), expect.any(Object), 'acme', { partOfFleetStart: true });
  });

  it('starts all discovered agents when enabled-agents.json is missing', async () => {
    // No enabled-agents.json on disk — daemon defaults to enabled-on-discovery
    const am = new AgentManager('test-instance', ctxRoot, frameworkRoot, 'acme');
    const startSpy = vi.spyOn(am, 'startAgent').mockResolvedValue();

    await am.discoverAndStart();

    expect(startSpy).toHaveBeenCalledTimes(2);
    const namesStarted = startSpy.mock.calls.map(call => call[0]).sort();
    expect(namesStarted).toEqual(['alice', 'bob']);
  });

  it('starts all discovered agents when enabled-agents.json is empty {}', async () => {
    writeFileSync(join(ctxRoot, 'config', 'enabled-agents.json'), '{}');
    const am = new AgentManager('test-instance', ctxRoot, frameworkRoot, 'acme');
    const startSpy = vi.spyOn(am, 'startAgent').mockResolvedValue();

    await am.discoverAndStart();

    // Empty object means no overrides — all discovered agents start
    expect(startSpy).toHaveBeenCalledTimes(2);
  });

  it('still respects per-agent config.json enabled: false (existing behavior)', async () => {
    // Per-agent config.json takes precedence — this is the legacy behavior we
    // explicitly preserved in the BUG-028 fix
    writeFileSync(
      join(frameworkRoot, 'orgs', 'acme', 'agents', 'alice', 'config.json'),
      JSON.stringify({ enabled: false }),
    );

    const am = new AgentManager('test-instance', ctxRoot, frameworkRoot, 'acme');
    const startSpy = vi.spyOn(am, 'startAgent').mockResolvedValue();

    await am.discoverAndStart();

    expect(startSpy).toHaveBeenCalledTimes(1);
    // BUG-043: startAgent now accepts a 4th `org` argument
    expect(startSpy).toHaveBeenCalledWith('bob', expect.any(String), expect.any(Object), 'acme', { partOfFleetStart: true });
  });

  it('handles corrupt enabled-agents.json by defaulting to enabled-all', async () => {
    writeFileSync(
      join(ctxRoot, 'config', 'enabled-agents.json'),
      'this is not valid json',
    );

    const am = new AgentManager('test-instance', ctxRoot, frameworkRoot, 'acme');
    const startSpy = vi.spyOn(am, 'startAgent').mockResolvedValue();

    await am.discoverAndStart();

    // Corrupt file is treated as missing — all discovered agents start
    expect(startSpy).toHaveBeenCalledTimes(2);
  });
});

describe('AgentManager.discoverAndStart - BUG-043 fix (multi-org support)', () => {
  let testDir: string;
  let ctxRoot: string;
  let frameworkRoot: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'cortextos-am-multiorg-'));
    ctxRoot = join(testDir, 'instance');
    frameworkRoot = join(testDir, 'framework');
    mkdirSync(join(ctxRoot, 'config'), { recursive: true });
    // Two orgs with agents in each — simulates a multi-org install
    // (e.g. James's lifeos + cointally + testorg setup)
    mkdirSync(join(frameworkRoot, 'orgs', 'acme', 'agents', 'alice'), { recursive: true });
    mkdirSync(join(frameworkRoot, 'orgs', 'acme', 'agents', 'bob'), { recursive: true });
    mkdirSync(join(frameworkRoot, 'orgs', 'widgetco', 'agents', 'carol'), { recursive: true });
    mkdirSync(join(frameworkRoot, 'orgs', 'widgetco', 'agents', 'dave'), { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('discovers agents from ALL orgs, not just the daemon startup org', async () => {
    // BUG-043: before the fix, an AgentManager constructed with org='acme'
    // would only discover agents in orgs/acme/. Agents in orgs/widgetco/
    // were silently invisible. This test pins the multi-org scan in place.
    const am = new AgentManager('test-instance', ctxRoot, frameworkRoot, 'acme');
    const startSpy = vi.spyOn(am, 'startAgent').mockResolvedValue();

    await am.discoverAndStart();

    expect(startSpy).toHaveBeenCalledTimes(4);
    const namesStarted = startSpy.mock.calls.map(call => call[0]).sort();
    expect(namesStarted).toEqual(['alice', 'bob', 'carol', 'dave']);
  });

  it('passes the correct per-agent org as the 4th argument to startAgent', async () => {
    // BUG-043: startAgent must know which org the agent lives under
    // so it can build the right filesystem path. discoverAgents now
    // attaches org per discovered entry, and discoverAndStart threads
    // it through.
    const am = new AgentManager('test-instance', ctxRoot, frameworkRoot, 'acme');
    const startSpy = vi.spyOn(am, 'startAgent').mockResolvedValue();

    await am.discoverAndStart();

    const callsByName = new Map<string, readonly unknown[]>();
    for (const call of startSpy.mock.calls) {
      callsByName.set(call[0] as string, call);
    }
    expect(callsByName.get('alice')?.[3]).toBe('acme');
    expect(callsByName.get('bob')?.[3]).toBe('acme');
    expect(callsByName.get('carol')?.[3]).toBe('widgetco');
    expect(callsByName.get('dave')?.[3]).toBe('widgetco');
  });

  it('respects enabled-agents.json disable-flags across multiple orgs', async () => {
    // alice in acme and dave in widgetco are both disabled. The fix must
    // still honor per-agent enable/disable regardless of which org the
    // agent is in.
    writeFileSync(
      join(ctxRoot, 'config', 'enabled-agents.json'),
      JSON.stringify({
        alice: { enabled: false, org: 'acme' },
        dave: { enabled: false, org: 'widgetco' },
      }),
    );
    const am = new AgentManager('test-instance', ctxRoot, frameworkRoot, 'acme');
    const startSpy = vi.spyOn(am, 'startAgent').mockResolvedValue();

    await am.discoverAndStart();

    expect(startSpy).toHaveBeenCalledTimes(2);
    const namesStarted = startSpy.mock.calls.map(call => call[0]).sort();
    expect(namesStarted).toEqual(['bob', 'carol']);
  });

  it('returns empty list when orgs/ does not exist (backward compat)', async () => {
    const emptyDir = mkdtempSync(join(tmpdir(), 'cortextos-am-empty-'));
    try {
      // No orgs/ dir at all — daemon should not error, just discover nothing
      const am = new AgentManager('test-instance', ctxRoot, emptyDir, 'acme');
      const startSpy = vi.spyOn(am, 'startAgent').mockResolvedValue();

      await am.discoverAndStart();

      expect(startSpy).not.toHaveBeenCalled();
    } finally {
      rmSync(emptyDir, { recursive: true, force: true });
    }
  });
});

describe('AgentManager dead mapped-agent replacement (#858)', () => {
  it('tears down a halted entry and installs exactly one fresh running registry entry', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cortextos-am-dead-replace-'));
    const ctxRoot = join(root, 'instance');
    const frameworkRoot = join(root, 'framework');
    const agentDir = join(frameworkRoot, 'orgs', 'acme', 'agents', 'alice');
    mkdirSync(join(ctxRoot, 'config'), { recursive: true });
    mkdirSync(agentDir, { recursive: true });

    try {
      const am = new AgentManager('test-instance', ctxRoot, frameworkRoot, 'acme');
      const staleStop = vi.fn().mockResolvedValue(undefined);
      const staleCheckerStop = vi.fn();
      const stale = {
        process: {
          getStatus: () => ({ name: 'alice', status: 'halted' }),
          stop: staleStop,
        },
        checker: { stop: staleCheckerStop },
      };
      const agents = (am as unknown as { agents: Map<string, unknown> }).agents;
      agents.set('alice', stale);

      await am.startAgent('alice', agentDir, { telegram_polling: false }, 'acme');

      expect(staleStop).toHaveBeenCalledTimes(1);
      expect(staleCheckerStop).toHaveBeenCalledTimes(1);
      expect(agents.size).toBe(1);
      const replacement = agents.get('alice') as { process: { getStatus(): { status: string } } };
      expect(replacement).not.toBe(stale);
      expect(replacement.process.getStatus().status).toBe('running');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('AgentManager.restartAgent - BUG-007 fix (rebuild Telegram poller)', () => {
  let testDir: string;
  let ctxRoot: string;
  let frameworkRoot: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'cortextos-am-restart-test-'));
    ctxRoot = join(testDir, 'instance');
    frameworkRoot = join(testDir, 'framework');
    mkdirSync(join(ctxRoot, 'config'), { recursive: true });
    mkdirSync(join(frameworkRoot, 'orgs', 'acme', 'agents', 'alice'), { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('delegates to stopAgent then startAgent (in order)', async () => {
    // BUG-007: previously restartAgent only stopped/started the AgentProcess and
    // FastChecker inline, leaving the TelegramPoller from the previous incarnation
    // running. The fix delegates to stopAgent (which DOES clean up the poller) and
    // startAgent (which builds a fresh poller from the agent's .env). This test
    // pins that delegation in place so a future regression to inline cleanup
    // would fail loudly.
    const am = new AgentManager('test-instance', ctxRoot, frameworkRoot, 'acme');
    // Inject a fake agent so restartAgent's existence check passes without
    // actually running the full startAgent flow
    (am as any).agents.set('alice', { process: {}, checker: {}, poller: { stop() {} } });

    const stopSpy = vi.spyOn(am, 'stopAgent').mockResolvedValue();
    const startSpy = vi.spyOn(am, 'startAgent').mockResolvedValue();

    await am.restartAgent('alice');

    expect(stopSpy).toHaveBeenCalledWith('alice');
    expect(startSpy).toHaveBeenCalledWith('alice', '', undefined, undefined, { partOfFleetStart: undefined });
    // Verify call order: stop must complete before start, so the old poller
    // is fully torn down before the new one is constructed
    const stopOrder = stopSpy.mock.invocationCallOrder[0];
    const startOrder = startSpy.mock.invocationCallOrder[0];
    expect(stopOrder).toBeLessThan(startOrder);
  });

  it('is a no-op when the agent does not exist', async () => {
    const am = new AgentManager('test-instance', ctxRoot, frameworkRoot, 'acme');
    const stopSpy = vi.spyOn(am, 'stopAgent').mockResolvedValue();
    const startSpy = vi.spyOn(am, 'startAgent').mockResolvedValue();

    await am.restartAgent('nonexistent');

    expect(stopSpy).not.toHaveBeenCalled();
    expect(startSpy).not.toHaveBeenCalled();
  });
});

describe('AgentManager fleet back-online notification coalescing', () => {
  let testDir: string;
  let ctxRoot: string;
  let frameworkRoot: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'cortextos-am-fleet-online-'));
    ctxRoot = join(testDir, 'instance');
    frameworkRoot = join(testDir, 'framework');
    mkdirSync(join(ctxRoot, 'config'), { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  function registerRunningAgent(am: InstanceType<typeof AgentManager>, name: string): void {
    (am as any).agents.set(name, {
      process: { getStatus: () => ({ name, status: 'running' }) },
      checker: {},
    });
  }

  function writeTelegramAgent(name: string): void {
    const agentDir = join(frameworkRoot, 'orgs', 'acme', 'agents', name);
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(
      join(agentDir, '.env'),
      'BOT_TOKEN=123:abc\nCHAT_ID=chat-1\nALLOWED_USER=42\n',
    );
    writeFileSync(
      join(agentDir, 'config.json'),
      JSON.stringify({ telegram_polling: false }),
    );
  }

  it('suppresses fresh agent-level back-online sends during daemon boot and emits exactly one consolidated notification', async () => {
    const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    writeTelegramAgent('alice');
    writeTelegramAgent('bob');
    const am = new AgentManager('test-instance', ctxRoot, frameworkRoot, 'acme');

    try {
      telegramSendMessageMock.mockClear();
      await am.discoverAndStart();
      await Promise.resolve();

      expect(telegramSendMessageMock).toHaveBeenCalledTimes(1);
      expect(telegramSendMessageMock).toHaveBeenCalledWith('chat-1', 'Fleet back online (2/2 agents)');
      expect(telegramSendMessageMock).not.toHaveBeenCalledWith('chat-1', 'Agent alice is back online');
      expect(telegramSendMessageMock).not.toHaveBeenCalledWith('chat-1', 'Agent bob is back online');
      expect(consoleLogSpy).toHaveBeenCalledWith('[agent-manager] Telegram fleet back-online notification sent: Fleet back online (2/2 agents)');
    } finally {
      consoleLogSpy.mockRestore();
    }
  });

  it('sends exactly one consolidated notification after a near-simultaneous restart-all batch completes', async () => {
    const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const am = new AgentManager('test-instance', ctxRoot, frameworkRoot, 'acme');
    const sendMessage = vi.fn().mockResolvedValue({ ok: true });
    const api = { sendMessage };

    try {
      for (const name of ['alice', 'bob', 'carol']) registerRunningAgent(am, name);
      vi.spyOn(am, 'stopAgent').mockResolvedValue();
      vi.spyOn(am, 'startAgent').mockImplementation(async () => {
        (am as any).captureFleetNotifyHandle(api, 'chat-1');
      });

      await Promise.all([
        am.restartAgent('alice', { partOfFleetStart: true, fleetTotal: 3, fleetIndex: 0 }),
        am.restartAgent('bob', { partOfFleetStart: true, fleetTotal: 3, fleetIndex: 1 }),
        am.restartAgent('carol', { partOfFleetStart: true, fleetTotal: 3, fleetIndex: 2 }),
      ]);
      await Promise.resolve();

      expect(sendMessage).toHaveBeenCalledTimes(1);
      expect(sendMessage).toHaveBeenCalledWith('chat-1', 'Fleet back online (3/3 agents)');
      expect(consoleLogSpy).toHaveBeenCalledWith('[agent-manager] Telegram fleet back-online notification sent: Fleet back online (3/3 agents)');
    } finally {
      consoleLogSpy.mockRestore();
    }
  });

  it('does not coalesce a lone single-agent restart through the fleet batch coordinator', async () => {
    const am = new AgentManager('test-instance', ctxRoot, frameworkRoot, 'acme');
    registerRunningAgent(am, 'alice');
    vi.spyOn(am, 'stopAgent').mockResolvedValue();
    const startSpy = vi.spyOn(am, 'startAgent').mockResolvedValue();

    await am.restartAgent('alice');

    expect((am as any).fleetStartBatch).toBeNull();
    expect(startSpy).toHaveBeenCalledWith('alice', '', undefined, undefined, { partOfFleetStart: undefined });
  });

  it('keeps crash recovery on individual Telegram notifications outside the fleet batch coordinator', async () => {
    const am = new AgentManager('test-instance', ctxRoot, frameworkRoot, 'acme');
    const agentDir = join(frameworkRoot, 'orgs', 'acme', 'agents', 'alice');
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(
      join(agentDir, '.env'),
      'BOT_TOKEN=123:abc\nCHAT_ID=chat-1\nALLOWED_USER=42\n',
    );

    telegramSendMessageMock.mockClear();
    agentStatusCallbacks.clear();
    await am.startAgent('alice', agentDir, { telegram_polling: false }, 'acme');
    telegramSendMessageMock.mockClear();

    const statusChanged = agentStatusCallbacks.get('alice');
    expect(statusChanged).toBeDefined();
    statusChanged!({ status: 'crashed', crashCount: 1 });
    statusChanged!({ status: 'running' });
    await Promise.resolve();

    expect((am as any).fleetStartBatch).toBeNull();
    expect(telegramSendMessageMock).toHaveBeenCalledTimes(2);
    expect(telegramSendMessageMock).toHaveBeenNthCalledWith(1, 'chat-1', 'Agent alice crashed (crash #1) — auto-restarting');
    expect(telegramSendMessageMock).toHaveBeenNthCalledWith(2, 'chat-1', 'Agent alice recovered and is back online');
  });
});

describe('buildReplyContext - Telegram reply context (BUG fix: media replies lost)', () => {
  it('returns undefined when no reply message', () => {
    expect(buildReplyContext(undefined)).toBeUndefined();
  });

  it('returns text content for plain text replies', () => {
    const msg = { message_id: 1, chat: { id: 1 }, text: 'Hello world' };
    expect(buildReplyContext(msg)).toBe('Hello world');
  });

  it('returns caption for media messages with captions', () => {
    const msg = { message_id: 2, chat: { id: 1 }, photo: [{ file_id: 'x', width: 100, height: 100, file_size: 1 }], caption: 'Check this out' };
    expect(buildReplyContext(msg)).toBe('Check this out\n[photo]');
  });

  it('returns caption plus document name for document replies with captions', () => {
    const msg = {
      message_id: 12,
      chat: { id: 1 },
      caption: 'Code review done — full HTML breakdown attached.',
      document: { file_id: 'd3', file_name: 'hermes-memory-review.html' },
    };
    expect(buildReplyContext(msg)).toBe('Code review done — full HTML breakdown attached.\n[document: hermes-memory-review.html]');
  });

  it('returns [video] for video messages without caption', () => {
    const msg = { message_id: 3, chat: { id: 1 }, video: { file_id: 'v1', width: 1920, height: 1080, duration: 30 } };
    expect(buildReplyContext(msg)).toBe('[video]');
  });

  it('returns [photo] for photo messages without caption', () => {
    const msg = { message_id: 4, chat: { id: 1 }, photo: [{ file_id: 'p1', width: 100, height: 100, file_size: 1 }] };
    expect(buildReplyContext(msg)).toBe('[photo]');
  });

  it('returns [voice message] for voice messages', () => {
    const msg = { message_id: 5, chat: { id: 1 }, voice: { file_id: 'vc1', duration: 5 } };
    expect(buildReplyContext(msg)).toBe('[voice message]');
  });

  it('returns [video note] for video note messages', () => {
    const msg = { message_id: 6, chat: { id: 1 }, video_note: { file_id: 'vn1', length: 240, duration: 10 } };
    expect(buildReplyContext(msg)).toBe('[video note]');
  });

  it('returns [audio] for audio messages', () => {
    const msg = { message_id: 7, chat: { id: 1 }, audio: { file_id: 'a1', duration: 120 } };
    expect(buildReplyContext(msg)).toBe('[audio]');
  });

  it('returns document name for document messages', () => {
    const msg = { message_id: 8, chat: { id: 1 }, document: { file_id: 'd1', file_name: 'report.pdf' } };
    expect(buildReplyContext(msg)).toBe('[document: report.pdf]');
  });

  it('returns [document: file] when document has no file_name', () => {
    const msg = { message_id: 9, chat: { id: 1 }, document: { file_id: 'd2' } };
    expect(buildReplyContext(msg)).toBe('[document: file]');
  });

  it('prefers text over caption when both present', () => {
    const msg = { message_id: 10, chat: { id: 1 }, text: 'Text content', caption: 'Caption content' };
    expect(buildReplyContext(msg)).toBe('Text content');
  });

  it('strips control characters from text', () => {
    const msg = { message_id: 11, chat: { id: 1 }, text: 'Hello\x00world' };
    const result = buildReplyContext(msg);
    expect(result).not.toContain('\x00');
  });
});

describe('AgentManager.reloadCrons - silent-success bug fix (iter 7)', () => {
  // Regression: reloadCrons() previously returned `true` when the agent was
  // registered in `this.agents` but no scheduler existed in `this.cronSchedulers`.
  // This silently dropped reload requests during the start-window gap between
  // `this.agents.set(name, ...)` (agent-manager.ts line 271) and
  // `startAgentCronScheduler(name)` (line 288), across the
  // `await agentProcess.start()` yield. A `bus add-cron` IPC landing in that
  // window would write crons.json, ask the daemon to reload, get a TRUE back,
  // and the cron would never fire — until the next daemon boot.
  //
  // Fix: lazy-create the scheduler when missing for non-Hermes agents so the
  // newly-written crons.json is read immediately. Hermes agents intentionally
  // have no daemon scheduler (they manage crons natively), so for them the
  // reload remains a no-op that returns true.

  let testDir: string;
  let ctxRoot: string;
  let frameworkRoot: string;
  let prevCtxRoot: string | undefined;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'cortextos-am-reloadcrons-'));
    ctxRoot = join(testDir, 'instance');
    frameworkRoot = join(testDir, 'framework');
    mkdirSync(join(ctxRoot, 'config'), { recursive: true });
    mkdirSync(join(frameworkRoot, 'orgs', 'acme', 'agents', 'alice'), { recursive: true });
    // CronScheduler.start() reads crons.json via cronsFilePath which honors
    // CTX_ROOT — point it at the sandbox so the scheduler doesn't touch
    // production state.
    prevCtxRoot = process.env.CTX_ROOT;
    process.env.CTX_ROOT = ctxRoot;
  });

  afterEach(() => {
    if (prevCtxRoot === undefined) {
      delete process.env.CTX_ROOT;
    } else {
      process.env.CTX_ROOT = prevCtxRoot;
    }
    rmSync(testDir, { recursive: true, force: true });
  });

  it('lazy-creates scheduler when non-Hermes agent has no scheduler wired', () => {
    // Simulate the start-window gap: agent registered, no scheduler yet.
    const am = new AgentManager('test-instance', ctxRoot, frameworkRoot, 'acme');
    const fakeProcess = { config: { runtime: undefined } } as any;
    (am as any).agents.set('alice', { process: fakeProcess, checker: {} });

    expect((am as any).cronSchedulers.has('alice')).toBe(false);

    const result = am.reloadCrons('alice');

    // After fix: scheduler is wired up so the just-added cron is picked up.
    expect(result).toBe(true);
    expect((am as any).cronSchedulers.has('alice')).toBe(true);

    // Cleanup: stop the scheduler so its setInterval doesn't keep the test
    // process alive
    (am as any).cronSchedulers.get('alice').stop();
  });

  it('returns true without creating a scheduler for Hermes agents (no-op preserved)', () => {
    const am = new AgentManager('test-instance', ctxRoot, frameworkRoot, 'acme');
    const fakeProcess = { config: { runtime: 'hermes' } } as any;
    (am as any).agents.set('alice', { process: fakeProcess, checker: {} });

    const result = am.reloadCrons('alice');

    expect(result).toBe(true);
    expect((am as any).cronSchedulers.has('alice')).toBe(false);
  });

  it('reuses existing scheduler when one is already wired', () => {
    const am = new AgentManager('test-instance', ctxRoot, frameworkRoot, 'acme');
    const fakeProcess = { config: { runtime: undefined } } as any;
    (am as any).agents.set('alice', { process: fakeProcess, checker: {} });

    // Pre-wire a scheduler with a spy on reload()
    const reloadSpy = vi.fn();
    const stopSpy = vi.fn();
    (am as any).cronSchedulers.set('alice', { reload: reloadSpy, stop: stopSpy });

    const result = am.reloadCrons('alice');

    expect(result).toBe(true);
    expect(reloadSpy).toHaveBeenCalledTimes(1);
    // Did not replace the existing scheduler
    expect((am as any).cronSchedulers.get('alice').reload).toBe(reloadSpy);
  });

  it('returns false when the agent is not running at all', () => {
    const am = new AgentManager('test-instance', ctxRoot, frameworkRoot, 'acme');
    const result = am.reloadCrons('ghost');
    expect(result).toBe(false);
    expect((am as any).cronSchedulers.has('ghost')).toBe(false);
  });
});

describe('AgentManager.evaluateCronShiftSuppression - wake_on_fire bypass', () => {
  // Regression target: pm-colocated-detect was registered to fire at 11:15 UTC
  // (07:15 ET) but the daemon silently suppressed the fire because the agent's
  // shift_schedule placed that hour off-shift. Per-cron wake_on_fire bypasses
  // the gate for crons whose downstream consumers need a same-time output file
  // every day regardless of shift state.

  // shift_schedule that makes 04:00 UTC off-shift under tz=UTC: weekdays 09:00-17:00.
  // Outside the window → off_shift_no_wake (empty allowlist).
  const offShiftSchedule = {
    weekly: {
      mon: { start: '09:00', end: '17:00' },
      tue: { start: '09:00', end: '17:00' },
      wed: { start: '09:00', end: '17:00' },
      thu: { start: '09:00', end: '17:00' },
      fri: { start: '09:00', end: '17:00' },
      sat: 'off' as const,
      sun: 'off' as const,
    },
  };

  const baseCron = {
    name: 'test-cron',
    prompt: 'do thing',
    schedule: '15 11 * * *',
    enabled: true,
    created_at: '2026-05-12T00:00:00.000Z',
  };

  function makeManager(shift_schedule: any): any {
    // Use a UTC timezone so 11:00 UTC test time maps directly to 11:00 wall-clock
    // — independent of the daemon host's local timezone.
    const am = new AgentManager('test-instance', '/tmp/x', '/tmp/x', 'acme');
    const fakeProcess = { config: { shift_schedule, timezone: 'UTC' } } as any;
    (am as any).agents.set('alice', { process: fakeProcess, checker: {} });
    return am;
  }

  beforeEach(() => {
    // Pin "now" to a weekday at 04:00 UTC — off-shift under the 09:00-17:00 UTC
    // schedule, regardless of where this test runs.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-12T04:00:00Z')); // Tuesday 04:00 UTC
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns suppression when off-shift and cron has no wake_on_fire flag', () => {
    const am = makeManager(offShiftSchedule);
    const result = (am as any).evaluateCronShiftSuppression('alice', baseCron);
    expect(result).toEqual({ mode: 'no_wake' });
  });

  it('returns null (fire proceeds) when off-shift and cron sets wake_on_fire: true', () => {
    const am = makeManager(offShiftSchedule);
    const cron = { ...baseCron, wake_on_fire: true };
    const result = (am as any).evaluateCronShiftSuppression('alice', cron);
    expect(result).toBeNull();
  });

  it('returns null when wake_on_fire is false but agent is on-shift', () => {
    // 10:00 UTC Tuesday is inside the 09:00-17:00 window.
    vi.setSystemTime(new Date('2026-05-12T10:00:00Z'));
    const am = makeManager(offShiftSchedule);
    const result = (am as any).evaluateCronShiftSuppression('alice', baseCron);
    expect(result).toBeNull();
  });

  it('returns null when agent has no shift_schedule configured', () => {
    const am = makeManager(undefined);
    const result = (am as any).evaluateCronShiftSuppression('alice', baseCron);
    expect(result).toBeNull();
  });
});

describe('AgentManager.startAgent - F3 fix (activity-channel poller gets resolved org on restart path)', () => {
  // F3 regression target: restartAgent() and the queued pendingRestarts path
  // call startAgent(name, '') — no org argument. startAgent computes
  // resolvedOrg via resolveAgentOrg(), but the activity-channel poller call
  // passed the RAW `org` parameter (undefined on restart), so
  // maybeStartActivityChannelPoller early-returned and the orchestrator's
  // Telegram Approve/Deny buttons silently died after every restart until a
  // full daemon reboot. This test drives startAgent restart-style and pins
  // that the poller receives the RESOLVED org.

  let testDir: string;
  let ctxRoot: string;
  let frameworkRoot: string;
  let prevCtxRoot: string | undefined;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'cortextos-am-f3-activity-'));
    ctxRoot = join(testDir, 'instance');
    frameworkRoot = join(testDir, 'framework');
    mkdirSync(join(ctxRoot, 'config'), { recursive: true });
    const agentDir = join(frameworkRoot, 'orgs', 'acme', 'agents', 'alice');
    mkdirSync(agentDir, { recursive: true });
    // Telegram credentials + polling enabled so startAgent reaches the
    // activity-channel poller call site (gated on telegram_polling !== false).
    writeFileSync(
      join(agentDir, '.env'),
      'BOT_TOKEN=123:abc\nCHAT_ID=chat-1\nALLOWED_USER=42\n',
    );
    writeFileSync(join(agentDir, 'config.json'), JSON.stringify({ telegram_polling: true }));
    // Sandbox CronScheduler's crons.json lookup (honors CTX_ROOT).
    prevCtxRoot = process.env.CTX_ROOT;
    process.env.CTX_ROOT = ctxRoot;
  });

  afterEach(() => {
    if (prevCtxRoot === undefined) {
      delete process.env.CTX_ROOT;
    } else {
      process.env.CTX_ROOT = prevCtxRoot;
    }
    rmSync(testDir, { recursive: true, force: true });
  });

  it('passes the resolved org (not the raw empty restart-path org) to maybeStartActivityChannelPoller', async () => {
    // Daemon startup org deliberately differs from the agent's real org so
    // the assertion can distinguish "resolved via resolveAgentOrg()" from
    // "fell back to this.org".
    const am = new AgentManager('test-instance', ctxRoot, frameworkRoot, 'daemonorg');
    const activitySpy = vi
      .spyOn(am as any, 'maybeStartActivityChannelPoller')
      .mockResolvedValue(undefined);

    try {
      // Restart-style invocation: exactly what restartAgent (:startAgent(name, ''))
      // and the queued pendingRestarts path use — no agentDir, no org.
      await am.startAgent('alice', '');

      expect(activitySpy).toHaveBeenCalledTimes(1);
      const [calledName, calledOrg] = activitySpy.mock.calls[0];
      expect(calledName).toBe('alice');
      // Before the F3 fix this was `undefined` (the raw org parameter) and
      // the poller early-returned. It must be the resolved org.
      expect(calledOrg).toBe('acme');
    } finally {
      await am.stopAgent('alice');
    }
  });

  it('still passes the explicit org through on the boot path (no regression)', async () => {
    const am = new AgentManager('test-instance', ctxRoot, frameworkRoot, 'daemonorg');
    const activitySpy = vi
      .spyOn(am as any, 'maybeStartActivityChannelPoller')
      .mockResolvedValue(undefined);

    try {
      // Boot path: discoverAndStart passes agentDir + org explicitly.
      const agentDir = join(frameworkRoot, 'orgs', 'acme', 'agents', 'alice');
      await am.startAgent('alice', agentDir, undefined, 'acme');

      expect(activitySpy).toHaveBeenCalledTimes(1);
      expect(activitySpy.mock.calls[0][1]).toBe('acme');
    } finally {
      await am.stopAgent('alice');
    }
  });
});

describe('AgentManager.spawnWorker - F4 fix (CtxEnv.org resolved, not daemon startup org)', () => {
  // F4 regression target (BUG-043 class): spawnWorker built CtxEnv with
  // org: this.org — the daemon's startup org. On a multi-org install, a
  // worker spawned on behalf of an agent in another org inherited the wrong
  // CTX_ORG. The fix routes through resolveAgentOrg(parent ?? name).

  let testDir: string;
  let ctxRoot: string;
  let frameworkRoot: string;

  beforeEach(() => {
    workerSpawnMock.mockClear();
    testDir = mkdtempSync(join(tmpdir(), 'cortextos-am-f4-worker-'));
    ctxRoot = join(testDir, 'instance');
    frameworkRoot = join(testDir, 'framework');
    mkdirSync(join(ctxRoot, 'config'), { recursive: true });
    // Daemon starts with org 'acme'; the spawning parent agent lives in widgetco.
    mkdirSync(join(frameworkRoot, 'orgs', 'acme', 'agents', 'alice'), { recursive: true });
    mkdirSync(join(frameworkRoot, 'orgs', 'widgetco', 'agents', 'parenty'), { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it("resolves the worker's org from its parent agent on a multi-org install", async () => {
    const am = new AgentManager('test-instance', ctxRoot, frameworkRoot, 'acme');

    await am.spawnWorker('w1', join(testDir, 'workdir'), 'do stuff', 'parenty');

    expect(workerSpawnMock).toHaveBeenCalledTimes(1);
    const env = workerSpawnMock.mock.calls[0][0];
    // Before the F4 fix this was 'acme' (this.org) regardless of parent.
    expect(env.org).toBe('widgetco');
  });

  it('falls back to the daemon startup org for parentless workers (old behavior preserved)', async () => {
    const am = new AgentManager('test-instance', ctxRoot, frameworkRoot, 'acme');

    await am.spawnWorker('w2', join(testDir, 'workdir'), 'do stuff');

    expect(workerSpawnMock).toHaveBeenCalledTimes(1);
    const env = workerSpawnMock.mock.calls[0][0];
    // Worker name 'w2' exists in no org dir → resolution chain falls back to
    // this.org, identical to pre-fix behavior on single-org installs.
    expect(env.org).toBe('acme');
  });
});
