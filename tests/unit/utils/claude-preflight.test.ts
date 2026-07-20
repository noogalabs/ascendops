import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'fs';
import { dirname, join } from 'path';
import { tmpdir } from 'os';
import { describe, expect, it, vi } from 'vitest';

import {
  applyUnattendedConsent,
  ensureBypassPromptSuppressed,
  ensureFolderTrusted,
  isDurableUnattendedConsentSource,
  readUnattendedConsent,
  readUnattendedConsentState,
  recordUnattendedConsent,
  unattendedConsentPath,
} from '../../../src/utils/claude-preflight.js';

describe('Claude preflight', () => {
  it.each([
    'interactive-installer',
    'scripted-installer-opt-in',
    'scripted-installer-opt-out',
    'consent-command',
  ])('classifies %s as a durable decision source', (source) => {
    expect(isDurableUnattendedConsentSource(source)).toBe(true);
  });

  it.each(['non-interactive-default', 'installer', 'unknown'])
    ('does not classify %s as a durable decision source', (source) => {
      expect(isDurableUnattendedConsentSource(source)).toBe(false);
    });

  it.each([false, true])('records and reads unattended consent = %s', (unattended) => {
    const installDir = mkdtempSync(join(tmpdir(), 'claude-consent-'));

    expect(recordUnattendedConsent(installDir, unattended, { source: 'unit-test' })).toBe(true);
    expect(readUnattendedConsent(installDir)).toBe(unattended);
    expect(readUnattendedConsentState(installDir)).toEqual({
      state: 'valid',
      value: unattended,
      source: 'unit-test',
      decidedAt: expect.any(String),
    });
    expect(unattendedConsentPath(installDir)).toBe(join(installDir, '.claude-consent.json'));
    expect(JSON.parse(readFileSync(unattendedConsentPath(installDir), 'utf8'))).toMatchObject({
      unattended_bypass: unattended,
      source: 'unit-test',
    });
  });

  it('uses the legacy default only for a proven-missing consent record', () => {
    const installDir = mkdtempSync(join(tmpdir(), 'claude-consent-'));
    const log = vi.fn();

    expect(readUnattendedConsent(installDir, { log })).toBeUndefined();
    expect(readUnattendedConsentState(installDir, { log })).toEqual({ state: 'absent' });
    expect(log).toHaveBeenCalledWith(expect.stringContaining('using legacy default'));
  });

  it('fails closed and logs at error level for a corrupt consent record', () => {
    const installDir = mkdtempSync(join(tmpdir(), 'claude-consent-'));
    const log = vi.fn();
    const error = vi.fn();

    writeFileSync(unattendedConsentPath(installDir), '{broken');
    expect(readUnattendedConsent(installDir, { log, error })).toBe(false);
    expect(readUnattendedConsentState(installDir, { log, error })).toEqual({ state: 'lost' });
    expect(log).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(expect.stringContaining('lost consent'));
  });

  it.each([
    ['existence check failure', { exists: () => { throw new Error('stat denied'); } }],
    ['read failure', { exists: () => true, read: () => { throw new Error('read denied'); } }],
    ['wrong shape', { exists: () => true, read: () => '{"unattended_bypass":"yes"}' }],
    ['missing source', { exists: () => true, read: () => '{"unattended_bypass":true}' }],
  ])('fails closed on %s', (_label, io) => {
    const installDir = mkdtempSync(join(tmpdir(), 'claude-consent-'));
    const error = vi.fn();

    expect(readUnattendedConsent(installDir, { ...io, error })).toBe(false);
    expect(error).toHaveBeenCalledWith(expect.stringContaining('lost consent'));
  });

  it('applies Yes by recording consent and configuring both Claude files', () => {
    const installDir = mkdtempSync(join(tmpdir(), 'claude-consent-'));
    const homeDir = mkdtempSync(join(tmpdir(), 'claude-home-'));

    expect(applyUnattendedConsent(true, installDir, { homeDir, source: 'interactive-installer' }))
      .toEqual({ ok: true, recorded: true, folderReady: true, bypassReady: true });
    expect(readUnattendedConsent(installDir)).toBe(true);
    expect(JSON.parse(readFileSync(join(homeDir, '.claude.json'), 'utf8')))
      .toMatchObject({ projects: { [installDir]: { hasTrustDialogAccepted: true } } });
    expect(JSON.parse(readFileSync(join(homeDir, '.claude', 'settings.json'), 'utf8')))
      .toMatchObject({ skipDangerousModePermissionPrompt: true });
  });

  it('applies No by recording only and never touching Claude config', () => {
    const installDir = mkdtempSync(join(tmpdir(), 'claude-consent-'));
    const homeDir = mkdtempSync(join(tmpdir(), 'claude-home-'));

    expect(applyUnattendedConsent(false, installDir, { homeDir, source: 'interactive-installer' }))
      .toEqual({ ok: true, recorded: true });
    expect(readUnattendedConsent(installDir)).toBe(false);
    expect(() => readFileSync(join(homeDir, '.claude.json'), 'utf8')).toThrow();
    expect(() => readFileSync(join(homeDir, '.claude', 'settings.json'), 'utf8')).toThrow();
  });

  it('returns false and logs when consent persistence fails', () => {
    const installDir = mkdtempSync(join(tmpdir(), 'claude-consent-'));
    const log = vi.fn();
    const write = vi.fn(() => { throw new Error('consent disk full'); });

    expect(applyUnattendedConsent(false, installDir, { log, write }))
      .toEqual({ ok: false, recorded: false });
    expect(log).toHaveBeenCalledWith(expect.stringContaining('consent disk full'));
  });

  it('does not record a grant when bypass suppression fails', () => {
    const installDir = mkdtempSync(join(tmpdir(), 'claude-consent-'));
    const homeDir = mkdtempSync(join(tmpdir(), 'claude-home-'));
    const settingsPath = join(homeDir, '.claude', 'settings.json');
    const write = (filePath: string, data: string) => {
      if (filePath === settingsPath) throw new Error('settings write failed');
      mkdirSync(dirname(filePath), { recursive: true });
      writeFileSync(filePath, data);
    };

    expect(applyUnattendedConsent(true, installDir, { homeDir, write, source: 'consent-command' }))
      .toEqual({ ok: false, recorded: false, folderReady: true, bypassReady: false });
    expect(existsSync(unattendedConsentPath(installDir))).toBe(false);
  });

  it('does not record a grant when folder trust fails', () => {
    const installDir = mkdtempSync(join(tmpdir(), 'claude-consent-'));
    const homeDir = mkdtempSync(join(tmpdir(), 'claude-home-'));
    const trustPath = join(homeDir, '.claude.json');
    const write = (filePath: string, data: string) => {
      if (filePath === trustPath) throw new Error('trust write failed');
      mkdirSync(dirname(filePath), { recursive: true });
      writeFileSync(filePath, data);
    };

    expect(applyUnattendedConsent(true, installDir, { homeDir, write, source: 'consent-command' }))
      .toEqual({ ok: false, recorded: false, folderReady: false, bypassReady: true });
    expect(existsSync(unattendedConsentPath(installDir))).toBe(false);
  });

  it('preserves a prior consent record when grant preflight fails', () => {
    const installDir = mkdtempSync(join(tmpdir(), 'claude-consent-'));
    const homeDir = mkdtempSync(join(tmpdir(), 'claude-home-'));
    const settingsPath = join(homeDir, '.claude', 'settings.json');
    recordUnattendedConsent(installDir, false, { source: 'consent-command' });
    const before = readFileSync(unattendedConsentPath(installDir), 'utf8');
    const write = (filePath: string, data: string) => {
      if (filePath === settingsPath) throw new Error('settings write failed');
      mkdirSync(dirname(filePath), { recursive: true });
      writeFileSync(filePath, data);
    };

    expect(applyUnattendedConsent(true, installDir, { homeDir, write, source: 'consent-command' }))
      .toEqual({ ok: false, recorded: false, folderReady: true, bypassReady: false });
    expect(readFileSync(unattendedConsentPath(installDir), 'utf8')).toBe(before);
    expect(readUnattendedConsent(installDir)).toBe(false);
  });

  it('writes folder trust, bypass suppression, then the consent record', () => {
    const installDir = mkdtempSync(join(tmpdir(), 'claude-consent-'));
    const homeDir = mkdtempSync(join(tmpdir(), 'claude-home-'));
    const writes: string[] = [];
    const write = (filePath: string, data: string) => {
      writes.push(filePath);
      mkdirSync(dirname(filePath), { recursive: true });
      writeFileSync(filePath, data);
    };

    expect(applyUnattendedConsent(true, installDir, { homeDir, write, source: 'consent-command' }))
      .toEqual({ ok: true, recorded: true, folderReady: true, bypassReady: true });
    expect(writes).toEqual([
      join(homeDir, '.claude.json'),
      join(homeDir, '.claude', 'settings.json'),
      unattendedConsentPath(installDir),
    ]);
  });

  it('reports prepared safety state without changing the prior record when recording fails', () => {
    const installDir = mkdtempSync(join(tmpdir(), 'claude-consent-'));
    const homeDir = mkdtempSync(join(tmpdir(), 'claude-home-'));
    recordUnattendedConsent(installDir, false, { source: 'consent-command' });
    const before = readFileSync(unattendedConsentPath(installDir), 'utf8');
    const write = (filePath: string, data: string) => {
      if (filePath === unattendedConsentPath(installDir)) throw new Error('record write failed');
      mkdirSync(dirname(filePath), { recursive: true });
      writeFileSync(filePath, data);
    };

    expect(applyUnattendedConsent(true, installDir, { homeDir, write, source: 'consent-command' }))
      .toEqual({ ok: false, recorded: false, folderReady: true, bypassReady: true });
    expect(readFileSync(unattendedConsentPath(installDir), 'utf8')).toBe(before);
  });

  it('records a revoke without invoking either safety preflight writer', () => {
    const installDir = mkdtempSync(join(tmpdir(), 'claude-consent-'));
    const homeDir = mkdtempSync(join(tmpdir(), 'claude-home-'));
    const writes: string[] = [];
    const write = (filePath: string, data: string) => {
      writes.push(filePath);
      writeFileSync(filePath, data);
    };

    expect(applyUnattendedConsent(false, installDir, { homeDir, write, source: 'consent-command' }))
      .toEqual({ ok: true, recorded: true });
    expect(writes).toEqual([unattendedConsentPath(installDir)]);
    expect(existsSync(join(homeDir, '.claude.json'))).toBe(false);
    expect(existsSync(join(homeDir, '.claude', 'settings.json'))).toBe(false);
  });

  it('initializes an absent record from the non-interactive default', () => {
    const installDir = mkdtempSync(join(tmpdir(), 'claude-consent-'));
    const decidedAt = new Date('2026-07-19T04:00:00.000Z');

    expect(applyUnattendedConsent(false, installDir, {
      source: 'non-interactive-default',
      now: () => decidedAt,
    })).toEqual({ ok: true, recorded: true });
    expect(readUnattendedConsentState(installDir)).toEqual({
      state: 'valid',
      value: false,
      source: 'non-interactive-default',
      decidedAt: decidedAt.toISOString(),
    });
  });

  it.each([
    ['grant', true, 'consent-command'],
    ['opt-out', false, 'scripted-installer-opt-out'],
  ])('preserves an existing valid %s byte-for-byte on a non-interactive default', (
    _label,
    value,
    source,
  ) => {
    const installDir = mkdtempSync(join(tmpdir(), 'claude-consent-'));
    const decidedAt = new Date('2026-07-19T04:01:00.000Z');
    recordUnattendedConsent(installDir, value, { source, now: () => decidedAt });
    const before = readFileSync(unattendedConsentPath(installDir), 'utf8');
    const write = vi.fn();

    expect(applyUnattendedConsent(false, installDir, {
      source: 'non-interactive-default',
      write,
    })).toEqual({
      ok: true,
      recorded: false,
      preserved: true,
      existingValue: value,
      existingSource: source,
      existingDecidedAt: decidedAt.toISOString(),
    });
    expect(write).not.toHaveBeenCalled();
    expect(readFileSync(unattendedConsentPath(installDir), 'utf8')).toBe(before);
  });

  it('preserves a lost record, warns with repair commands, and remains fail-closed', () => {
    const installDir = mkdtempSync(join(tmpdir(), 'claude-consent-'));
    const filePath = unattendedConsentPath(installDir);
    writeFileSync(filePath, '{broken');
    const before = readFileSync(filePath, 'utf8');
    const log = vi.fn();
    const error = vi.fn();
    const write = vi.fn();

    expect(applyUnattendedConsent(false, installDir, {
      source: 'non-interactive-default',
      log,
      error,
      write,
    })).toEqual({
      ok: true,
      recorded: false,
      preserved: false,
      existingState: 'lost',
    });
    expect(write).not.toHaveBeenCalled();
    expect(readFileSync(filePath, 'utf8')).toBe(before);
    expect(readUnattendedConsent(installDir, { error: vi.fn() })).toBe(false);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('installer/consent-gate.mjs --grant'));
    expect(log).toHaveBeenCalledWith(expect.stringContaining('--revoke'));
  });

  it.each([
    ['scripted opt-out', 'scripted-installer-opt-out'],
    ['consent command revoke', 'consent-command'],
  ])('allows a genuine %s to replace an existing grant', (_label, source) => {
    const installDir = mkdtempSync(join(tmpdir(), 'claude-consent-'));
    recordUnattendedConsent(installDir, true, { source: 'consent-command' });

    expect(applyUnattendedConsent(false, installDir, { source }))
      .toEqual({ ok: true, recorded: true });
    expect(readUnattendedConsentState(installDir)).toMatchObject({
      state: 'valid',
      value: false,
      source,
    });
  });

  it('refuses a non-genuine grant without reading or writing state', () => {
    const installDir = mkdtempSync(join(tmpdir(), 'claude-consent-'));
    const homeDir = mkdtempSync(join(tmpdir(), 'claude-home-'));
    const exists = vi.fn();
    const write = vi.fn();

    expect(applyUnattendedConsent(true, installDir, {
      source: 'non-interactive-default',
      homeDir,
      exists,
      write,
    })).toEqual({ ok: false, recorded: false });
    expect(exists).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
    expect(existsSync(join(homeDir, '.claude.json'))).toBe(false);
    expect(existsSync(join(homeDir, '.claude', 'settings.json'))).toBe(false);
  });

  it('currently fabricates both absent Claude files without logging', () => {
    const homeDir = mkdtempSync(join(tmpdir(), 'claude-preflight-'));
    const log = vi.fn();

    // TODO boundary-phase: absent/unparseable/husk must fail loud, refuse spawn,
    // and preserve the damaged file instead of fabricating a replacement.
    expect(ensureFolderTrusted('/workspace/new-agent', { homeDir, log })).toBe(true);
    expect(ensureBypassPromptSuppressed({ homeDir, log })).toBe(true);

    expect(JSON.parse(readFileSync(join(homeDir, '.claude.json'), 'utf8')))
      .toMatchObject({ projects: { '/workspace/new-agent': { hasTrustDialogAccepted: true } } });
    expect(JSON.parse(readFileSync(join(homeDir, '.claude', 'settings.json'), 'utf8')))
      .toMatchObject({ skipDangerousModePermissionPrompt: true });
    expect(log).not.toHaveBeenCalled();
  });

  it('creates or merges folder trust while preserving unrelated values and is idempotent', () => {
    const homeDir = mkdtempSync(join(tmpdir(), 'claude-preflight-'));
    const configPath = join(homeDir, '.claude.json');
    const original = {
      theme: 'dark',
      literal: 'KEEP:  a  b',
      projects: { '/existing': { model: 'sonnet', custom: { enabled: true } } },
    };
    writeFileSync(configPath, JSON.stringify(original, null, 2) + '\n');

    const write = vi.fn((filePath: string, data: string) => writeFileSync(filePath, data));
    ensureFolderTrusted('/workspace/new-agent', { homeDir, write });

    const firstWrite = readFileSync(configPath, 'utf8');
    const parsed = JSON.parse(firstWrite);
    expect(parsed.theme).toBe(original.theme);
    expect(parsed.literal).toBe(original.literal);
    expect(parsed.projects['/existing']).toEqual(original.projects['/existing']);
    expect(parsed.projects['/workspace/new-agent'].hasTrustDialogAccepted).toBe(true);
    expect(firstWrite).toContain('"literal": "KEEP:  a  b"');
    expect(write).toHaveBeenCalledTimes(1);

    const fixedTime = new Date('2026-07-19T00:00:00.000Z');
    utimesSync(configPath, fixedTime, fixedTime);
    const mtimeBefore = statSync(configPath).mtimeMs;
    ensureFolderTrusted('/workspace/new-agent', { homeDir });
    expect(statSync(configPath).mtimeMs).toBe(mtimeBefore);
    expect(readFileSync(configPath, 'utf8')).toBe(firstWrite);
  });

  it('creates or merges bypass suppression while preserving unrelated settings and is idempotent', () => {
    const homeDir = mkdtempSync(join(tmpdir(), 'claude-preflight-'));
    const claudeDir = join(homeDir, '.claude');
    mkdirSync(claudeDir, { recursive: true });
    const settingsPath = join(claudeDir, 'settings.json');
    const original = Object.fromEntries(
      Array.from({ length: 34 }, (_, index) => [`preservedKey${index + 1}`, `value-${index + 1}`]),
    ) as Record<string, unknown>;
    original.model = 'opus';
    original.permissions = { allow: ['Read'] };
    original.literal = 'KEEP:  x  y';
    expect(Object.keys(original)).toHaveLength(37);
    writeFileSync(settingsPath, JSON.stringify(original, null, 2) + '\n');

    const write = vi.fn((filePath: string, data: string) => writeFileSync(filePath, data));
    ensureBypassPromptSuppressed({ homeDir, write });

    const firstWrite = readFileSync(settingsPath, 'utf8');
    const parsed = JSON.parse(firstWrite);
    for (const [key, value] of Object.entries(original)) {
      expect(parsed[key]).toEqual(value);
    }
    expect(parsed.skipDangerousModePermissionPrompt).toBe(true);
    expect(firstWrite).toContain('"literal": "KEEP:  x  y"');
    expect(write).toHaveBeenCalledTimes(1);

    const fixedTime = new Date('2026-07-19T00:00:00.000Z');
    utimesSync(settingsPath, fixedTime, fixedTime);
    const mtimeBefore = statSync(settingsPath).mtimeMs;
    ensureBypassPromptSuppressed({ homeDir });
    expect(statSync(settingsPath).mtimeMs).toBe(mtimeBefore);
    expect(readFileSync(settingsPath, 'utf8')).toBe(firstWrite);
  });

  it('swallows and logs atomic-write failures for both preflight files', () => {
    const homeDir = mkdtempSync(join(tmpdir(), 'claude-preflight-'));
    const log = vi.fn();
    const write = vi.fn(() => { throw new Error('simulated disk failure'); });

    expect(() => ensureFolderTrusted('/workspace/agent', { homeDir, log, write })).not.toThrow();
    expect(() => ensureBypassPromptSuppressed({ homeDir, log, write })).not.toThrow();

    expect(write).toHaveBeenCalledTimes(2);
    expect(log).toHaveBeenCalledTimes(2);
    expect(log.mock.calls.map((call) => String(call[0])).join('\n')).toContain('simulated disk failure');
  });

  it('does not overwrite either malformed Claude file and reports both parse failures', () => {
    const homeDir = mkdtempSync(join(tmpdir(), 'claude-preflight-'));
    const configPath = join(homeDir, '.claude.json');
    const settingsPath = join(homeDir, '.claude', 'settings.json');
    mkdirSync(dirname(settingsPath), { recursive: true });
    writeFileSync(configPath, '{not-json\n');
    writeFileSync(settingsPath, '{also-not-json\n');
    const log = vi.fn();

    expect(ensureFolderTrusted('/workspace/agent', { homeDir, log })).toBe(false);
    expect(ensureBypassPromptSuppressed({ homeDir, log })).toBe(false);

    expect(readFileSync(configPath, 'utf8')).toBe('{not-json\n');
    expect(readFileSync(settingsPath, 'utf8')).toBe('{also-not-json\n');
    expect(log).toHaveBeenCalledTimes(2);
  });
});
