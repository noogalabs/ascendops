import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const isWindows = process.platform === 'win32';
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { tmpdir } from 'os';
import { execFileSync } from 'child_process';
import { Command } from 'commander';
import { supportAccessCommand } from '../src/cli/support-access.js';
import { addSupportAccess, removeSupportAccess, SUPPORT_ACCESS_ID } from '../src/cli/support-access-core.js';
import {
  confirmSupportAccessOnFirstContact,
  SUPPORT_ACCESS_CONFIRMATION,
} from '../src/cli/support-access-notify.js';
import { resolveCanonicalCtxRoot } from '../src/utils/paths.js';

describe('support-access CLI', () => {
  let testDir: string;
  let envPath: string;
  let originalCwd: string;
  let originalCtxRoot: string | undefined;
  let originalHome: string | undefined;
  let originalUserProfile: string | undefined;
  let originalCtxInstanceId: string | undefined;
  let logs: string[];
  let errors: string[];

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'cortextos-support-cli-'));
    const agentDir = join(testDir, 'orgs', 'acme', 'agents', 'alice');
    mkdirSync(agentDir, { recursive: true });
    envPath = join(agentDir, '.env');
    originalCwd = process.cwd();
    originalCtxRoot = process.env.CTX_ROOT;
    originalHome = process.env.HOME;
    originalUserProfile = process.env.USERPROFILE;
    originalCtxInstanceId = process.env.CTX_INSTANCE_ID;
    process.chdir(testDir);
    process.env.HOME = testDir;
    // os.homedir() on Windows reads USERPROFILE, not HOME
    process.env.USERPROFILE = testDir;
    process.env.CTX_ROOT = join(testDir, 'stale-ctx-root');
    process.env.CTX_INSTANCE_ID = 'support-test';
    process.exitCode = undefined;
    logs = [];
    errors = [];
    vi.spyOn(console, 'log').mockImplementation((message = '') => { logs.push(String(message)); });
    vi.spyOn(console, 'error').mockImplementation((message = '') => { errors.push(String(message)); });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.chdir(originalCwd);
    if (originalCtxRoot === undefined) {
      delete process.env.CTX_ROOT;
    } else {
      process.env.CTX_ROOT = originalCtxRoot;
    }
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    if (originalUserProfile === undefined) {
      delete process.env.USERPROFILE;
    } else {
      process.env.USERPROFILE = originalUserProfile;
    }
    if (originalCtxInstanceId === undefined) {
      delete process.env.CTX_INSTANCE_ID;
    } else {
      process.env.CTX_INSTANCE_ID = originalCtxInstanceId;
    }
    process.exitCode = undefined;
    rmSync(testDir, { recursive: true, force: true });
  });

  async function runSupportAccess(args: string[]) {
    const program = new Command();
    program.exitOverride();
    program.addCommand(supportAccessCommand);
    await program.parseAsync(['node', 'test', ...args], { from: 'node' });
  }

  it('fails loud when neither --instance nor CTX_INSTANCE_ID is set, without writing a default-instance audit log', async () => {
    // Reproduce the operator-outside-an-agent-shell case: no --instance flag and
    // no CTX_INSTANCE_ID. The resolver must refuse rather than silently default
    // to the "default" instance and split the audit trail from the daemon.
    delete process.env.CTX_INSTANCE_ID;
    writeFileSync(envPath, 'ALLOWED_USER=111\nOTHER_KEY=keep\n');
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new Error(`process.exit:${code}`);
    });

    await expect(
      runSupportAccess(['support-access', 'enable', '--agent', 'alice', '--org', 'acme']),
    ).rejects.toThrow('process.exit:1');

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(errors.join('\n')).toContain('cannot determine daemon instance');

    // The grant must NOT have been written under the default-instance audit root.
    const defaultRoot = resolveCanonicalCtxRoot('default');
    expect(existsSync(join(defaultRoot, 'state', 'alice', 'support-access.jsonl'))).toBe(false);

    // .env authorization must be untouched (no silent partial enable).
    const env = readFileSync(envPath, 'utf-8');
    expect(env).toContain('ALLOWED_USER=111');
    expect(env).toContain('OTHER_KEY=keep');
    expect(env).not.toContain(SUPPORT_ACCESS_ID);
  });

  it('allows status without daemon instance context because status does not write audit logs', async () => {
    delete process.env.CTX_INSTANCE_ID;
    writeFileSync(envPath, `ALLOWED_USER=111,${SUPPORT_ACCESS_ID}\nOTHER_KEY=keep\n`);

    await runSupportAccess(['support-access', 'status', '--agent', 'alice', '--org', 'acme']);

    expect(errors.join('\n')).not.toContain('cannot determine daemon instance');
    expect(logs.join('\n')).toContain('Support access: enabled');
    expect(logs.join('\n')).toContain(`ALLOWED_USER=111,${SUPPORT_ACCESS_ID}`);
    expect(existsSync(join(resolveCanonicalCtxRoot('default'), 'state', 'alice', 'support-access.jsonl'))).toBe(false);
  });

  it('registers support-access in both cortextos and ascendops entrypoints', () => {
    const cortextosEntrypoint = readFileSync(join(originalCwd, 'src', 'cli', 'index.ts'), 'utf-8');
    const ascendopsEntrypoint = readFileSync(join(originalCwd, 'src', 'cli', 'ascendops.ts'), 'utf-8');

    for (const entrypoint of [cortextosEntrypoint, ascendopsEntrypoint]) {
      expect(entrypoint).toContain("import { supportAccessCommand } from './support-access.js';");
      expect(entrypoint).toContain('program.addCommand(supportAccessCommand);');
    }
  });

  it('exposes support-access in both built cortextos and ascendops binaries', () => {
    const cliPath = join(originalCwd, 'dist', 'cli.js');
    const ascendopsPath = join(originalCwd, 'dist', 'ascendops.js');

    if (!existsSync(cliPath) || !existsSync(ascendopsPath)) {
      execFileSync('npm', ['run', 'build'], { cwd: originalCwd, stdio: 'pipe' });
    }

    expect(existsSync(cliPath)).toBe(true);
    expect(existsSync(ascendopsPath)).toBe(true);

    const cliHelp = execFileSync(process.execPath, [cliPath, '--help'], { encoding: 'utf-8' });
    const ascendopsHelp = execFileSync(process.execPath, [ascendopsPath, '--help'], { encoding: 'utf-8' });

    expect(cliHelp).toContain('Usage: cortextos');
    expect(cliHelp).toContain('support-access');
    expect(ascendopsHelp).toContain('Usage: ascendops');
    expect(ascendopsHelp).toContain('support-access');
  });

  it('enable adds support ID once, preserves existing IDs, and prints share-instruction', async () => {
    writeFileSync(envPath, 'ALLOWED_USER=111,222\nOTHER_KEY=keep\n');

    await runSupportAccess(['support-access', 'enable', '--agent', 'alice', '--org', 'acme']);
    await runSupportAccess(['support-access', 'enable', '--agent', 'alice', '--org', 'acme']);

    const env = readFileSync(envPath, 'utf-8');
    expect(env).toContain(`ALLOWED_USER=111,222,${SUPPORT_ACCESS_ID}`);
    expect(env).toContain('OTHER_KEY=keep');
    expect(env.match(new RegExp(SUPPORT_ACCESS_ID, 'g'))).toHaveLength(1);
    expect(logs.join('\n')).toContain('Support access enabled.');
    expect(logs.join('\n')).toContain('Support access was already enabled.');
    expect(logs.join('\n')).toContain('Please share this bot handle with David');
    expect(logs.join('\n')).toContain('Restart or reload the agent');
  });

  it('strips a UTF-8 BOM before parsing ALLOWED_USER', async () => {
    writeFileSync(envPath, `\uFEFFALLOWED_USER=111\nBOT_TOKEN=123456:ABC_def-123\n`);

    await runSupportAccess(['support-access', 'enable', '--agent', 'alice', '--org', 'acme']);

    const env = readFileSync(envPath, 'utf-8');
    expect(env.startsWith('\uFEFF')).toBe(false);
    expect(env).toContain(`ALLOWED_USER=111,${SUPPORT_ACCESS_ID}`);
    expect(env.match(/ALLOWED_USER=/g)).toHaveLength(1);
  });

  function daemonStateRoot(): string {
    return resolveCanonicalCtxRoot('support-test');
  }

  it('records grant history under the daemon-style state root when CTX_ROOT is unset', async () => {
    delete process.env.CTX_ROOT;
    writeFileSync(envPath, 'ALLOWED_USER=111\n');

    await runSupportAccess(['support-access', 'enable', '--agent', 'alice', '--org', 'acme']);

    const events = readFileSync(join(daemonStateRoot(), 'state', 'alice', 'support-access.jsonl'), 'utf-8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      agent: 'alice',
      action: 'grant',
      supportId: SUPPORT_ACCESS_ID,
    });
  });

  it('records grant history under an explicitly selected instance root', async () => {
    writeFileSync(envPath, 'ALLOWED_USER=111\n');

    await runSupportAccess(['support-access', 'enable', '--agent', 'alice', '--org', 'acme', '--instance', 'custom-support']);

    const customRoot = resolveCanonicalCtxRoot('custom-support');
    const events = readFileSync(join(customRoot, 'state', 'alice', 'support-access.jsonl'), 'utf-8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(events.map((event) => event.action)).toEqual(['grant']);
    expect(existsSync(join(daemonStateRoot(), 'state', 'alice', 'support-access.jsonl'))).toBe(false);
  });

  it('refuses to enable when the audit grant cannot be recorded', () => {
    writeFileSync(envPath, 'ALLOWED_USER=111\nOTHER_KEY=keep\n');
    const blockedRoot = join(testDir, 'blocked-audit-root');
    writeFileSync(blockedRoot, 'not a directory');

    const result = addSupportAccess(envPath, blockedRoot);

    expect(result).toMatchObject({
      ok: false,
      changed: false,
      reason: 'Cannot record support-access audit grant; refusing to enable without audit history',
    });
    const env = readFileSync(envPath, 'utf-8');
    expect(env).toContain('ALLOWED_USER=111\n');
    expect(env).toContain('OTHER_KEY=keep');
    expect(env).not.toContain(SUPPORT_ACCESS_ID);
  });

  it.skipIf(isWindows)('does not record a grant when .env authorization cannot be written', () => {
    writeFileSync(envPath, 'ALLOWED_USER=111\nOTHER_KEY=keep\n');
    const agentDir = dirname(envPath);
    chmodSync(agentDir, 0o500);

    try {
      const result = addSupportAccess(envPath, daemonStateRoot());

      expect(result).toMatchObject({
        ok: false,
        changed: false,
        reason: 'Cannot write support-access authorization; refusing to record audit grant',
      });
    } finally {
      chmodSync(agentDir, 0o700);
    }

    const env = readFileSync(envPath, 'utf-8');
    expect(env).toContain('ALLOWED_USER=111\n');
    expect(env).toContain('OTHER_KEY=keep');
    expect(env).not.toContain(SUPPORT_ACCESS_ID);
    expect(existsSync(join(daemonStateRoot(), 'state', 'alice', 'support-access.jsonl'))).toBe(false);
  });

  it('records a missing grant when support access is already present in ALLOWED_USER', async () => {
    writeFileSync(envPath, `ALLOWED_USER=111,${SUPPORT_ACCESS_ID}\n`);

    await runSupportAccess(['support-access', 'enable', '--agent', 'alice', '--org', 'acme']);
    await runSupportAccess(['support-access', 'enable', '--agent', 'alice', '--org', 'acme']);

    const events = readFileSync(join(daemonStateRoot(), 'state', 'alice', 'support-access.jsonl'), 'utf-8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(logs.join('\n')).toContain('Support access was already enabled.');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      agent: 'alice',
      action: 'grant',
      supportId: SUPPORT_ACCESS_ID,
    });
  });

  it('canonicalizes an already-enabled loose ALLOWED_USER line for the daemon parser', async () => {
    writeFileSync(envPath, ` ALLOWED_USER = 111,${SUPPORT_ACCESS_ID}\nOTHER_KEY=keep\n`);

    await runSupportAccess(['support-access', 'enable', '--agent', 'alice', '--org', 'acme']);

    const env = readFileSync(envPath, 'utf-8');
    expect(env).toContain(`ALLOWED_USER=111,${SUPPORT_ACCESS_ID}`);
    expect(env).toContain('OTHER_KEY=keep');
    expect(env).not.toContain(' ALLOWED_USER =');
    const events = readFileSync(join(daemonStateRoot(), 'state', 'alice', 'support-access.jsonl'), 'utf-8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(events.map((event) => event.action)).toEqual(['grant']);
  });

  it('rolls back already-enabled canonicalization when audit history cannot be read', () => {
    const original = ` ALLOWED_USER = 111,${SUPPORT_ACCESS_ID}\nOTHER_KEY=keep\n`;
    writeFileSync(envPath, original);
    const blockedRoot = join(testDir, 'blocked-read-root');
    writeFileSync(blockedRoot, 'not a directory');

    const result = addSupportAccess(envPath, blockedRoot);

    expect(result).toMatchObject({
      ok: false,
      changed: false,
      reason: 'Cannot read support-access audit history; refusing to enable without audit history',
    });
    const env = readFileSync(envPath, 'utf-8');
    expect(env).toContain(' ALLOWED_USER =');
    expect(env).not.toContain(`ALLOWED_USER=111,${SUPPORT_ACCESS_ID}`);
    expect(existsSync(join(blockedRoot, 'state', 'alice', 'support-access.jsonl'))).toBe(false);
  });

  it('co-locates CLI grant and daemon confirmed-live in the daemon state root', async () => {
    process.env.CTX_ROOT = join(testDir, 'wrong-parent-root');
    writeFileSync(envPath, 'BOT_TOKEN=123456:ABC_def-123\nALLOWED_USER=111\n');
    const sendMessage = vi.fn(async () => undefined);

    await runSupportAccess(['support-access', 'enable', '--agent', 'alice', '--org', 'acme']);
    await expect(confirmSupportAccessOnFirstContact({
      agentEnvPath: envPath,
      ctxRoot: daemonStateRoot(),
      api: { sendMessage },
      fromId: Number(SUPPORT_ACCESS_ID),
    })).resolves.toBe(true);

    const unifiedPath = join(daemonStateRoot(), 'state', 'alice', 'support-access.jsonl');
    const events = readFileSync(unifiedPath, 'utf-8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));

    expect(sendMessage).toHaveBeenCalledWith(SUPPORT_ACCESS_ID, SUPPORT_ACCESS_CONFIRMATION, undefined, { parseMode: null });
    expect(events.map((event) => event.action)).toEqual(['grant', 'confirmed-live']);
    expect(existsSync(join(testDir, 'wrong-parent-root', 'state', 'alice', 'support-access.jsonl'))).toBe(false);
    expect(existsSync(join(testDir, 'state', 'alice', 'support-access.jsonl'))).toBe(false);
  });

  it('uses the core env parser for loosely formatted BOT_TOKEN when printing the share handle', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      json: async () => ({ ok: true, result: { username: 'loose_bot' } }),
    })));
    writeFileSync(envPath, ' BOT_TOKEN = 123456:ABC_def-123\nALLOWED_USER=111\n');

    await runSupportAccess(['support-access', 'enable', '--agent', 'alice', '--org', 'acme']);

    expect(logs.join('\n')).toContain('@loose_bot');
    expect(logs.join('\n')).not.toContain('<agent bot handle>');
  });

  it('disable removes only support ID and status reflects disabled', async () => {
    writeFileSync(envPath, `ALLOWED_USER=111,${SUPPORT_ACCESS_ID},222\n`);

    await runSupportAccess(['support-access', 'disable', '--agent', 'alice', '--org', 'acme']);
    await runSupportAccess(['support-access', 'status', '--agent', 'alice', '--org', 'acme']);

    const env = readFileSync(envPath, 'utf-8');
    expect(env).toContain('ALLOWED_USER=111,222');
    expect(env).not.toContain(SUPPORT_ACCESS_ID);
    expect(logs.join('\n')).toContain('Support access disabled.');
    expect(logs.join('\n')).toContain('Support access: disabled');
  });

  it('rolls back disable when the audit revoke cannot be recorded', () => {
    const original = `ALLOWED_USER=111,${SUPPORT_ACCESS_ID},222\nOTHER_KEY=keep\n`;
    writeFileSync(envPath, original);
    const blockedRoot = join(testDir, 'blocked-revoke-root');
    writeFileSync(blockedRoot, 'not a directory');

    const result = removeSupportAccess(envPath, blockedRoot);

    expect(result).toMatchObject({
      ok: false,
      changed: false,
      reason: 'Cannot record support-access audit revoke; refusing to disable without audit history',
    });
    const env = readFileSync(envPath, 'utf-8');
    expect(env).toContain(`ALLOWED_USER=111,${SUPPORT_ACCESS_ID},222`);
    expect(env).toContain('OTHER_KEY=keep');
    expect(existsSync(join(blockedRoot, 'state', 'alice', 'support-access.jsonl'))).toBe(false);
  });

  it.skipIf(isWindows)('does not record a revoke when .env removal cannot be written', () => {
    writeFileSync(envPath, `ALLOWED_USER=111,${SUPPORT_ACCESS_ID},222\nOTHER_KEY=keep\n`);
    const agentDir = dirname(envPath);
    chmodSync(agentDir, 0o500);

    try {
      const result = removeSupportAccess(envPath, daemonStateRoot());

      expect(result).toMatchObject({
        ok: false,
        changed: false,
        reason: 'Cannot write support-access removal; refusing to record audit revoke',
      });
    } finally {
      chmodSync(agentDir, 0o700);
    }

    const env = readFileSync(envPath, 'utf-8');
    expect(env).toContain(`ALLOWED_USER=111,${SUPPORT_ACCESS_ID},222`);
    expect(env).toContain('OTHER_KEY=keep');
    expect(existsSync(join(daemonStateRoot(), 'state', 'alice', 'support-access.jsonl'))).toBe(false);
  });

  it('refuses malformed ALLOWED_USER without writing', async () => {
    const original = 'ALLOWED_USER=111,bad\n';
    writeFileSync(envPath, original);

    await runSupportAccess(['support-access', 'enable', '--agent', 'alice', '--org', 'acme']);

    expect(readFileSync(envPath, 'utf-8')).toBe(original);
    expect(process.exitCode).toBe(1);
    expect(errors.join('\n')).toContain('Support access not enabled');
  });
});
