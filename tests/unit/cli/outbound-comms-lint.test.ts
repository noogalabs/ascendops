import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir, homedir } from 'os';

const sendMessageSpy = vi.fn().mockReturnValue('msg-test-1');
const telegramSendSpy = vi.fn().mockResolvedValue({ result: { message_id: 1 } });

vi.mock('../../../src/bus/message.js', () => ({
  sendMessage: (...args: unknown[]) => sendMessageSpy(...args),
  checkInbox: vi.fn(() => []),
  ackInbox: vi.fn(),
  // prune-processed (f12-f13-disk-leaks) is imported by src/cli/bus.ts at
  // module-eval; the mock must expose these or bus.ts fails to load here.
  pruneProcessed: vi.fn(),
  PROCESSED_TTL_DAYS: 30,
  PROCESSED_TTL_MIN_DAYS: 1,
}));

vi.mock('../../../src/bus/event.js', () => ({
  logEvent: vi.fn(),
}));

vi.mock('../../../src/telegram/api.js', () => ({
  TelegramAPI: class {
    constructor(_token: string) {}
    sendMessage(...args: unknown[]) {
      return telegramSendSpy(...args);
    }
    sendPhoto = vi.fn().mockResolvedValue({ result: { message_id: 1 } });
    sendDocument = vi.fn().mockResolvedValue({ result: { message_id: 1 } });
  },
}));

import { busCommand } from '../../../src/cli/bus';

let tempCtx: string;
let originalCtxRoot: string | undefined;
let originalAgentName: string | undefined;
let originalBotToken: string | undefined;
let originalInstanceId: string | undefined;
let originalHome: string | undefined;
let originalUserProfile: string | undefined;
let originalFrameworkRoot: string | undefined;
let originalProjectRoot: string | undefined;
let originalOrg: string | undefined;
let originalAgentDir: string | undefined;

beforeEach(() => {
  tempCtx = mkdtempSync(join(tmpdir(), 'comms-lint-ctx-'));
  mkdirSync(join(tempCtx, 'logs', 'test-agent'), { recursive: true });
  mkdirSync(join(tempCtx, 'inbox', 'target-agent'), { recursive: true });
  // Isolated framework root with a real target-agent dir so the send-message
  // recipient-existence gate (Part-2 fails-loud) resolves it as EXISTS rather
  // than falling back to process.cwd() (the repo's real orgs/). Without this,
  // the gate would treat 'target-agent' as unknown and block the allow-cases.
  const fwRoot = join(tempCtx, 'framework');
  mkdirSync(join(fwRoot, 'orgs', 'testorg', 'agents', 'target-agent'), { recursive: true });

  originalCtxRoot = process.env.CTX_ROOT;
  originalAgentName = process.env.CTX_AGENT_NAME;
  originalBotToken = process.env.BOT_TOKEN;
  originalInstanceId = process.env.CTX_INSTANCE_ID;
  originalHome = process.env.HOME;
  originalUserProfile = process.env.USERPROFILE;
  originalFrameworkRoot = process.env.CTX_FRAMEWORK_ROOT;
  originalProjectRoot = process.env.CTX_PROJECT_ROOT;
  originalOrg = process.env.CTX_ORG;
  originalAgentDir = process.env.CTX_AGENT_DIR;

  process.env.CTX_ROOT = tempCtx;
  process.env.CTX_AGENT_NAME = 'test-agent';
  process.env.BOT_TOKEN = 'fake-token';
  process.env.CTX_INSTANCE_ID = 'default';
  process.env.HOME = tempCtx;
  // os.homedir() reads USERPROFILE on Windows (not HOME), so the outbound-log
  // sandbox leaks to the real home dir unless we pin USERPROFILE too.
  process.env.USERPROFILE = tempCtx;
  process.env.CTX_FRAMEWORK_ROOT = fwRoot;
  // Keep the isolation guard in resolveEnv (issue #313) satisfied: projectRoot
  // must EQUAL frameworkRoot and the derived agentDir must sit UNDER it. Pin
  // both to fwRoot and clear any inherited CTX_AGENT_DIR so the agent dir is
  // derived as fwRoot/orgs/testorg/agents/test-agent (subordinate to fwRoot).
  process.env.CTX_PROJECT_ROOT = fwRoot;
  process.env.CTX_ORG = 'testorg';
  delete process.env.CTX_AGENT_DIR;

  sendMessageSpy.mockClear();
  telegramSendSpy.mockClear();
});

afterEach(() => {
  if (originalCtxRoot === undefined) delete process.env.CTX_ROOT;
  else process.env.CTX_ROOT = originalCtxRoot;

  if (originalAgentName === undefined) delete process.env.CTX_AGENT_NAME;
  else process.env.CTX_AGENT_NAME = originalAgentName;

  if (originalBotToken === undefined) delete process.env.BOT_TOKEN;
  else process.env.BOT_TOKEN = originalBotToken;

  if (originalInstanceId === undefined) delete process.env.CTX_INSTANCE_ID;
  else process.env.CTX_INSTANCE_ID = originalInstanceId;

  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;

  if (originalUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = originalUserProfile;

  if (originalFrameworkRoot === undefined) delete process.env.CTX_FRAMEWORK_ROOT;
  else process.env.CTX_FRAMEWORK_ROOT = originalFrameworkRoot;

  if (originalProjectRoot === undefined) delete process.env.CTX_PROJECT_ROOT;
  else process.env.CTX_PROJECT_ROOT = originalProjectRoot;

  if (originalOrg === undefined) delete process.env.CTX_ORG;
  else process.env.CTX_ORG = originalOrg;

  if (originalAgentDir === undefined) delete process.env.CTX_AGENT_DIR;
  else process.env.CTX_AGENT_DIR = originalAgentDir;

  rmSync(tempCtx, { recursive: true, force: true });
});

describe('outbound comms lint', () => {
  it('blocks send-telegram when banned jargon is present', async () => {
    await expect(
      busCommand.parseAsync(['send-telegram', '12345', 'Standing by for next task'], { from: 'user' })
    ).rejects.toThrow();
    expect(telegramSendSpy).not.toHaveBeenCalled();
  });

  it('allows send-telegram with --skip-lint escape hatch', async () => {
    await busCommand.parseAsync(
      ['send-telegram', '12345', 'Standing by for next task', '--skip-lint'],
      { from: 'user' },
    );
    expect(telegramSendSpy).toHaveBeenCalledTimes(1);
  });

  it('blocks send-message on passive waiting posture with no active context', async () => {
    await expect(
      busCommand.parseAsync(['send-message', 'target-agent', 'normal', 'waiting for feedback'], { from: 'user' })
    ).rejects.toThrow();
    expect(sendMessageSpy).not.toHaveBeenCalled();
  });

  it('allows send-message when waiting includes specific next-signal context', async () => {
    await busCommand.parseAsync(
      ['send-message', 'target-agent', 'normal', 'waiting for review; next heartbeat at 00:06 UTC'],
      { from: 'user' },
    );
    expect(sendMessageSpy).toHaveBeenCalledTimes(1);
  });

  it('blocks send-mobile-reply on banned posture phrase', async () => {
    await expect(
      busCommand.parseAsync(['send-mobile-reply', 'test-agent', 'parked here until tomorrow'], { from: 'user' })
    ).rejects.toThrow();

    const outPath = join(homedir(), '.cortextos', 'default', 'logs', 'test-agent', 'outbound-messages.jsonl');
    expect(existsSync(outPath)).toBe(false);
  });

  it('allows send-mobile-reply with --skip-lint and writes outbound log', async () => {
    await busCommand.parseAsync(
      ['send-mobile-reply', 'test-agent', 'parked here until tomorrow', '--skip-lint'],
      { from: 'user' },
    );

    const outPath = join(homedir(), '.cortextos', 'default', 'logs', 'test-agent', 'outbound-messages.jsonl');
    expect(existsSync(outPath)).toBe(true);
    const body = readFileSync(outPath, 'utf-8');
    expect(body).toContain('parked here until tomorrow');
  });

  // ─── Telegram-only plain-talk lint (C5 dispatch 2026-05-22 by Dane) ──────

  it('blocks send-telegram when message contains a PR number', async () => {
    await expect(
      busCommand.parseAsync(['send-telegram', '12345', 'The migration shipped via PR #45 - clean'], { from: 'user' })
    ).rejects.toThrow();
    expect(telegramSendSpy).not.toHaveBeenCalled();
  });

  it('blocks send-telegram when message contains a commit SHA', async () => {
    await expect(
      busCommand.parseAsync(['send-telegram', '12345', 'merge commit 9c9f1c65 landed'], { from: 'user' })
    ).rejects.toThrow();
    expect(telegramSendSpy).not.toHaveBeenCalled();
  });

  it('does NOT block send-telegram on plain numeric IDs (post-SHA-regex-tightening 2026-05-23)', async () => {
    // SHA regex must require at least one hex letter; plain numeric IDs
    // (phone numbers, dollar amounts, ticket numbers) must NOT block.
    await busCommand.parseAsync(
      ['send-telegram', '12345', 'Call back at 4233161234 about ticket 9876543'],
      { from: 'user' },
    );
    expect(telegramSendSpy).toHaveBeenCalledTimes(1);
  });

  it('blocks send-telegram when message contains the cortextos framework name', async () => {
    await expect(
      busCommand.parseAsync(['send-telegram', '12345', 'cortextos updated overnight'], { from: 'user' })
    ).rejects.toThrow();
    expect(telegramSendSpy).not.toHaveBeenCalled();
  });

  it('blocks send-telegram by default when message contains an agent name', async () => {
    await expect(
      busCommand.parseAsync(['send-telegram', '12345', 'Codie just shipped the work'], { from: 'user' })
    ).rejects.toThrow();
    expect(telegramSendSpy).not.toHaveBeenCalled();
  });

  it('allows send-telegram with --explicit-naming when agent name is intentional', async () => {
    await busCommand.parseAsync(
      ['send-telegram', '12345', 'Codie just shipped the work', '--explicit-naming'],
      { from: 'user' },
    );
    expect(telegramSendSpy).toHaveBeenCalledTimes(1);
  });

  it('does NOT apply Telegram patterns to send-message (agent-to-agent stays technical)', async () => {
    await busCommand.parseAsync(
      ['send-message', 'target-agent', 'normal', 'Codie shipped PR #45 commit 9c9f1c65 on cortextos repo'],
      { from: 'user' },
    );
    expect(sendMessageSpy).toHaveBeenCalledTimes(1);
  });

  it('allows send-telegram with --skip-lint for legitimate quoted post-mortem references', async () => {
    await busCommand.parseAsync(
      ['send-telegram', '12345', 'Yesterday I quoted "PR #45" as a reference', '--skip-lint'],
      { from: 'user' },
    );
    expect(telegramSendSpy).toHaveBeenCalledTimes(1);
  });

  it('blocks send-telegram when message contains an em-dash (David hard rule 2026-05-30)', async () => {
    await expect(
      busCommand.parseAsync(['send-telegram', '12345', 'The fix is live — no silent drop'], { from: 'user' })
    ).rejects.toThrow();
    expect(telegramSendSpy).not.toHaveBeenCalled();
  });

  it('blocks send-telegram when message contains an en-dash', async () => {
    await expect(
      busCommand.parseAsync(['send-telegram', '12345', 'Window is 1–3pm today'], { from: 'user' })
    ).rejects.toThrow();
    expect(telegramSendSpy).not.toHaveBeenCalled();
  });

  it('does NOT block send-telegram on plain hyphen-minus (compounds and numeric ranges stay safe)', async () => {
    await busCommand.parseAsync(
      ['send-telegram', '12345', 'The well-known issue is fixed, ETA 1-3pm'],
      { from: 'user' },
    );
    expect(telegramSendSpy).toHaveBeenCalledTimes(1);
  });

  it('allows clean send-telegram message that avoids all Telegram patterns', async () => {
    await busCommand.parseAsync(
      ['send-telegram', '12345', 'The migration shipped overnight - durable docs are now in git'],
      { from: 'user' },
    );
    expect(telegramSendSpy).toHaveBeenCalledTimes(1);
  });
});
