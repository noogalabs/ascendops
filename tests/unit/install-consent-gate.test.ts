import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { spawnSync, type SpawnSyncOptionsWithStringEncoding } from 'child_process';
import { describe, expect, it, vi } from 'vitest';
import {
  installerConsentOutcome,
  requireConsentGateFile,
  resolveInstallerConsent,
  runConsentCommand,
  runConsentGate,
} from '../../installer/consent-gate.mjs';

const REAL_SUBPROCESS_DEADLINE_MS = 30_000;
const REAL_SUBPROCESS_KILL_SIGNAL = 'SIGKILL' as const;

// Vitest's timeout cannot interrupt spawnSync because the call blocks the JS
// thread. Bound the child itself instead. This is the correctness mechanism in
// both CI and local runs; the workflow-level watchdog is a separate backstop.
function runRealSubprocess(
  command: string,
  args: string[],
  options: Omit<SpawnSyncOptionsWithStringEncoding, 'timeout' | 'killSignal'>,
  deadlineMs = REAL_SUBPROCESS_DEADLINE_MS,
) {
  return spawnSync(command, args, {
    ...options,
    timeout: deadlineMs,
    killSignal: REAL_SUBPROCESS_KILL_SIGNAL,
  });
}

describe('real subprocess timeout policy', () => {
  it('kills a wedged installer subprocess at the child deadline', () => {
    const root = mkdtempSync(join(tmpdir(), 'wedged-installer-'));
    const fakeInstaller = join(root, 'install.mjs');
    const startedMarker = join(root, 'installer-started');
    writeFileSync(
      fakeInstaller,
      `import fs from 'fs'; fs.writeFileSync(${JSON.stringify(startedMarker)}, 'started'); setInterval(() => {}, 1000);\n`,
    );

    const result = runRealSubprocess(
      process.execPath,
      [fakeInstaller],
      { encoding: 'utf8' },
      200,
    );

    expect(existsSync(startedMarker)).toBe(true); // precondition: the fake installer reached its deliberate wedge
    expect(result.signal).toBe('SIGKILL');
    expect(result.error).toMatchObject({ code: 'ETIMEDOUT' });
  });
});

describe('installer unattended consent gate', () => {
  it('uses a controlling TTY when installer stdin is piped', async () => {
    const promptTty = vi.fn(async () => true);

    await expect(resolveInstallerConsent({
      envValue: undefined,
      stdinIsTTY: false,
      stdoutIsTTY: true,
      platform: 'darwin',
      promptTty,
      reportDefault: vi.fn(),
    })).resolves.toEqual({ answerYes: true, source: 'interactive-installer' });
    expect(promptTty).toHaveBeenCalledTimes(1);
  });

  it('fails closed with a loud grant notice when no controlling TTY exists', async () => {
    const reportDefault = vi.fn();

    await expect(resolveInstallerConsent({
      envValue: undefined,
      stdinIsTTY: false,
      stdoutIsTTY: false,
      platform: 'linux',
      promptTty: vi.fn(async () => { throw new Error('no tty'); }),
      reportDefault,
    })).resolves.toEqual({ answerYes: false, source: 'non-interactive-default' });
    expect(reportDefault).toHaveBeenCalledWith(expect.stringContaining('--grant'));
  });

  it.each([
    ['1', true, 'scripted-installer-opt-in'],
    ['0', false, 'scripted-installer-opt-out'],
  ])('honors scripted ASCENDOPS_UNATTENDED=%s', async (envValue, answerYes, source) => {
    await expect(resolveInstallerConsent({
      envValue,
      stdinIsTTY: false,
      stdoutIsTTY: false,
      platform: 'linux',
      promptTty: vi.fn(),
      reportDefault: vi.fn(),
    })).resolves.toEqual({ answerYes, source });
  });

  it('grant command records consent and applies Claude preflight', async () => {
    const installDir = mkdtempSync(join(tmpdir(), 'consent-command-'));
    const homeDir = mkdtempSync(join(tmpdir(), 'consent-command-home-'));
    const applyUnattendedConsent = vi.fn(async (answerYes, dir, options) => {
      const actual = await import('../../src/utils/claude-preflight.js');
      return actual.applyUnattendedConsent(answerYes, dir, { ...options, homeDir });
    });

    await expect(runConsentCommand(['--grant'], { installDir, applyUnattendedConsent }))
      .resolves.toMatchObject({ ok: true, recorded: true });
    expect(applyUnattendedConsent).toHaveBeenCalledWith(true, installDir, { source: 'consent-command' });
    expect(JSON.parse(readFileSync(join(installDir, '.claude-consent.json'), 'utf8')))
      .toMatchObject({ unattended_bypass: true, source: 'consent-command' });
    expect(JSON.parse(readFileSync(join(homeDir, '.claude', 'settings.json'), 'utf8')))
      .toMatchObject({ skipDangerousModePermissionPrompt: true });
  });

  it('revoke command records a genuine opt-out without applying Claude preflight', async () => {
    const installDir = mkdtempSync(join(tmpdir(), 'consent-command-'));
    const applyUnattendedConsent = vi.fn(async () => ({ ok: true, recorded: true }));

    await expect(runConsentCommand(['--revoke'], { installDir, applyUnattendedConsent }))
      .resolves.toEqual({ ok: true, recorded: true });
    expect(applyUnattendedConsent).toHaveBeenCalledWith(false, installDir, { source: 'consent-command' });
  });

  it.each([
    ['grant preflight failure', ['--grant'], { ok: false, recorded: false, folderReady: false, bypassReady: true }, 'nothing recorded'],
    ['grant record failure', ['--grant'], { ok: false, recorded: false, folderReady: true, bypassReady: true }, 'consent NOT recorded'],
    ['revoke record failure', ['--revoke'], { ok: false, recorded: false }, 'existing grant still stands'],
  ])('reports truthful state for %s', async (_label, args, result, message) => {
    const applyUnattendedConsent = vi.fn(async () => result);

    await expect(runConsentCommand(args, {
      installDir: '/tmp/ascendops',
      applyUnattendedConsent,
    })).rejects.toThrow(message);
  });

  it.each([
    ['--grant', 'Unattended mode granted; consent recorded.'],
    ['--revoke', 'Unattended mode revoked; consent recorded.'],
  ])('prints the exact successful consent-command result for %s', (action, message) => {
    const installDir = mkdtempSync(join(tmpdir(), 'consent-command-cli-'));
    const installerDir = join(installDir, 'installer');
    const distDir = join(installDir, 'dist');
    mkdirSync(installerDir);
    mkdirSync(distDir);
    copyFileSync(join(process.cwd(), 'installer', 'consent-gate.mjs'), join(installerDir, 'consent-gate.mjs'));
    writeFileSync(
      join(distDir, 'claude-preflight.js'),
      'module.exports = { applyUnattendedConsent() { return { ok: true, recorded: true }; } };\n',
    );

    const result = runRealSubprocess(process.execPath, [join(installerDir, 'consent-gate.mjs'), action], {
      encoding: 'utf8',
    });

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(message);
  });

  it.each([
    ['grant then revoke', ['--grant', '--revoke']],
    ['revoke then grant', ['--revoke', '--grant']],
    ['no recognized action', ['--unknown']],
  ])('rejects %s with a nonzero exit and no consent write', (_label, args) => {
    const installDir = mkdtempSync(join(tmpdir(), 'consent-command-cli-'));
    const installerDir = join(installDir, 'installer');
    const distDir = join(installDir, 'dist');
    const writeMarker = join(installDir, 'consent-write');
    mkdirSync(installerDir);
    mkdirSync(distDir);
    copyFileSync(join(process.cwd(), 'installer', 'consent-gate.mjs'), join(installerDir, 'consent-gate.mjs'));
    writeFileSync(
      join(distDir, 'claude-preflight.js'),
      `module.exports = { applyUnattendedConsent() { require('fs').writeFileSync(${JSON.stringify(writeMarker)}, 'called'); return { ok: true, recorded: true }; } };\n`,
    );

    const result = runRealSubprocess(process.execPath, [join(installerDir, 'consent-gate.mjs'), ...args], {
      encoding: 'utf8',
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('exactly one of --grant or --revoke');
    expect(existsSync(writeMarker)).toBe(false);
  });

  it('stops before install work when the required consent gate is absent', () => {
    const installDir = mkdtempSync(join(tmpdir(), 'old-checkout-'));
    const installDependencies = vi.fn();

    expect(() => {
      requireConsentGateFile(installDir);
      installDependencies();
    }).toThrow(/consent-gate\.mjs/);
    expect(installDependencies).not.toHaveBeenCalled();
  });

  it('aborts a stale checkout before npm install when pull fails and the gate is absent', () => {
    const root = mkdtempSync(join(tmpdir(), 'stale-installer-'));
    const installDir = join(root, 'checkout');
    const fakeBin = join(root, 'bin');
    const npmMarker = join(root, 'npm-install-ran');
    const fakeNpmMarker = join(root, 'fake-npm-ran');
    mkdirSync(join(installDir, '.git'), { recursive: true });
    mkdirSync(fakeBin);

    const fake = (name, body) => {
      const file = join(fakeBin, name);
      writeFileSync(file, `#!/bin/sh\n${body}\n`);
      chmodSync(file, 0o755);
    };
    fake('node', 'echo v22.0.0');
    fake('npm', `touch ${JSON.stringify(fakeNpmMarker)}; if [ "$1" = "--version" ]; then echo 10.0.0; else touch ${JSON.stringify(npmMarker)}; fi`);
    fake('git', 'case "$1 $2 $3" in "--version  ") echo "git version 2.50.0";; "remote get-url upstream") echo upstream;; "pull upstream main") exit 1;; *) exit 0;; esac');
    fake('xcode-select', 'echo /Library/Developer/CommandLineTools');
    fake('python3', 'echo Python 3.12.0');
    fake('claude', 'if [ "$1 $2" = "auth status" ]; then echo "{\\"loggedIn\\":true}"; else echo 2.1.212; fi');
    fake('jq', 'echo jq-1.7');
    fake('rtk', 'echo rtk-1');
    fake('icm', 'echo icm-1');
    fake('brew', 'exit 0');

    const installerPath = process.env.ASCENDOPS_INSTALLER_UNDER_TEST ?? join(process.cwd(), 'install.mjs');
    const result = runRealSubprocess(process.execPath, [installerPath], {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: {
        ...process.env,
        ASCENDOPS_DIR: installDir,
        HOME: root,
        PATH: `${fakeBin}:/usr/bin:/bin`,
      },
    });

    expect(existsSync(fakeNpmMarker)).toBe(true); // precondition: the child used fakeBin, not the host toolchain
    expect(existsSync(npmMarker)).toBe(false);
    expect(result.status).toBe(1);
    expect(`${result.stdout}\n${result.stderr}`).toContain('Required installer file is missing');
  });

  it.each([
    ['No', false, 'preflight import failure', vi.fn(async () => { throw new Error('missing bundle'); })],
    ['Yes', true, 'preflight import failure', vi.fn(async () => { throw new Error('missing bundle'); })],
    ['No', false, 'consent apply failure', vi.fn(async () => ({ applyUnattendedConsent: () => ({ ok: false, recorded: false }) }))],
    ['Yes', true, 'consent apply failure', vi.fn(async () => ({ applyUnattendedConsent: () => ({ ok: false, recorded: false, folderReady: false, bypassReady: false }) }))],
  ])('exits before onboarding when %s encounters %s', async (_choice, answerYes, _label, importPreflight) => {
    const spawnOnboarding = vi.fn();
    const exit = vi.fn();
    const reportFailure = vi.fn();

    await runConsentGate({
      answerYes,
      installDir: '/tmp/ascendops',
      source: 'test',
      importPreflight,
      spawnOnboarding,
      exit,
      reportFailure,
    });

    expect(exit).toHaveBeenCalledExactlyOnceWith(1);
    expect(spawnOnboarding).not.toHaveBeenCalled();
    expect(reportFailure).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])('launches onboarding only after persisting %s', async (answerYes) => {
    const spawnOnboarding = vi.fn();
    const exit = vi.fn();

    await expect(runConsentGate({
      answerYes,
      installDir: '/tmp/ascendops',
      source: 'test',
      importPreflight: vi.fn(async () => ({ applyUnattendedConsent: () => ({ ok: true, recorded: true }) })),
      spawnOnboarding,
      exit,
      reportFailure: vi.fn(),
    })).resolves.toEqual({ ok: true, recorded: true });

    expect(exit).not.toHaveBeenCalled();
    expect(spawnOnboarding).toHaveBeenCalledTimes(1);
  });

  it('continues onboarding while preserving a lost record on a headless default', async () => {
    const installDir = mkdtempSync(join(tmpdir(), 'lost-consent-gate-'));
    const consentPath = join(installDir, '.claude-consent.json');
    writeFileSync(consentPath, '{broken');
    const spawnOnboarding = vi.fn();
    const log = vi.fn();
    const error = vi.fn();
    const actual = await import('../../src/utils/claude-preflight.js');

    const result = await runConsentGate({
      answerYes: false,
      installDir,
      source: 'non-interactive-default',
      importPreflight: vi.fn(async () => ({
        applyUnattendedConsent: (answerYes, dir, options) => actual.applyUnattendedConsent(
          answerYes,
          dir,
          { ...options, log, error },
        ),
      })),
      spawnOnboarding,
      exit: vi.fn(),
      reportFailure: vi.fn(),
    });

    expect(result).toEqual({
      ok: true,
      recorded: false,
      preserved: false,
      existingState: 'lost',
    });
    expect(readFileSync(consentPath, 'utf8')).toBe('{broken');
    expect(log).toHaveBeenCalledWith(expect.stringContaining('--grant'));
    expect(spawnOnboarding).toHaveBeenCalledTimes(1);
  });

  it.each([
    [
      'genuine grant',
      true,
      'interactive-installer',
      { ok: true, recorded: true },
      'ok',
      'Claude unattended-mode consent and preflight configured',
    ],
    [
      'genuine opt-out',
      false,
      'scripted-installer-opt-out',
      { ok: true, recorded: true },
      'ok',
      'Recorded unattended-mode opt-out; generated Claude agents will keep permission gates enabled',
    ],
    [
      'fresh default',
      false,
      'non-interactive-default',
      { ok: true, recorded: true },
      'ok',
      'No prior consent found and no interactive terminal was available. Defaulting to attended mode (permission gates on). To enable unattended mode later, run: node installer/consent-gate.mjs --grant',
    ],
    [
      'preserved grant',
      false,
      'non-interactive-default',
      {
        ok: true,
        recorded: false,
        preserved: true,
        existingValue: true,
        existingSource: 'consent-command',
        existingDecidedAt: '2026-07-19T04:01:00.000Z',
      },
      'ok',
      'Existing unattended-mode consent preserved (granted 2026-07-19T04:01:00.000Z, source consent-command); no change.',
    ],
    [
      'preserved opt-out',
      false,
      'non-interactive-default',
      {
        ok: true,
        recorded: false,
        preserved: true,
        existingValue: false,
        existingSource: 'scripted-installer-opt-out',
        existingDecidedAt: '2026-07-19T04:02:00.000Z',
      },
      'ok',
      'Existing unattended-mode opt-out preserved (2026-07-19T04:02:00.000Z, source scripted-installer-opt-out); no change.',
    ],
    [
      'lost record',
      false,
      'non-interactive-default',
      { ok: true, recorded: false, preserved: false, existingState: 'lost' },
      'warn',
      'Consent record at /tmp/ascendops/.claude-consent.json is unreadable. Agents will run with permission gates engaged until it is repaired. To repair, run: node installer/consent-gate.mjs --grant (or --revoke).',
    ],
  ])('reports the exact installer outcome for %s', (
    _label,
    answerYes,
    source,
    result,
    level,
    message,
  ) => {
    expect(installerConsentOutcome({
      answerYes,
      source,
      result,
      installDir: '/tmp/ascendops',
    })).toEqual({ level, message });
    if (result.preserved || result.existingState === 'lost') {
      expect(message).not.toContain('Recorded unattended-mode opt-out');
    }
  });

  it.each([
    ['failed grant preflight', true, { ok: false, recorded: false, folderReady: true, bypassReady: false }, 'nothing recorded'],
    ['failed grant record', true, { ok: false, recorded: false, folderReady: true, bypassReady: true }, 'consent NOT recorded'],
    ['failed revoke record', false, { ok: false, recorded: false }, 'existing grant still stands'],
  ])('aborts onboarding with truthful reporting after %s', async (_label, answerYes, result, message) => {
    const spawnOnboarding = vi.fn();
    const reportFailure = vi.fn();

    await runConsentGate({
      answerYes,
      installDir: '/tmp/ascendops',
      source: 'test',
      importPreflight: vi.fn(async () => ({ applyUnattendedConsent: () => result })),
      spawnOnboarding,
      exit: vi.fn(),
      reportFailure,
    });

    expect(spawnOnboarding).not.toHaveBeenCalled();
    expect(reportFailure).toHaveBeenCalledWith(expect.stringContaining(message));
  });
});
