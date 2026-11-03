import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentConfig, BusPaths, CtxEnv } from '../../../src/types/index.js';
import type { SlackSocketListenerOptions } from '../../../src/daemon/slack-socket-listener.js';

const observed = vi.hoisted(() => ({
  ctxRoot: '',
  checkers: [] as Array<{ slackWatch?: unknown }>,
  listeners: [] as Array<SlackSocketListenerOptions>,
  socketStart: vi.fn().mockResolvedValue(undefined),
}));

// Keep the production manager, routing loader, environment parser, and startup
// resolver. Mock only the running processes, transports, and scheduler so the
// test exercises startup wiring without creating a PTY or reaching a network.
vi.mock('../../../src/daemon/agent-process.js', () => ({
  AgentProcess: class {
    private status = 'starting';
    constructor(private name: string, private env: CtxEnv, private config: AgentConfig) {}
    async start() { this.status = 'running'; }
    async stop() { this.status = 'stopped'; }
    getStatus() { return { name: this.name, status: this.status, pid: 1 }; }
    getConfig() { return this.config; }
    getAgentDir() { return this.env.agentDir; }
    onStatusChanged() {}
    setTelegramHandle() {}
  },
}));
vi.mock('../../../src/daemon/worker-process.js', () => ({ WorkerProcess: class {} }));
vi.mock('../../../src/daemon/fast-checker.js', () => ({
  FastChecker: class {
    constructor(_process: unknown, _paths: unknown, _root: unknown, options: { slackWatch?: unknown }) {
      observed.checkers.push(options);
    }
    async start() {}
    stop() {}
    wake() {}
    resetWatchdogState() {}
  },
}));
vi.mock('../../../src/daemon/slack-socket-listener.js', () => ({
  SlackSocketListener: class {
    constructor(options: SlackSocketListenerOptions) { observed.listeners.push(options); }
    start() { return observed.socketStart(); }
    stop() {}
  },
}));
vi.mock('../../../src/daemon/cron-scheduler.js', () => ({
  CronScheduler: class {
    start() {}
    stop() {}
    reload() {}
    getNextFireTimes() { return []; }
  },
}));
vi.mock('../../../src/daemon/cron-noop-detector.js', () => ({
  CronNoopDetector: class { cancelAgentVerifications() {} },
}));
vi.mock('../../../src/daemon/cron-migration.js', () => ({ syncCronsForAgent() {} }));
vi.mock('../../../src/buzz/index.js', () => ({
  BuzzRelayClient: class {}, BuzzDispatcher: class {},
  loadBuzzConfig: () => null, formatBuzzInboxMessage: () => '',
}));
vi.mock('../../../src/utils/paths.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/utils/paths.js')>();
  return {
    ...actual,
    resolvePaths: (name: string): BusPaths => ({
      ctxRoot: observed.ctxRoot,
      inbox: `${observed.ctxRoot}/inbox/${name}`,
      inflight: `${observed.ctxRoot}/inflight/${name}`,
      processed: `${observed.ctxRoot}/processed/${name}`,
      logDir: `${observed.ctxRoot}/logs/${name}`,
      stateDir: `${observed.ctxRoot}/state/${name}`,
      taskDir: `${observed.ctxRoot}/tasks`,
      approvalDir: `${observed.ctxRoot}/approvals`,
      analyticsDir: `${observed.ctxRoot}/analytics`,
      deliverablesDir: `${observed.ctxRoot}/deliverables`,
    }),
  };
});

const { AgentManager } = await import('../../../src/daemon/agent-manager.js');

describe('AgentManager Slack startup wiring', () => {
  let root: string;
  let frameworkRoot: string;
  let manager: InstanceType<typeof AgentManager>;
  let startedNames: string[];

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'fleet-slack-manager-'));
    frameworkRoot = join(root, 'framework');
    observed.ctxRoot = join(root, 'instance');
    mkdirSync(join(observed.ctxRoot, 'config'), { recursive: true });
    observed.checkers.length = 0;
    observed.listeners.length = 0;
    observed.socketStart.mockClear();
    startedNames = [];
    vi.stubGlobal('WebSocket', class {});
    vi.stubEnv('SLACK_BOT_TOKEN', '');
    vi.stubEnv('SLACK_APP_TOKEN', '');
    vi.stubEnv('SLACK_CHANNEL', '');
    vi.spyOn(console, 'log').mockImplementation(() => {});
    manager = new AgentManager('slack-startup-test', observed.ctxRoot, frameworkRoot, 'example');
  });

  afterEach(async () => {
    for (const name of startedNames) await manager.stopAgent(name, true);
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    rmSync(root, { recursive: true, force: true });
  });

  function createAgent(name: string, config: AgentConfig, route?: string): string {
    const directory = join(frameworkRoot, 'orgs', 'example', 'agents', name);
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, 'config.json'), JSON.stringify(config));
    if (route !== undefined) writeFileSync(join(directory, 'slack.json'), route);
    return directory;
  }

  function route(conversation = 'D_PILOT'): string {
    return JSON.stringify({ allowed_channels: [conversation], allowed_users: ['T_EXAMPLE:U_MEMBER'] });
  }

  async function start(name: string, directory: string, config: AgentConfig): Promise<void> {
    startedNames.push(name);
    await manager.startAgent(name, directory, config, 'example');
  }

  it('starts exactly one route-only DM socket with unquoted per-agent credentials and no poll', async () => {
    const config = { trusted_slack_users: ['pilot-member'], telegram_polling: false };
    const directory = createAgent('pilot', config, route());
    writeFileSync(join(directory, '.env'), 'SLACK_BOT_TOKEN="quoted-bot"\nSLACK_APP_TOKEN=\'quoted-app\'\n');

    await start('pilot', directory, config);

    expect(observed.listeners).toHaveLength(1);
    expect(observed.listeners[0]).toMatchObject({
      agentName: 'pilot', channel: 'D_PILOT', botToken: 'quoted-bot', appToken: 'quoted-app',
      routing: { allowed_channels: ['D_PILOT'], allowed_users: ['T_EXAMPLE:U_MEMBER'] },
    });
    expect(observed.socketStart).toHaveBeenCalledTimes(1);
    expect(observed.checkers).toHaveLength(1);
    expect(observed.checkers[0].slackWatch).toBeUndefined();
  });

  it('refuses a malformed existing route even when ambient credentials and a legacy watch exist', async () => {
    const config = { slack_watch: { channel: 'D_PILOT' }, telegram_polling: false };
    const directory = createAgent('pilot', config, '{"allowed_channels":');
    vi.stubEnv('SLACK_BOT_TOKEN', 'ambient-bot-token');
    vi.stubEnv('SLACK_APP_TOKEN', 'ambient-app-token');

    await start('pilot', directory, config);

    expect(observed.listeners).toHaveLength(0);
    expect(observed.socketStart).not.toHaveBeenCalled();
    expect(observed.checkers.every((checker) => checker.slackWatch === undefined)).toBe(true);
  });

  it.each([
    ['missing bot', 'SLACK_APP_TOKEN=agent-app-token\n'],
    ['blank bot', 'SLACK_BOT_TOKEN="  "\nSLACK_APP_TOKEN=agent-app-token\n'],
    ['missing app', 'SLACK_BOT_TOKEN=agent-bot-token\n'],
    ['blank app', 'SLACK_BOT_TOKEN=agent-bot-token\nSLACK_APP_TOKEN=\'  \'\n'],
  ])('does not fill a routed agent secret file with ambient credentials: %s', async (_case, content) => {
    const config = { trusted_slack_users: ['pilot-member'], telegram_polling: false };
    const directory = createAgent('pilot', config, route());
    writeFileSync(join(directory, '.env'), content);
    vi.stubEnv('SLACK_BOT_TOKEN', 'ambient-bot-token');
    vi.stubEnv('SLACK_APP_TOKEN', 'ambient-app-token');

    await start('pilot', directory, config);

    expect(observed.listeners).toHaveLength(0);
    expect(observed.socketStart).not.toHaveBeenCalled();
    expect(observed.checkers).toHaveLength(1);
    expect(observed.checkers[0].slackWatch).toBeUndefined();
  });

  it('permits a complete ambient credential pair only when the routed agent secret file is genuinely absent', async () => {
    const config = { trusted_slack_users: ['pilot-member'], telegram_polling: false };
    const directory = createAgent('pilot', config, route());
    vi.stubEnv('SLACK_BOT_TOKEN', 'ambient-bot-token');
    vi.stubEnv('SLACK_APP_TOKEN', 'ambient-app-token');

    await start('pilot', directory, config);

    expect(observed.listeners).toHaveLength(1);
    expect(observed.listeners[0]).toMatchObject({
      agentName: 'pilot', channel: 'D_PILOT', botToken: 'ambient-bot-token', appToken: 'ambient-app-token',
    });
    expect(observed.socketStart).toHaveBeenCalledTimes(1);
    expect(observed.checkers[0].slackWatch).toBeUndefined();
  });

  it('never falls through to ambient Slack credentials when a present .env is an unreadable directory', async () => {
    const config = { slack_watch: { channel: 'D_PILOT' }, telegram_polling: false };
    const directory = createAgent('pilot', config, route());
    mkdirSync(join(directory, '.env'));
    vi.stubEnv('SLACK_BOT_TOKEN', 'ambient-bot-token');
    vi.stubEnv('SLACK_APP_TOKEN', 'ambient-app-token');

    // A platform may reject the entire agent at its earlier Telegram read,
    // or the strict Slack loader may reject just this transport. Both must
    // leave inbound consumers absent instead of using another app's secrets.
    await start('pilot', directory, config).catch(() => {});

    expect(observed.listeners).toHaveLength(0);
    expect(observed.socketStart).not.toHaveBeenCalled();
    expect(observed.checkers.every((checker) => checker.slackWatch === undefined)).toBe(true);
  });

  it.each([true, false])('blocks a second legacy listener sharing an app token (first routed=%s)', async (firstRouted) => {
    const firstConfig = { slack_watch: { channel: 'D_FIRST' }, telegram_polling: false };
    const secondConfig = { slack_watch: { channel: 'D_SECOND' }, telegram_polling: false };
    const firstDirectory = createAgent('first-agent', firstConfig, firstRouted ? route('D_FIRST') : undefined);
    const secondDirectory = createAgent('second-agent', secondConfig);
    writeFileSync(join(firstDirectory, '.env'), 'SLACK_BOT_TOKEN=first-bot\nSLACK_APP_TOKEN=shared-app\n');
    writeFileSync(join(secondDirectory, '.env'), 'SLACK_BOT_TOKEN=second-bot\nSLACK_APP_TOKEN=shared-app\n');

    await start('first-agent', firstDirectory, firstConfig);
    await start('second-agent', secondDirectory, secondConfig);

    expect(observed.listeners.map((listener) => listener.agentName)).toEqual(['first-agent']);
    expect(observed.socketStart).toHaveBeenCalledTimes(1);
    expect(observed.checkers).toHaveLength(2);
    expect(observed.checkers.every((checker) => checker.slackWatch === undefined)).toBe(true);
  });

  it('releases the old app claim when a stale agent is restarted with a different app', async () => {
    const config = { trusted_slack_users: ['pilot-member'], telegram_polling: false };
    const firstDirectory = createAgent('first-agent', config, route('D_FIRST'));
    const secondDirectory = createAgent('second-agent', config, route('D_SECOND'));
    writeFileSync(join(firstDirectory, '.env'), 'SLACK_BOT_TOKEN=first-bot\nSLACK_APP_TOKEN=app-token-a\n');
    await start('first-agent', firstDirectory, config);

    // Drive the production stale-entry eviction path rather than manually
    // clearing the registry or the app-token ownership map under test.
    vi.spyOn(manager as unknown as { isAgentActuallyAlive(name: string): boolean }, 'isAgentActuallyAlive')
      .mockReturnValue(false);
    writeFileSync(join(firstDirectory, '.env'), 'SLACK_BOT_TOKEN=replacement-bot\nSLACK_APP_TOKEN=app-token-b\n');
    await manager.startAgent('first-agent', firstDirectory, config, 'example');

    writeFileSync(join(secondDirectory, '.env'), 'SLACK_BOT_TOKEN=second-bot\nSLACK_APP_TOKEN=app-token-a\n');
    await start('second-agent', secondDirectory, config);

    expect(observed.listeners.map(({ agentName, appToken }) => ({ agentName, appToken }))).toEqual([
      { agentName: 'first-agent', appToken: 'app-token-a' },
      { agentName: 'first-agent', appToken: 'app-token-b' },
      { agentName: 'second-agent', appToken: 'app-token-a' },
    ]);
    expect(observed.socketStart).toHaveBeenCalledTimes(3);
    expect(observed.checkers).toHaveLength(3);
    expect(observed.checkers.every((checker) => checker.slackWatch === undefined)).toBe(true);
  });
});
