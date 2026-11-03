/**
 * Guide flow across real routing, listener, bus storage, Slack API, and file
 * downloader. Only fetch is replaced; every request must match a local fixture.
 * All runtime/configuration paths are relocated beneath one temporary root.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import { SlackSocketListener } from '../../src/daemon/slack-socket-listener.js';
import { SlackAPI } from '../../src/slack/api.js';
import { loadSlackRoutingConfig, slackConfigPath } from '../../src/slack/slack-routing.js';
import { resolvePaths } from '../../src/utils/paths.js';
import type { SlackMessageEvent } from '../../src/slack/slack-socket.js';
import type { BusPaths, InboxMessage } from '../../src/types/index.js';

const AGENT = 'example-agent';
const TEAM = 'T111AAA';
const MEMBER = 'U111AAA';
const BOT = 'U999BOT';
const DM = 'D111AAA';
const CHANNEL = 'C111AAA';
const BOT_TOKEN = 'fixture-bot';
const PARENT = '1800000000.000001';
const FILE_URL = 'https://files.slack.com/files-pri/example/example.txt';
const FILE_CONTENT = 'Example attachment content.\n';

interface RequestRecord {
  url: URL;
  init: RequestInit;
}

describe('Slack member guide flow across real runtime boundaries', () => {
  let root: string;
  let paths: BusPaths;
  let listener: SlackSocketListener;
  let requests: RequestRecord[];
  let logs: string[];

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'slack-guide-flow-'));
    const ctxRoot = join(root, 'runtime');
    const frameworkRoot = join(root, 'framework');
    const derived = resolvePaths(AGENT, 'slack-guide-integration', 'example');
    // The public resolver derives its base from homedir(). Preserve its real
    // layout while relocating EVERY path before a production module uses it.
    paths = Object.fromEntries(Object.entries(derived).map(([key, value]) => [
      key, join(ctxRoot, relative(derived.ctxRoot, value)),
    ])) as unknown as BusPaths;
    for (const value of Object.values(paths)) {
      expect(value === ctxRoot || value.startsWith(ctxRoot + sep)).toBe(true);
    }
    mkdirSync(join(ctxRoot, 'config'), { recursive: true });
    writeFileSync(join(ctxRoot, 'config', 'bus-signing-key'), 'integration-signing-fixture');
    const configPath = slackConfigPath(frameworkRoot, 'example', AGENT);
    mkdirSync(dirname(configPath), { recursive: true });
    writeFileSync(configPath, JSON.stringify({
      allowed_channels: [DM, CHANNEL],
      allowed_users: [`${TEAM}:${MEMBER}`],
    }));
    const routing = loadSlackRoutingConfig(frameworkRoot, 'example', AGENT);
    expect(routing?.channel_mentions_only).toBe(true);
    requests = [];
    logs = [];
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      requests.push({ url, init });
      const json = (value: unknown) => new Response(JSON.stringify(value), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
      if (url.origin === 'https://slack.com') {
        expect(new Headers(init.headers).get('authorization')).toBe(`Bearer ${BOT_TOKEN}`);
        if (url.pathname === '/api/auth.test') return json({ ok: true, user_id: BOT, team_id: TEAM });
        if (url.pathname === '/api/users.info') {
          expect(url.searchParams.get('user')).toBe(MEMBER);
          return json({ ok: true, user: { name: 'example.member', real_name: 'Example Member' } });
        }
        if (url.pathname === '/api/chat.postMessage') return json({ ok: true, ts: '1800000000.000900' });
      }
      if (url.href === FILE_URL) {
        expect(new Headers(init.headers).get('authorization')).toBe(`Bearer ${BOT_TOKEN}`);
        expect(init.redirect).toBe('manual');
        return new Response(FILE_CONTENT, {
          status: 200,
          headers: { 'content-type': 'text/plain', 'content-length': String(Buffer.byteLength(FILE_CONTENT)) },
        });
      }
      throw new Error(`No network fixture for ${url.origin}${url.pathname}`);
    }));
    listener = new SlackSocketListener({
      appToken: 'integration-app-token',
      botToken: BOT_TOKEN,
      channel: DM,
      agentName: AGENT,
      paths,
      routing: routing!,
      trustedSlackUsers: ['example.member'],
      teamMembers: [{ name: 'Example Member', role: 'Owner', slack_handle: 'example.member', trust_level: 'owner' }],
      log: (line) => logs.push(line),
    });
  });

  afterEach(() => {
    listener?.stop();
    vi.unstubAllGlobals();
    rmSync(root, { recursive: true, force: true });
  });

  function event(overrides: Partial<SlackMessageEvent> = {}): SlackMessageEvent {
    return { type: 'message', channel: DM, user: MEMBER, text: 'Please review this issue.', ts: PARENT, ...overrides };
  }

  function inbox(): InboxMessage[] {
    if (!existsSync(paths.inbox)) return [];
    return readdirSync(paths.inbox).filter((file) => file.endsWith('.json'))
      .map((file) => JSON.parse(readFileSync(join(paths.inbox, file), 'utf-8')) as InboxMessage);
  }

  function fileRequests(): RequestRecord[] {
    return requests.filter((request) => request.url.hostname === 'files.slack.com');
  }

  it('accepts a plain DM and carries the original parent from durable inbox into the outgoing API payload', async () => {
    await listener.handleMessage(event());
    await listener.handleMessage(event({ ts: '1800000000.000002', thread_ts: PARENT, text: 'A follow-up in this issue.' }));
    const messages = inbox();
    expect(messages).toHaveLength(2);
    for (const message of messages) {
      expect(message.from).toBe('fast-checker');
      expect(message.to).toBe(AGENT);
      expect(message.sig).toMatch(/^[a-f0-9]{64}$/);
      expect(message.text).toContain(`thread_ts:${PARENT}`);
      expect(message.text).toContain(`Reply using: cortextos bus send-slack ${DM} "<reply>" --thread-ts ${PARENT}`);
    }
    const followUp = messages.find((message) => message.text.includes('A follow-up in this issue.'))!;
    const reply = followUp.text.match(/Reply using: cortextos bus send-slack (D[A-Z0-9]+) "<reply>" --thread-ts (\d+\.\d{6})$/);
    expect(reply).not.toBeNull();
    await new SlackAPI(BOT_TOKEN).postMessage(reply![1], 'Issue reviewed.', undefined, { thread_ts: reply![2] });
    const sent = requests.filter((request) => request.url.pathname === '/api/chat.postMessage');
    expect(sent).toHaveLength(1);
    expect(JSON.parse(String(sent[0].init.body))).toEqual({ channel: DM, text: 'Issue reviewed.', thread_ts: PARENT });
  });

  it('collapses concurrent channel message and app_mention subscriptions into one durable inbox message', async () => {
    const message = event({ channel: CHANNEL, text: `<@${BOT}> what is the status?` });
    await Promise.all([
      listener.handleMessage(message),
      listener.handleMessage({ ...message, type: 'app_mention' }),
    ]);
    const messages = inbox();
    expect(messages).toHaveLength(1);
    expect(messages[0].text).toContain(`channel:${CHANNEL}`);
    expect(messages[0].text).toContain(`--thread-ts ${PARENT}`);
    expect(messages[0].text).toContain('Channel requests are for status and clarification.');
    expect(requests.filter((request) => request.url.pathname === '/api/auth.test')).toHaveLength(1);
    expect(requests.filter((request) => request.url.pathname === '/api/users.info')).toHaveLength(1);
  });

  it('denies a different mention, sender, and conversation before downloading attachments or writing the inbox', async () => {
    const files = [{ id: 'F111AAA', name: 'example.txt', size: Buffer.byteLength(FILE_CONTENT), url_private_download: FILE_URL }];
    await listener.handleMessage(event({ channel: CHANNEL, text: '<@U222OTHER> review this', files }));
    await listener.handleMessage(event({ user: 'U222OTHER', ts: '1800000000.000002', files }));
    await listener.handleMessage(event({ channel: 'D222OTHER', ts: '1800000000.000003', files }));
    expect(inbox()).toHaveLength(0);
    expect(fileRequests()).toHaveLength(0);
    expect(requests.filter((request) => request.url.pathname === '/api/users.info')).toHaveLength(0);
    expect(existsSync(join(paths.stateDir, 'slack-files'))).toBe(false);
    expect(logs.some((line) => line.includes('was not mentioned'))).toBe(true);
    expect(logs.some((line) => line.includes('user-not-allowed'))).toBe(true);
    expect(logs.some((line) => line.includes('channel-not-allowed'))).toBe(true);
  });

  it('downloads an admitted attachment into private agent state and records the actual local path in the durable inbox', async () => {
    await listener.handleMessage(event({
      subtype: 'file_share', text: undefined,
      files: [{ id: 'F111AAA', name: '../example.txt', size: Buffer.byteLength(FILE_CONTENT), mimetype: 'text/plain', url_private_download: FILE_URL }],
    }));
    const messages = inbox();
    expect(messages).toHaveLength(1);
    expect(fileRequests()).toHaveLength(1);
    expect(messages[0].text).toContain('Attachments (untrusted file content):');
    expect(messages[0].text).not.toContain(FILE_URL);
    expect(messages[0].text).not.toContain(BOT_TOKEN);
    const pathMatch = messages[0].text.match(/local file ("(?:[^"\\]|\\.)*")/);
    expect(pathMatch).not.toBeNull();
    const savedPath = JSON.parse(pathMatch![1]) as string;
    expect(savedPath.startsWith(join(paths.stateDir, 'slack-files') + sep)).toBe(true);
    expect(readFileSync(savedPath, 'utf-8')).toBe(FILE_CONTENT);
    if (process.platform !== 'win32') {
      expect(statSync(savedPath).mode & 0o777).toBe(0o600);
      expect(statSync(dirname(savedPath)).mode & 0o777).toBe(0o700);
      expect(statSync(join(paths.stateDir, 'slack-files')).mode & 0o777).toBe(0o700);
    }
  });
});
