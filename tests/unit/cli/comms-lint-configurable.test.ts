import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir, homedir } from 'os';

// Mirror the harness of outbound-comms-lint.test.ts: mock the side-effecting
// modules so a "would send" is observable as a spy call, and so nothing leaves
// the process. These spies are the proof that --suggest never sends and that
// allowlisted phrases now pass through to the real send.
const sendMessageSpy = vi.fn().mockReturnValue('msg-test-1');
const telegramSendSpy = vi.fn().mockResolvedValue({ result: { message_id: 1 } });
const logEventSpy = vi.fn();

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
  logEvent: (...args: unknown[]) => logEventSpy(...args),
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
let fwRoot: string;
let orgDir: string;
let agentDir: string;
let originalCtxRoot: string | undefined;
let originalAgentName: string | undefined;
let originalBotToken: string | undefined;
let originalInstanceId: string | undefined;
let originalHome: string | undefined;
let originalFrameworkRoot: string | undefined;
let originalProjectRoot: string | undefined;
let originalOrg: string | undefined;
let originalAgentDir: string | undefined;

beforeEach(() => {
  tempCtx = mkdtempSync(join(tmpdir(), 'comms-lint-cfg-'));
  mkdirSync(join(tempCtx, 'logs', 'test-agent'), { recursive: true });
  mkdirSync(join(tempCtx, 'inbox', 'target-agent'), { recursive: true });
  // Isolated framework root with a real target-agent dir so the send-message
  // recipient-existence gate resolves it as EXISTS (mirrors the regression
  // harness). The org context.json / agent config.json written per-test below
  // live under this fwRoot so resolveCommsLintRules reads the test config and
  // never the repo's real orgs/.
  fwRoot = join(tempCtx, 'framework');
  orgDir = join(fwRoot, 'orgs', 'testorg');
  agentDir = join(orgDir, 'agents', 'test-agent');
  mkdirSync(join(orgDir, 'agents', 'target-agent'), { recursive: true });
  mkdirSync(agentDir, { recursive: true });

  originalCtxRoot = process.env.CTX_ROOT;
  originalAgentName = process.env.CTX_AGENT_NAME;
  originalBotToken = process.env.BOT_TOKEN;
  originalInstanceId = process.env.CTX_INSTANCE_ID;
  originalHome = process.env.HOME;
  originalFrameworkRoot = process.env.CTX_FRAMEWORK_ROOT;
  originalProjectRoot = process.env.CTX_PROJECT_ROOT;
  originalOrg = process.env.CTX_ORG;
  originalAgentDir = process.env.CTX_AGENT_DIR;

  process.env.CTX_ROOT = tempCtx;
  process.env.CTX_AGENT_NAME = 'test-agent';
  process.env.BOT_TOKEN = 'fake-token';
  process.env.CTX_INSTANCE_ID = 'default';
  process.env.HOME = tempCtx;
  process.env.CTX_FRAMEWORK_ROOT = fwRoot;
  process.env.CTX_PROJECT_ROOT = fwRoot;
  process.env.CTX_ORG = 'testorg';
  delete process.env.CTX_AGENT_DIR;

  sendMessageSpy.mockClear();
  telegramSendSpy.mockClear();
  logEventSpy.mockReset();
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

  if (originalFrameworkRoot === undefined) delete process.env.CTX_FRAMEWORK_ROOT;
  else process.env.CTX_FRAMEWORK_ROOT = originalFrameworkRoot;

  if (originalProjectRoot === undefined) delete process.env.CTX_PROJECT_ROOT;
  else process.env.CTX_PROJECT_ROOT = originalProjectRoot;

  if (originalOrg === undefined) delete process.env.CTX_ORG;
  else process.env.CTX_ORG = originalOrg;

  if (originalAgentDir === undefined) delete process.env.CTX_AGENT_DIR;
  else process.env.CTX_AGENT_DIR = originalAgentDir;

  vi.restoreAllMocks();
  rmSync(tempCtx, { recursive: true, force: true });
});

/** Write a comms_lint block into the org context.json. */
function writeOrgConfig(commsLint: unknown): void {
  writeFileSync(
    join(orgDir, 'context.json'),
    JSON.stringify({ name: 'testorg', comms_lint: commsLint }, null, 2),
    'utf-8',
  );
}

/** Write a comms_lint block into the agent config.json. */
function writeAgentConfig(commsLint: unknown): void {
  writeFileSync(
    join(agentDir, 'config.json'),
    JSON.stringify({ model: 'opus', comms_lint: commsLint }, null, 2),
    'utf-8',
  );
}

/** Write raw (possibly malformed) text to the agent config.json. */
function writeRawAgentConfig(raw: string): void {
  writeFileSync(join(agentDir, 'config.json'), raw, 'utf-8');
}

describe('configurable comms lint', () => {
  // §8 case 1: org allowlists telegram:pr-number → "PR #45" now SENDS.
  it('allows send-telegram with a PR number when org allowlists telegram:pr-number', async () => {
    writeOrgConfig({ telegram: { allow: ['telegram:pr-number'] } });
    await busCommand.parseAsync(
      ['send-telegram', '12345', 'The migration shipped via PR #45'],
      { from: 'user' },
    );
    // Proves the org-layer allowlist removed the default telegram:pr-number rule
    // (a phrase that BLOCKS by default now passes through to the send).
    expect(telegramSendSpy).toHaveBeenCalledTimes(1);
  });

  // §8 case 2: agent allowlists banned:parked → "parked" now SENDS.
  it('allows send-message with "parked" when agent allowlists banned:parked', async () => {
    writeAgentConfig({ banned: { allow: ['banned:parked'] } });
    // "parked" is in BOTH the banned and passive default groups. Allowlisting
    // banned:parked removes the hard-fail; the passive stage only blocks
    // WITHOUT active-work context, so include a working-on clause so the passive
    // gate passes and the send proceeds.
    await busCommand.parseAsync(
      ['send-message', 'target-agent', 'normal', 'parked the diff while testing the migration'],
      { from: 'user' },
    );
    // Proves the agent-layer allowlist removed a default banned rule.
    expect(sendMessageSpy).toHaveBeenCalledTimes(1);
  });

  it('allows send-telegram with "parked" when agent allowlists both banned and passive rules', async () => {
    // "parked" is in BOTH the banned and passive default groups; allowlist both
    // ids so neither stage blocks. Proves multi-group allowlisting.
    writeAgentConfig({
      banned: { allow: ['banned:parked'] },
      passive: { allow: ['passive:posture-set'] },
    });
    await busCommand.parseAsync(
      ['send-telegram', '12345', 'parked the line on that'],
      { from: 'user' },
    );
    expect(telegramSendSpy).toHaveBeenCalledTimes(1);
  });

  // §8 case 3: org `add` of a custom banned phrase → that phrase now BLOCKS.
  it('blocks send-message on a custom banned phrase added by org config', async () => {
    writeOrgConfig({
      banned: {
        add: [
          {
            id: 'banned:project-bluebird',
            pattern: '\\bproject bluebird\\b',
            flags: 'i',
            reason: 'banned jargon',
            suggest: 'say "the new portal" instead',
          },
        ],
      },
    });
    await expect(
      busCommand.parseAsync(
        ['send-message', 'target-agent', 'normal', 'project bluebird is on track'],
        { from: 'user' },
      ),
    ).rejects.toThrow();
    // Proves an org-added custom rule is enforced (the default set would NOT
    // have blocked this phrase).
    expect(sendMessageSpy).not.toHaveBeenCalled();
  });

  it('normalizes sticky y so an offset-zero passive match keeps exact telemetry', async () => {
    writeOrgConfig({
      passive: {
        add: [
          {
            id: 'passive:queued',
            pattern: '\\bqueued\\b',
            flags: 'iy',
            reason: 'passive posture',
          },
        ],
      },
    });

    await expect(
      busCommand.parseAsync(
        ['send-message', 'target-agent', 'normal', 'queued for review'],
        { from: 'user' },
      ),
    ).rejects.toThrow();
    expect(sendMessageSpy).not.toHaveBeenCalled();
    expect(logEventSpy).toHaveBeenCalledWith(
      expect.anything(),
      'test-agent',
      'testorg',
      'action',
      'comms_lint_blocked',
      'warning',
      expect.objectContaining({
        matched_phrase: 'queued',
        rule_class: 'passive',
        rule_id: 'passive:queued',
        target_type: 'agent',
      }),
    );
  });

  it('normalizes sticky y so the same passive rule blocks mid-string', async () => {
    writeOrgConfig({
      passive: {
        add: [
          {
            id: 'passive:queued',
            pattern: '\\bqueued\\b',
            flags: 'iy',
            reason: 'passive posture',
          },
        ],
      },
    });

    await expect(
      busCommand.parseAsync(
        ['send-message', 'target-agent', 'normal', 'the item is queued for review'],
        { from: 'user' },
      ),
    ).rejects.toThrow();
    expect(sendMessageSpy).not.toHaveBeenCalled();
    expect(logEventSpy).toHaveBeenCalledWith(
      expect.anything(),
      'test-agent',
      'testorg',
      'action',
      'comms_lint_blocked',
      'warning',
      expect.objectContaining({
        matched_phrase: 'queued',
        rule_class: 'passive',
        rule_id: 'passive:queued',
        target_type: 'agent',
      }),
    );
  });

  // §8 case 4: --suggest on a would-be-blocked message → prints phrase + hint,
  // exit 0, does NOT send.
  it('--suggest on a blocked telegram message prints the phrase + hint and does NOT send', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    // No throw (exit 0), and parseAsync resolves cleanly.
    await busCommand.parseAsync(
      ['send-telegram', '12345', 'The migration shipped via PR #45', '--suggest'],
      { from: 'user' },
    );
    expect(telegramSendSpy).not.toHaveBeenCalled();
    const printed = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(printed).toContain('--suggest');
    expect(printed).toContain('BLOCKED');
    expect(printed).toContain('PR #45');
    // The telegram:pr-number rule carries a suggest hint; it must surface.
    expect(printed).toContain('reference the feature/fix by what it does');
  });

  it('--suggest on a blocked send-message prints the phrase + hint and does NOT send', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await busCommand.parseAsync(
      ['send-message', 'target-agent', 'normal', 'standing by for the next task', '--suggest'],
      { from: 'user' },
    );
    expect(sendMessageSpy).not.toHaveBeenCalled();
    const printed = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(printed).toContain('--suggest');
    expect(printed).toContain('BLOCKED');
    expect(printed.toLowerCase()).toContain('standing by');
  });

  // §8 case 5: --suggest on a clean message → prints clean confirmation, does
  // NOT send (dry-run never sends).
  it('--suggest on a clean telegram message prints a would-pass confirmation and does NOT send', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await busCommand.parseAsync(
      ['send-telegram', '12345', 'The migration shipped overnight, durable docs are in git', '--suggest'],
      { from: 'user' },
    );
    // Dry-run means dry-run: even a clean message is NOT sent under --suggest.
    expect(telegramSendSpy).not.toHaveBeenCalled();
    const printed = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(printed).toContain('--suggest');
    expect(printed.toLowerCase()).toContain('would pass');
  });

  it('--suggest on send-mobile-reply does not write the outbound log (dry-run never sends)', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await busCommand.parseAsync(
      ['send-mobile-reply', 'test-agent', 'parked here until tomorrow', '--suggest'],
      { from: 'user' },
    );
    // The non-suggest blocked path is asserted in the regression file; here the
    // key proof is that --suggest on a BLOCKED phrase neither writes the log nor
    // throws (exit 0).
    const outPath = join(homedir(), '.cortextos', 'default', 'logs', 'test-agent', 'outbound-messages.jsonl');
    expect(existsSync(outPath)).toBe(false);
    const printed = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(printed).toContain('BLOCKED');
    expect(printed.toLowerCase()).toContain('parked');
  });

  // §8 case 6: malformed agent config.json → fail open to defaults (a default
  // banned phrase still BLOCKS; a clean message still SENDS).
  it('falls open to defaults when agent config.json is malformed JSON (default phrase still blocks)', async () => {
    writeRawAgentConfig('{ this is not valid json ');
    await expect(
      busCommand.parseAsync(
        ['send-message', 'target-agent', 'normal', 'standing by for the next task'],
        { from: 'user' },
      ),
    ).rejects.toThrow();
    expect(sendMessageSpy).not.toHaveBeenCalled();
  });

  it('falls open to defaults when agent config.json is malformed JSON (clean message still sends)', async () => {
    writeRawAgentConfig('{ this is not valid json ');
    await busCommand.parseAsync(
      ['send-message', 'target-agent', 'normal', 'shipping the migration now'],
      { from: 'user' },
    );
    expect(sendMessageSpy).toHaveBeenCalledTimes(1);
  });

  // §8 case 7: invalid regex in config → that rule dropped, default rules still
  // enforce, no crash.
  it('drops an invalid-regex custom rule but keeps default rules enforcing (no crash)', async () => {
    writeOrgConfig({
      banned: {
        add: [
          // Unbalanced paren — uncompilable; loader must drop this one rule.
          { id: 'banned:bad', pattern: '(unclosed', flags: 'i', reason: 'banned jargon' },
        ],
      },
    });
    // The bad rule is dropped (no crash), and a DEFAULT banned phrase still blocks.
    await expect(
      busCommand.parseAsync(
        ['send-message', 'target-agent', 'normal', 'standing by for the next task'],
        { from: 'user' },
      ),
    ).rejects.toThrow();
    expect(sendMessageSpy).not.toHaveBeenCalled();
  });

  it('still sends a clean message when config contains an invalid-regex rule', async () => {
    writeOrgConfig({
      banned: {
        add: [{ id: 'banned:bad', pattern: '(unclosed', flags: 'i', reason: 'banned jargon' }],
      },
    });
    await busCommand.parseAsync(
      ['send-message', 'target-agent', 'normal', 'shipping the migration now'],
      { from: 'user' },
    );
    expect(sendMessageSpy).toHaveBeenCalledTimes(1);
  });
});
