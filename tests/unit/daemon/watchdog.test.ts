/**
 * watchdog.test.ts — stability-state persistence tests (F11).
 *
 * saveStability() fires on EVERY crash — i.e. during crash-loops, exactly
 * when daemon death mid-write is most likely. A torn watchdog.json resets
 * restart_counts/last_healthy and defeats the ROLLBACK_THRESHOLD right when
 * it matters. These tests prove the write goes through atomicWriteSync
 * (tmp + rename), the on-disk format is unchanged, and the best-effort
 * never-throw contract is preserved.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, readdirSync, readFileSync, existsSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { execFileSync } from 'child_process';

import {
  recordFailure,
  markHealthy,
  shouldRollback,
  performRollback,
  getCurrentCommit,
  isWatchdogRollbackEnabled,
  watchdogRollbackMaxResets,
  ROLLBACK_THRESHOLD,
  type CommitStability,
} from '../../../src/daemon/watchdog';
import * as atomic from '../../../src/utils/atomic';

let tmpRoot: string;
let repoRoot: string;
let stateDir: string;

/** Init a real git repo with one commit so getCurrentCommit() works. */
function initRepo(dir: string): void {
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
  git('init', '--quiet');
  git('-c', 'user.email=test@test', '-c', 'user.name=test',
      'commit', '--allow-empty', '-m', 'init', '--quiet');
}

function git(...args: string[]): string {
  return execFileSync('git', args, {
    cwd: repoRoot,
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
}

function commitEmpty(message: string): string {
  git('-c', 'user.email=test@test', '-c', 'user.name=test',
    'commit', '--allow-empty', '-m', message, '--quiet');
  return getCurrentCommit(repoRoot)!;
}

function writeStability(data: Partial<CommitStability>): void {
  atomic.ensureDir(stateDir);
  writeFileSync(
    join(stateDir, 'watchdog.json'),
    JSON.stringify({
      restart_counts: {},
      last_healthy: '',
      rollback_counts: {},
      ...data,
    }, null, 2) + '\n',
    'utf-8',
  );
}

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'watchdog-test-'));
  repoRoot = join(tmpRoot, 'repo');
  stateDir = join(tmpRoot, 'state', 'agent');
  atomic.ensureDir(repoRoot);
  initRepo(repoRoot);
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe('saveStability — atomic write (F11)', () => {
  it('recordFailure persists watchdog.json through atomicWriteSync', () => {
    const atomicWrite = vi.spyOn(atomic, 'atomicWriteSync');
    recordFailure(stateDir, repoRoot);
    expect(
      atomicWrite.mock.calls.some(([p]) => p === join(stateDir, 'watchdog.json')),
    ).toBe(true);
  });

  it('leaves no temp files and a cleanly parseable file behind', () => {
    recordFailure(stateDir, repoRoot);
    recordFailure(stateDir, repoRoot);
    const leftovers = readdirSync(stateDir).filter(f => f.startsWith('.tmp.'));
    expect(leftovers).toEqual([]);
    const raw = readFileSync(join(stateDir, 'watchdog.json'), 'utf-8');
    const parsed = JSON.parse(raw) as CommitStability;
    const commit = getCurrentCommit(repoRoot)!;
    expect(parsed.restart_counts[commit]).toBe(2);
    // On-disk format unchanged: pretty-printed JSON + trailing newline.
    expect(raw.endsWith('\n')).toBe(true);
  });

  it('creates the state directory when missing (mkdir handled by atomicWriteSync)', () => {
    expect(existsSync(stateDir)).toBe(false);
    recordFailure(stateDir, repoRoot);
    expect(existsSync(join(stateDir, 'watchdog.json'))).toBe(true);
  });

  it('never throws even when the underlying write fails (best-effort contract)', () => {
    vi.spyOn(atomic, 'atomicWriteSync').mockImplementation(() => {
      throw new Error('disk full');
    });
    expect(() => recordFailure(stateDir, repoRoot)).not.toThrow();
    expect(() => markHealthy(stateDir, repoRoot)).not.toThrow();
  });
});

describe('failure counting + rollback threshold round-trip', () => {
  it('shouldRollback trips only at ROLLBACK_THRESHOLD failures on the same commit', () => {
    for (let i = 0; i < ROLLBACK_THRESHOLD - 1; i++) {
      recordFailure(stateDir, repoRoot);
      expect(shouldRollback(stateDir, repoRoot)).toBe(false);
    }
    recordFailure(stateDir, repoRoot);
    expect(shouldRollback(stateDir, repoRoot)).toBe(true);
  });

  it('markHealthy clears the failure count and records last_healthy', () => {
    recordFailure(stateDir, repoRoot);
    recordFailure(stateDir, repoRoot);
    markHealthy(stateDir, repoRoot);
    expect(shouldRollback(stateDir, repoRoot)).toBe(false);
    const parsed = JSON.parse(
      readFileSync(join(stateDir, 'watchdog.json'), 'utf-8'),
    ) as CommitStability;
    expect(parsed.last_healthy).toBe(getCurrentCommit(repoRoot));
    expect(parsed.restart_counts).toEqual({});
  });
});

describe('rollback destructive safety gates', () => {
  it('keeps rollback disabled by default and parses max reset env defensively', () => {
    expect(isWatchdogRollbackEnabled({} as NodeJS.ProcessEnv)).toBe(false);
    expect(isWatchdogRollbackEnabled({ WATCHDOG_ROLLBACK_ENABLED: 'false' } as NodeJS.ProcessEnv)).toBe(false);
    expect(isWatchdogRollbackEnabled({ WATCHDOG_ROLLBACK_ENABLED: 'true' } as NodeJS.ProcessEnv)).toBe(true);

    expect(watchdogRollbackMaxResets({} as NodeJS.ProcessEnv)).toBe(1);
    expect(watchdogRollbackMaxResets({ WATCHDOG_ROLLBACK_MAX_RESETS: '3' } as NodeJS.ProcessEnv)).toBe(3);
    expect(watchdogRollbackMaxResets({ WATCHDOG_ROLLBACK_MAX_RESETS: '0' } as NodeJS.ProcessEnv)).toBe(1);
  });

  it('depth cap halts before stash/reset after N cumulative resets on the branch', () => {
    const rollbackTarget = getCurrentCommit(repoRoot)!;
    const failedCommit = commitEmpty('unstable');
    const branch = git('rev-parse', '--abbrev-ref', 'HEAD');
    writeStability({
      restart_counts: { [failedCommit]: ROLLBACK_THRESHOLD },
      last_healthy: rollbackTarget,
      rollback_counts: { [branch]: 1 },
    });

    const result = performRollback(stateDir, repoRoot, { maxResetsPerBranch: 1 });

    expect(result.success).toBe(false);
    expect(result.reason).toContain('Rollback depth cap reached');
    expect(getCurrentCommit(repoRoot)).toBe(failedCommit);
  });

  it('fires event and Telegram pre-notify hooks before a destructive rollback', () => {
    const rollbackTarget = getCurrentCommit(repoRoot)!;
    const failedCommit = commitEmpty('unstable');
    writeStability({
      restart_counts: { [failedCommit]: ROLLBACK_THRESHOLD },
      last_healthy: rollbackTarget,
      rollback_counts: {},
    });
    const eventHook = vi.fn();
    const notifyHook = vi.fn();

    const result = performRollback(stateDir, repoRoot, {
      maxResetsPerBranch: 1,
      logEventBeforeRollback: eventHook,
      notifyBeforeRollback: notifyHook,
    });

    expect(result.success).toBe(true);
    expect(eventHook).toHaveBeenCalledTimes(1);
    expect(notifyHook).toHaveBeenCalledTimes(1);
    expect(eventHook.mock.calls[0][0]).toMatchObject({
      failedCommit,
      target: rollbackTarget,
      resetCount: 0,
      maxResets: 1,
    });
    expect(getCurrentCommit(repoRoot)).toBe(rollbackTarget);
    const parsed = JSON.parse(
      readFileSync(join(stateDir, 'watchdog.json'), 'utf-8'),
    ) as CommitStability;
    const branch = eventHook.mock.calls[0][0].branch as string;
    expect(parsed.rollback_counts?.[branch]).toBe(1);
  });

  it('refuses rollback targets older than the configured floor ref before reset', () => {
    const tooOldTarget = getCurrentCommit(repoRoot)!;
    const floorCommit = commitEmpty('floor');
    const failedCommit = commitEmpty('unstable');
    writeStability({
      restart_counts: { [failedCommit]: ROLLBACK_THRESHOLD },
      last_healthy: tooOldTarget,
      rollback_counts: {},
    });

    const result = performRollback(stateDir, repoRoot, {
      maxResetsPerBranch: 1,
      floorRef: floorCommit,
    });

    expect(result.success).toBe(false);
    expect(result.reason).toContain('floor ref');
    expect(getCurrentCommit(repoRoot)).toBe(failedCommit);
  });
});
