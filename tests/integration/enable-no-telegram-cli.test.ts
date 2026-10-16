/**
 * tests/integration/enable-no-telegram-cli.test.ts
 *
 * Drives the compiled `dist/cli.js enable` end-to-end to lock in that an
 * agent can be enabled without a Telegram channel, matching the daemon's
 * existing optionality (agent-manager.ts already skips Telegram when
 * BOT_TOKEN is absent) — the CLI preflight in enable-agent.ts previously
 * hard-blocked this for every agent regardless of daemon behavior.
 *
 *   - Positive: BOT_TOKEN and CHAT_ID both blank → exit 0, agent enabled.
 *   - Negative: only one of BOT_TOKEN/CHAT_ID set → exit 1 (a real
 *     misconfiguration, not "no Telegram intended", must still fail loud).
 *
 * Skipped when dist/cli.js is absent (build not run).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

const REPO_ROOT = join(__dirname, '..', '..');
const DIST_CLI = join(REPO_ROOT, 'dist', 'cli.js');

let frameworkRoot: string;
let fakeHome: string;

beforeEach(() => {
  frameworkRoot = mkdtempSync(join(tmpdir(), 'enable-no-telegram-fw-'));
  fakeHome = mkdtempSync(join(tmpdir(), 'enable-no-telegram-home-'));
  mkdirSync(join(frameworkRoot, 'orgs', 'testorg', 'agents', 'testagent'), { recursive: true });
});

afterEach(() => {
  try { rmSync(frameworkRoot, { recursive: true }); } catch { /* ignore */ }
  try { rmSync(fakeHome, { recursive: true }); } catch { /* ignore */ }
});

function writeAgentEnv(content: string) {
  writeFileSync(join(frameworkRoot, 'orgs', 'testorg', 'agents', 'testagent', '.env'), content);
}

async function runEnable(): Promise<{ stdout: string; stderr: string; code: number }> {
  try {
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      [DIST_CLI, 'enable', 'testagent', '--org', 'testorg', '--instance', 'default'],
      { env: { ...process.env, CTX_FRAMEWORK_ROOT: frameworkRoot, HOME: fakeHome } },
    );
    return { stdout, stderr, code: 0 };
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stdout?: string; stderr?: string; code?: number };
    return {
      stdout: e.stdout ?? '',
      stderr: e.stderr ?? '',
      code: typeof e.code === 'number' ? e.code : 1,
    };
  }
}

describe.skipIf(!existsSync(DIST_CLI))('enable without a Telegram channel (CLI)', () => {
  it('both BOT_TOKEN and CHAT_ID blank → exit 0, agent enabled', async () => {
    writeAgentEnv('BOT_TOKEN=\nCHAT_ID=\n');
    const { stdout, code } = await runEnable();
    expect(code).toBe(0);
    expect(stdout).toContain('enabling without a Telegram channel');
    expect(stdout).toContain('Agent "testagent" enabled.');

    const enabledAgents = JSON.parse(
      readFileSync(join(fakeHome, '.cortextos', 'default', 'config', 'enabled-agents.json'), 'utf-8'),
    );
    expect(enabledAgents.testagent.enabled).toBe(true);
  });

  it('only BOT_TOKEN set (CHAT_ID blank) → exit 1, does not enable', async () => {
    writeAgentEnv('BOT_TOKEN=123:abc\nCHAT_ID=\n');
    const { stderr, code } = await runEnable();
    expect(code).toBe(1);
    expect(stderr).toContain('missing required value: CHAT_ID');
    expect(existsSync(join(fakeHome, '.cortextos', 'default', 'config', 'enabled-agents.json'))).toBe(false);
  });

  it('only CHAT_ID set (BOT_TOKEN blank) → exit 1, does not enable', async () => {
    writeAgentEnv('BOT_TOKEN=\nCHAT_ID=555\n');
    const { stderr, code } = await runEnable();
    expect(code).toBe(1);
    expect(stderr).toContain('missing required value: BOT_TOKEN');
  });
});
