import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const isWindows = process.platform === 'win32';
import * as fs from 'fs';
import {
  mkdtempSync,
  rmSync,
  readdirSync,
  statSync,
  lstatSync,
  readFileSync,
  writeFileSync,
  symlinkSync,
  realpathSync,
  existsSync,
} from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { atomicWriteSync, ensureDir } from '../../../src/utils/atomic';

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return { ...actual };
});

describe('atomic utilities', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'cortextos-atomic-test-'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(testDir, { recursive: true, force: true });
  });

  it('atomicWriteSync writes data plus newline to target path', () => {
    const targetPath = join(testDir, 'output.txt');

    atomicWriteSync(targetPath, 'hello world');

    expect(readFileSync(targetPath, 'utf-8')).toBe('hello world\n');
  });

  it('atomicWriteSync leaves no temp files behind after success', () => {
    const targetPath = join(testDir, 'result.json');

    atomicWriteSync(targetPath, '{"ok":true}');

    const files = readdirSync(testDir);
    expect(files).toContain('result.json');
    expect(files.filter(file => file.startsWith('.tmp.'))).toEqual([]);
  });

  it('atomicWriteSync creates missing parent directories', () => {
    const targetPath = join(testDir, 'deep', 'nested', 'dir', 'file.txt');

    atomicWriteSync(targetPath, 'created');

    expect(readFileSync(targetPath, 'utf-8')).toBe('created\n');
  });

  it.skipIf(isWindows)('atomicWriteSync sets file mode to 0o600', () => {
    const targetPath = join(testDir, 'secure.txt');

    atomicWriteSync(targetPath, 'secret');

    expect(statSync(targetPath).mode & 0o777).toBe(0o600);
  });

  it('atomicWriteSync cleans up temp file on write failure', () => {
    const targetPath = join(testDir, 'broken.txt');
    const realWriteFileSync = fs.writeFileSync;

    vi.spyOn(fs, 'writeFileSync').mockImplementation(((path, data, options) => {
      if (String(path).includes('.tmp.')) {
        throw new Error('simulated temp write failure');
      }
      return realWriteFileSync(path, data, options as Parameters<typeof fs.writeFileSync>[2]);
    }) as typeof fs.writeFileSync);

    expect(() => atomicWriteSync(targetPath, 'nope')).toThrow('simulated temp write failure');
    expect(existsSync(targetPath)).toBe(false);
    expect(readdirSync(testDir).filter(file => file.startsWith('.tmp.'))).toEqual([]);
  });

  it.skipIf(isWindows)('atomicWriteSync follows a symlink and updates the shared target', () => {
    const sharedDir = join(testDir, 'shared');
    const linkDir = join(testDir, 'agent');
    ensureDir(sharedDir);
    ensureDir(linkDir);

    const realTarget = join(sharedDir, 'CLAUDE.md');
    writeFileSync(realTarget, 'old shared content\n', 'utf-8');

    const linkPath = join(linkDir, 'CLAUDE.md');
    symlinkSync(realTarget, linkPath);

    atomicWriteSync(linkPath, 'new shared content');

    // The link itself is STILL a symlink (not replaced by a regular file).
    expect(lstatSync(linkPath).isSymbolicLink()).toBe(true);
    // The link still resolves to the same real target.
    expect(realpathSync(linkPath)).toBe(realpathSync(realTarget));
    // Both the link's realpath and the real target carry the new content.
    expect(readFileSync(realpathSync(linkPath), 'utf-8')).toBe('new shared content\n');
    expect(readFileSync(realTarget, 'utf-8')).toBe('new shared content\n');
    // No partial temp left in the real target's dir.
    expect(readdirSync(sharedDir).filter((f) => f.startsWith('.tmp.'))).toEqual([]);
  });

  it('atomicWriteSync overwrites a regular existing file, staying a regular file', () => {
    const targetPath = join(testDir, 'config.json');
    writeFileSync(targetPath, '{"old":true}\n', 'utf-8');

    atomicWriteSync(targetPath, '{"new":true}');

    expect(lstatSync(targetPath).isSymbolicLink()).toBe(false);
    expect(statSync(targetPath).isFile()).toBe(true);
    expect(readFileSync(targetPath, 'utf-8')).toBe('{"new":true}\n');
    expect(readdirSync(testDir).filter((f) => f.startsWith('.tmp.'))).toEqual([]);
  });

  it('atomicWriteSync creates a not-yet-existing file without crashing (ENOENT guard)', () => {
    const targetPath = join(testDir, 'brand-new', 'enabled-agents.json');

    expect(() => atomicWriteSync(targetPath, '{"created":true}')).not.toThrow();

    expect(existsSync(targetPath)).toBe(true);
    expect(lstatSync(targetPath).isSymbolicLink()).toBe(false);
    expect(readFileSync(targetPath, 'utf-8')).toBe('{"created":true}\n');
  });

  it.skipIf(isWindows)('atomicWriteSync follows a symlink whose target is in a different dir, link intact', () => {
    const targetDir = join(testDir, 'fleet-defs');
    const linkDir = join(testDir, 'collie');
    ensureDir(targetDir);
    ensureDir(linkDir);

    const realTarget = join(targetDir, 'AGENTS.md');
    writeFileSync(realTarget, 'v1\n', 'utf-8');

    const linkPath = join(linkDir, 'AGENTS.md');
    symlinkSync(realTarget, linkPath);

    atomicWriteSync(linkPath, 'v2');

    expect(lstatSync(linkPath).isSymbolicLink()).toBe(true);
    expect(readFileSync(realTarget, 'utf-8')).toBe('v2\n');
    expect(readFileSync(realpathSync(linkPath), 'utf-8')).toBe('v2\n');
    // temp must be created in the real target's dir for an atomic same-fs rename.
    expect(readdirSync(targetDir).filter((f) => f.startsWith('.tmp.'))).toEqual([]);
    expect(readdirSync(linkDir).filter((f) => f.startsWith('.tmp.'))).toEqual([]);
  });

  it.skipIf(isWindows)('atomicWriteSync write-through-creates a DANGLING symlink target, link intact', () => {
    // A symlink whose target does NOT exist yet (e.g. the shared fleet target
    // was deleted). The old broad-catch behavior would let realpathSync throw,
    // leave destPath = the link path, and renameSync would REPLACE the symlink
    // with a regular file — detaching the agent instead of recreating the
    // shared target. The fix must write THROUGH to the declared target.
    const missingTarget = join(testDir, 'missing-target.txt');
    const linkPath = join(testDir, 'link.txt');
    symlinkSync(missingTarget, linkPath);

    // Precondition: dangling — link exists, target does not.
    expect(lstatSync(linkPath).isSymbolicLink()).toBe(true);
    expect(existsSync(missingTarget)).toBe(false);

    atomicWriteSync(linkPath, 'DATA');

    // The link is STILL a symlink (NOT replaced by a regular file).
    expect(lstatSync(linkPath).isSymbolicLink()).toBe(true);
    // The previously-missing target now EXISTS with the data.
    expect(existsSync(missingTarget)).toBe(true);
    expect(readFileSync(missingTarget, 'utf-8')).toBe('DATA\n');
    // Reading through the (now-live) link resolves to the created target.
    expect(realpathSync(linkPath)).toBe(realpathSync(missingTarget));
    expect(readFileSync(realpathSync(linkPath), 'utf-8')).toBe('DATA\n');
    // No partial temp left behind.
    expect(readdirSync(testDir).filter((f) => f.startsWith('.tmp.'))).toEqual([]);
  });

  it.skipIf(isWindows)('atomicWriteSync resolves a relative dangling symlink against the link dir', () => {
    // A relative dangling symlink (target stated relative to the link's own
    // directory) must resolve against dirname(link), not cwd.
    const targetDir = join(testDir, 'shared');
    const linkDir = join(testDir, 'agent');
    ensureDir(targetDir);
    ensureDir(linkDir);

    const relTarget = join('..', 'shared', 'CLAUDE.md');
    const linkPath = join(linkDir, 'CLAUDE.md');
    const absTarget = join(targetDir, 'CLAUDE.md');
    symlinkSync(relTarget, linkPath); // relative target, does not exist yet

    expect(lstatSync(linkPath).isSymbolicLink()).toBe(true);
    expect(existsSync(absTarget)).toBe(false);

    atomicWriteSync(linkPath, 'shared-data');

    expect(lstatSync(linkPath).isSymbolicLink()).toBe(true);
    expect(readFileSync(absTarget, 'utf-8')).toBe('shared-data\n');
    expect(readFileSync(realpathSync(linkPath), 'utf-8')).toBe('shared-data\n');
  });

  it('atomicWriteSync keepBak writes <filePath>.bak for a regular file (unchanged)', () => {
    const targetPath = join(testDir, 'crons.json');
    writeFileSync(targetPath, '{"version":1}\n', 'utf-8');

    atomicWriteSync(targetPath, '{"version":2}', /* keepBak */ true);

    // For a non-symlink filePath === destPath, so the .bak lands at <filePath>.bak
    // with the PRE-write content — exactly what readCronsWithStatus recovers.
    const bakPath = targetPath + '.bak';
    expect(existsSync(bakPath)).toBe(true);
    expect(readFileSync(bakPath, 'utf-8')).toBe('{"version":1}\n');
    expect(readFileSync(targetPath, 'utf-8')).toBe('{"version":2}\n');
  });

  it.skipIf(isWindows)('atomicWriteSync keepBak writes the .bak at the LINK path (reader contract), not the resolved target', () => {
    // INVARIANT: readCronsWithStatus() recovers from `filePath + '.bak'` — the
    // path it was GIVEN. When crons.json is a symlink, writeCrons() passes the
    // link path as filePath. The backup must therefore land at <link>.bak
    // (matching the reader), with the PRE-write content sourced from the real
    // current target through the link. Writing to <resolved-target>.bak would
    // leave the reader unable to find the backup → false catastrophic-corruption.
    const sharedDir = join(testDir, 'shared');
    const linkDir = join(testDir, 'agent');
    ensureDir(sharedDir);
    ensureDir(linkDir);

    const realTarget = join(sharedDir, 'crons.json');
    writeFileSync(realTarget, '{"version":"PRE"}\n', 'utf-8');

    const linkPath = join(linkDir, 'crons.json');
    symlinkSync(realTarget, linkPath);

    atomicWriteSync(linkPath, '{"version":"NEW"}', /* keepBak */ true);

    // The backup lives at the LINK path + '.bak' — where the reader looks.
    const bakAtLink = linkPath + '.bak';
    expect(existsSync(bakAtLink)).toBe(true);
    // It holds the PRE-write content (what the reader would recover).
    expect(readFileSync(bakAtLink, 'utf-8')).toBe('{"version":"PRE"}\n');

    // It must NOT have gone to the resolved-target + '.bak' location.
    expect(existsSync(realTarget + '.bak')).toBe(false);

    // The link is still a symlink and the real target now holds NEW.
    expect(lstatSync(linkPath).isSymbolicLink()).toBe(true);
    expect(readFileSync(realTarget, 'utf-8')).toBe('{"version":"NEW"}\n');
    expect(readFileSync(realpathSync(linkPath), 'utf-8')).toBe('{"version":"NEW"}\n');
  });

  it('ensureDir creates nested directories recursively', () => {
    const dirPath = join(testDir, 'one', 'two', 'three');

    ensureDir(dirPath);

    expect(statSync(dirPath).isDirectory()).toBe(true);
  });

  it('ensureDir is idempotent when called twice', () => {
    const dirPath = join(testDir, 'repeat', 'path');

    expect(() => {
      ensureDir(dirPath);
      ensureDir(dirPath);
    }).not.toThrow();
  });
});
