import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const fsMock = vi.hoisted(() => ({
  readFileSync: vi.fn(),
  renameSync: vi.fn(),
  rmSync: vi.fn(),
  writeFileSync: vi.fn(),
  actualReadFileSync: undefined as typeof import('fs').readFileSync | undefined,
  actualRenameSync: undefined as typeof import('fs').renameSync | undefined,
  actualRmSync: undefined as typeof import('fs').rmSync | undefined,
  actualWriteFileSync: undefined as typeof import('fs').writeFileSync | undefined,
}));

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  fsMock.actualReadFileSync = actual.readFileSync;
  fsMock.actualRenameSync = actual.renameSync;
  fsMock.actualRmSync = actual.rmSync;
  fsMock.actualWriteFileSync = actual.writeFileSync;
  fsMock.readFileSync.mockImplementation(actual.readFileSync);
  fsMock.rmSync.mockImplementation(actual.rmSync);
  fsMock.writeFileSync.mockImplementation(actual.writeFileSync);
  return {
    ...actual,
    readFileSync: fsMock.readFileSync,
    renameSync: fsMock.renameSync,
    rmSync: fsMock.rmSync,
    writeFileSync: fsMock.writeFileSync,
  };
});

import { acquireLock, releaseLock, type LockHandle } from '../../../src/utils/lock';

function releaseWinner(...candidates: Array<LockHandle | false | undefined>): void {
  const winner = candidates.find(candidate => candidate !== false && candidate !== undefined);
  expect(winner).toBeDefined();
  expect(releaseLock(winner as LockHandle)).toBe(true);
}

describe('lock recovery concurrency and ambiguity', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'cortextos-lock-recovery-'));
    fsMock.readFileSync.mockImplementation(fsMock.actualReadFileSync!);
    fsMock.renameSync.mockImplementation(fsMock.actualRenameSync!);
    fsMock.rmSync.mockImplementation(fsMock.actualRmSync!);
    fsMock.writeFileSync.mockImplementation(fsMock.actualWriteFileSync!);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(testDir, { recursive: true, force: true });
  });

  it('allows exactly one winner when a delayed stale reclaimer resumes after another wins', () => {
    const lockDir = join(testDir, '.lock.d');
    mkdirSync(lockDir);
    writeFileSync(join(lockDir, 'pid'), '99999999');
    const stale = new Date(Date.now() - 60_000);
    utimesSync(lockDir, stale, stale);

    const actualKill = process.kill.bind(process);
    const killSpy = vi.spyOn(process, 'kill');
    let firstWinner: LockHandle | false | undefined;
    killSpy.mockImplementationOnce(((..._args: Parameters<typeof process.kill>) => {
      killSpy.mockImplementation(actualKill);
      firstWinner = acquireLock(testDir);
      throw Object.assign(new Error('process gone'), { code: 'ESRCH' });
    }) as typeof process.kill);

    const delayedReclaimer = acquireLock(testDir);

    expect([firstWinner, delayedReclaimer].filter(Boolean)).toHaveLength(1);
    expect(readFileSync(join(lockDir, 'pid'), 'utf-8')).toBe(String(process.pid));
    releaseWinner(firstWinner, delayedReclaimer);
    const next = acquireLock(testDir);
    expect(next).not.toBe(false);
    releaseWinner(next);
  });

  it.each(['absent', 'empty'])('allows one winner when two reclaimers race on a stale %s pid', shape => {
    const lockDir = join(testDir, '.lock.d');
    mkdirSync(lockDir);
    if (shape === 'empty') writeFileSync(join(lockDir, 'pid'), '');
    const stale = new Date(Date.now() - 60_000);
    utimesSync(lockDir, stale, stale);

    let interleaved = false;
    let firstWinner: LockHandle | false | undefined;
    fsMock.rmSync.mockImplementation(((target, options) => {
      if (!interleaved && target === lockDir) {
        interleaved = true;
        firstWinner = acquireLock(testDir);
      }
      return fsMock.actualRmSync!(target, options);
    }) as typeof rmSync);
    fsMock.writeFileSync.mockImplementation(((target, ...rest) => {
      if (!interleaved && target === join(lockDir, '.takeover')) {
        interleaved = true;
        firstWinner = acquireLock(testDir);
      }
      return fsMock.actualWriteFileSync!(target, ...rest);
    }) as typeof writeFileSync);

    const delayedReclaimer = acquireLock(testDir);

    expect(interleaved).toBe(true);
    expect([firstWinner, delayedReclaimer].filter(Boolean)).toHaveLength(1);
    expect(readFileSync(join(lockDir, 'pid'), 'utf-8')).toBe(String(process.pid));
    releaseWinner(firstWinner, delayedReclaimer);
  });

  it('allows one winner when two stale reclaimers interleave at generation quarantine', () => {
    const lockDir = join(testDir, '.lock.d');
    mkdirSync(lockDir);
    const stale = new Date(Date.now() - 60_000);
    utimesSync(lockDir, stale, stale);

    let interleaved = false;
    let secondWinner: LockHandle | false | undefined;
    vi.spyOn(process, 'kill').mockImplementation(() => {
      // Model a first reclaimer that died after publishing its marker. The
      // second then reaches the atomic quarantine boundary before the delayed
      // first call resumes, proving the rename remains the single-winner gate.
      throw Object.assign(new Error('marker owner exited'), { code: 'ESRCH' });
    });
    fsMock.renameSync.mockImplementation(((source, destination) => {
      if (!interleaved && source === lockDir) {
        interleaved = true;
        // The first reclaimer's marker refreshed the directory mtime. Age it
        // again so the second reaches the correctness-bearing rename boundary.
        utimesSync(lockDir, stale, stale);
        secondWinner = acquireLock(testDir);
      }
      return fsMock.actualRenameSync!(source, destination);
    }) as typeof renameSync);

    const firstWinner = acquireLock(testDir);

    expect(interleaved).toBe(true);
    expect([firstWinner, secondWinner].filter(Boolean)).toHaveLength(1);
    expect(readFileSync(join(lockDir, 'pid'), 'utf-8')).toBe(String(process.pid));
    releaseWinner(firstWinner, secondWinner);
  });

  it('does not age-steal a takeover marker owned by a live operation', () => {
    const handle = acquireLock(testDir);
    expect(handle).not.toBe(false);
    const lockDir = join(testDir, '.lock.d');
    writeFileSync(join(lockDir, 'pid'), '');
    writeFileSync(join(lockDir, '.takeover'), `${process.pid}:1`);
    const stale = new Date(Date.now() - 60_000);
    utimesSync(lockDir, stale, stale);

    expect(acquireLock(testDir)).toBe(false);
    rmSync(join(lockDir, '.takeover'), { force: true });
    releaseWinner(handle);
  });

  it('recovers an old partial takeover marker without a credible owner', () => {
    const lockDir = join(testDir, '.lock.d');
    mkdirSync(lockDir);
    writeFileSync(join(lockDir, '.takeover'), '');
    const stale = new Date(Date.now() - 60_000);
    utimesSync(lockDir, stale, stale);

    const handle = acquireLock(testDir);

    expect(handle).not.toBe(false);
    releaseWinner(handle);
  });

  it.each(['EACCES', 'EIO', 'EMFILE'])('does not reap a valid live lock when pid reading fails with %s', code => {
    const handle = acquireLock(testDir);
    expect(handle).not.toBe(false);
    const lockDir = join(testDir, '.lock.d');
    const stale = new Date(Date.now() - 60_000);
    utimesSync(lockDir, stale, stale);
    fsMock.readFileSync.mockImplementationOnce(() => {
      throw Object.assign(new Error(`transient ${code}`), { code });
    });

    expect(acquireLock(testDir)).toBe(false);
    expect(readFileSync(join(lockDir, 'pid'), 'utf-8')).toBe(String(process.pid));
    releaseWinner(handle);
  });

  it('does not reap when owner liveness is ambiguous rather than ESRCH', () => {
    const handle = acquireLock(testDir);
    expect(handle).not.toBe(false);
    const lockDir = join(testDir, '.lock.d');
    vi.spyOn(process, 'kill').mockImplementationOnce(() => {
      throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' });
    });

    expect(acquireLock(testDir)).toBe(false);
    expect(readFileSync(join(lockDir, 'pid'), 'utf-8')).toBe(String(process.pid));
    releaseWinner(handle);
  });

  it('treats a numeric-prefix pid as corrupt rather than a live holder', () => {
    const lockDir = join(testDir, '.lock.d');
    mkdirSync(lockDir);
    writeFileSync(join(lockDir, 'pid'), `${process.pid}garbage`);
    const stale = new Date(Date.now() - 60_000);
    utimesSync(lockDir, stale, stale);

    const handle = acquireLock(testDir);
    expect(readFileSync(join(lockDir, 'pid'), 'utf-8')).toBe(String(process.pid));
    expect(handle).not.toBe(false);
    releaseWinner(handle);
  });

  it('allows exactly one winner when a second acquirer arrives mid-publication', () => {
    let contender: LockHandle | false | undefined;
    let paused = false;
    fsMock.writeFileSync.mockImplementation(((target, ...rest) => {
      if (!paused && String(target).endsWith('.pending')) {
        paused = true;
        contender = acquireLock(testDir);
      }
      return fsMock.actualWriteFileSync!(target, ...rest);
    }) as typeof writeFileSync);

    const owner = acquireLock(testDir);

    expect([owner, contender].filter(Boolean)).toHaveLength(1);
    expect(existsSync(join(testDir, '.lock.d'))).toBe(true);
    expect(readFileSync(join(testDir, '.lock.d', 'pid'), 'utf-8')).toBe(String(process.pid));
    releaseWinner(owner, contender);
  });

  it('revokes a delayed original publisher after its partial generation is reclaimed', () => {
    const lockDir = join(testDir, '.lock.d');
    const stale = new Date(Date.now() - 60_000);
    let contender: LockHandle | false | undefined;
    let paused = false;
    fsMock.writeFileSync.mockImplementation(((target, ...rest) => {
      if (!paused && String(target).endsWith('.pending')) {
        paused = true;
        utimesSync(join(String(target), '..'), stale, stale);
        contender = acquireLock(testDir);
      }
      return fsMock.actualWriteFileSync!(target, ...rest);
    }) as typeof writeFileSync);

    const originalPublisher = acquireLock(testDir);

    expect([originalPublisher, contender].filter(Boolean)).toHaveLength(1);
    expect(readFileSync(join(lockDir, 'pid'), 'utf-8')).toBe(String(process.pid));
    releaseWinner(originalPublisher, contender);
  });

  it('does not delete a successor when a revoked publisher fails during publication', () => {
    const lockDir = join(testDir, '.lock.d');
    const stale = new Date(Date.now() - 60_000);
    const publicationFailure = Object.assign(new Error('publication failed'), { code: 'EIO' });
    let contender: LockHandle | false | undefined;
    let publicationInterrupted = false;
    fsMock.renameSync.mockImplementation(((source, destination) => {
      if (!publicationInterrupted && String(source).endsWith('.pending')) {
        publicationInterrupted = true;
        utimesSync(lockDir, stale, stale);
        contender = acquireLock(testDir);
        throw publicationFailure;
      }
      return fsMock.actualRenameSync!(source, destination);
    }) as typeof renameSync);

    expect(acquireLock(testDir)).toBe(false);
    expect(contender).not.toBe(false);
    expect(existsSync(lockDir)).toBe(true);
    expect(readFileSync(join(lockDir, 'pid'), 'utf-8')).toBe(String(process.pid));
    releaseWinner(contender);
  });
});
