import { existsSync, mkdtempSync, rmSync, unlinkSync, utimesSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, it } from 'vitest';

import {
  assertFilesUnchanged,
  captureFileSnapshot,
} from './sandbox-home.global.js';

describe('suite-wide Claude config sandbox', () => {
  it('runs before tests and isolates every Claude home variable', () => {
    const sandboxHome = process.env.CORTEXTOS_TEST_SANDBOX_HOME;
    expect(sandboxHome).toBeTruthy();
    expect(process.env.HOME).toBe(sandboxHome);
    expect(process.env.USERPROFILE).toBe(sandboxHome);
    expect(process.env.CLAUDE_CONFIG_DIR).toBe(join(sandboxHome!, '.claude'));
    expect(existsSync(join(sandboxHome!, '.vitest-sandbox-active'))).toBe(true);
  });

  it('fails the canary on content replacement even when file metadata is stable', () => {
    const root = mkdtempSync(join(tmpdir(), 'claude-canary-change-'));
    const filePath = join(root, '.claude.json');
    const fixedTime = new Date('2026-07-19T00:00:00.000Z');
    writeFileSync(filePath, '{"value":"one"}\n');
    utimesSync(filePath, fixedTime, fixedTime);
    const before = [captureFileSnapshot(filePath)];
    writeFileSync(filePath, '{"value":"two"}\n');
    utimesSync(filePath, fixedTime, fixedTime);
    const after = [captureFileSnapshot(filePath)];

    expect(after[0]).toMatchObject({
      mtimeMs: before[0].mtimeMs,
      size: before[0].size,
      ino: before[0].ino,
    });
    expect(after[0].sha256).not.toBe(before[0].sha256);
    expect(() => assertFilesUnchanged(before, after)).toThrow(/real Claude config changed/);
    rmSync(root, { recursive: true, force: true });
  });

  it('fails the canary when a protected file disappears', () => {
    const root = mkdtempSync(join(tmpdir(), 'claude-canary-absence-'));
    const filePath = join(root, 'settings.json');
    writeFileSync(filePath, '{"present":true}\n');
    const before = [captureFileSnapshot(filePath)];
    unlinkSync(filePath);
    const after = [captureFileSnapshot(filePath)];

    expect(() => assertFilesUnchanged(before, after)).toThrow(/real Claude config changed/);
    rmSync(root, { recursive: true, force: true });
  });
});
