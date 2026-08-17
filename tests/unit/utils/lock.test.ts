import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  acquireLock,
  releaseLock,
  withFileLockSync,
  type LockHandle,
} from '../../../src/utils/lock';

function acquire(testDir: string): LockHandle {
  const handle = acquireLock(testDir);
  expect(handle).not.toBe(false);
  return handle as LockHandle;
}

describe('mkdir-based locking', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'cortextos-lock-test-'));
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('acquires lock on empty directory', () => {
    const handle = acquire(testDir);
    expect(readFileSync(join(testDir, '.lock.d', 'pid'), 'utf-8')).toBe(String(process.pid));
    expect(releaseLock(handle)).toBe(true);
  });

  it('prevents double acquire', () => {
    const handle = acquire(testDir);
    // Same process, same PID - should fail since lock.d already exists
    // (but our PID check will see it's our own process and succeed)
    // Actually, mkdir will fail because it already exists, then we check PID
    // Since it's our own PID, it sees process alive and returns false
    expect(acquireLock(testDir)).toBe(false);
    expect(releaseLock(handle)).toBe(true);
  });

  it('releases lock correctly', () => {
    const first = acquire(testDir);
    expect(releaseLock(first)).toBe(true);
    const second = acquire(testDir);
    expect(releaseLock(second)).toBe(true);
  });

  it('reaps a stale partial lock whose pid file is absent', () => {
    const lockDir = join(testDir, '.lock.d');
    mkdirSync(lockDir);
    const stale = new Date(Date.now() - 60_000);
    utimesSync(lockDir, stale, stale);

    const handle = acquire(testDir);
    expect(releaseLock(handle)).toBe(true);
  });

  it('reaps a stale partial lock whose pid file is empty', () => {
    const lockDir = join(testDir, '.lock.d');
    mkdirSync(lockDir);
    writeFileSync(join(lockDir, 'pid'), '');
    const stale = new Date(Date.now() - 60_000);
    utimesSync(lockDir, stale, stale);

    const handle = acquire(testDir);
    expect(releaseLock(handle)).toBe(true);
  });

  it('does not steal a recent partial lock while its owner may be mid-acquire', () => {
    const lockDir = join(testDir, '.lock.d');
    mkdirSync(lockDir);

    expect(acquireLock(testDir)).toBe(false);
    expect(existsSync(lockDir)).toBe(true);
  });

  it('preserves a successor when a revoked live owner releases late', () => {
    const lockDir = join(testDir, '.lock.d');
    const originalHandle = acquire(testDir);
    const originalOwner = readFileSync(join(lockDir, '.owner'), 'utf-8');

    writeFileSync(join(lockDir, 'pid'), '');
    const stale = new Date(Date.now() - 60_000);
    utimesSync(lockDir, stale, stale);

    const successorHandle = acquire(testDir);
    const successorOwner = readFileSync(join(lockDir, '.owner'), 'utf-8');
    expect(successorOwner).not.toBe(originalOwner);

    expect(releaseLock(originalHandle)).toBe(false);

    expect(existsSync(lockDir)).toBe(true);
    expect(readFileSync(join(lockDir, '.owner'), 'utf-8')).toBe(successorOwner);
    expect(releaseLock(successorHandle)).toBe(true);
    expect(existsSync(lockDir)).toBe(false);
  });

  it('keeps generation identity opaque from a revoked external holder', () => {
    const lockDir = join(testDir, '.lock.d');
    const staleHandle = acquire(testDir);

    writeFileSync(join(lockDir, 'pid'), '');
    const stale = new Date(Date.now() - 60_000);
    utimesSync(lockDir, stale, stale);

    const successorHandle = acquire(testDir);
    const successorStat = statSync(lockDir);
    const successorOwner = readFileSync(join(lockDir, '.owner'), 'utf-8');

    let rewriteRejected = false;
    try {
      Object.assign(staleHandle, {
        lockDir,
        generation: {
          snapshot: {
            dev: successorStat.dev,
            ino: successorStat.ino,
            mtimeMs: successorStat.mtimeMs,
          },
          ownerFile: join(lockDir, '.owner'),
          ownerToken: successorOwner,
        },
      });
    } catch (err) {
      expect(err).toBeInstanceOf(TypeError);
      rewriteRejected = true;
    }

    expect(releaseLock(staleHandle)).toBe(false);
    expect(existsSync(lockDir)).toBe(true);
    expect(readFileSync(join(lockDir, '.owner'), 'utf-8')).toBe(successorOwner);
    expect(rewriteRejected).toBe(true);
    expect(Object.isFrozen(staleHandle)).toBe(true);
    expect(Reflect.ownKeys(staleHandle)).toEqual([]);
    expect(JSON.stringify(staleHandle)).toBe('{}');
    expect(() => Object.setPrototypeOf(staleHandle, {})).toThrow(TypeError);

    // Copying the genuine prototype still cannot forge module-private state.
    const forgedHandle = Object.create(Object.getPrototypeOf(staleHandle));
    expect(releaseLock(forgedHandle)).toBe(false);

    expect(releaseLock(successorHandle)).toBe(true);
    expect(existsSync(lockDir)).toBe(false);
  });

  it('withFileLockSync preserves a successor acquired after its handle is revoked', () => {
    const lockDir = join(testDir, '.lock.d');
    let successorHandle: LockHandle | false = false;
    let successorOwner = '';

    const result = withFileLockSync(testDir, () => {
      writeFileSync(join(lockDir, 'pid'), '');
      const stale = new Date(Date.now() - 60_000);
      utimesSync(lockDir, stale, stale);
      successorHandle = acquireLock(testDir);
      expect(successorHandle).not.toBe(false);
      successorOwner = readFileSync(join(lockDir, '.owner'), 'utf-8');
      return 'complete';
    });

    expect(result).toBe('complete');
    expect(existsSync(lockDir)).toBe(true);
    expect(readFileSync(join(lockDir, '.owner'), 'utf-8')).toBe(successorOwner);
    expect(successorHandle).not.toBe(false);
    expect(releaseLock(successorHandle as LockHandle)).toBe(true);
  });
});
