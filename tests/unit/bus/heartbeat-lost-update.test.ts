/**
 * Regression tests for the heartbeat/loop-detector TOCTOU lost-update
 * (framework-bughunt finding, "Class E" — separate mechanism from the
 * torn-write sweep).
 *
 * Two writers touch state/<agent>/heartbeat.json:
 *   - updateHeartbeat() (heartbeat.ts) — an authoritative OVERWRITE that
 *     sets status / mode / current_task / loop_interval.
 *   - logEvent()'s refreshHeartbeatTimestamp() (event.ts) — a READ-MODIFY-
 *     WRITE that bumps only last_heartbeat and preserves the rest.
 *
 * Without a shared lock, this interleave loses an update:
 *   1. refresh reads heartbeat   (status="online")
 *   2. updateHeartbeat overwrites (status="busy")
 *   3. refresh writes its stale copy back (status="online")  ← busy lost.
 *
 * The fix wraps BOTH writers in withFileLockSync(stateDir, ...) so the RMW
 * is atomic against the overwrite. These tests prove (a) both writers take
 * the SAME per-agent lock and (b) the interleave that used to clobber a
 * field no longer can.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
} from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { updateHeartbeat } from '../../../src/bus/heartbeat';
import { HEARTBEAT_SESSION_ENV } from '../../../src/utils/env';
import { logEvent } from '../../../src/bus/event';
import * as lock from '../../../src/utils/lock';
import type { BusPaths, Heartbeat } from '../../../src/types';

import { recordSessionNonce } from '../../../src/bus/heartbeat-session-store';
let testDir: string;
let paths: BusPaths;
const originalTz = process.env.TZ;

function makePaths(root: string): BusPaths {
  return {
    ctxRoot: root,
    inbox: join(root, 'inbox', 'moss'),
    inflight: join(root, 'inflight', 'moss'),
    processed: join(root, 'processed', 'moss'),
    logDir: join(root, 'logs', 'moss'),
    stateDir: join(root, 'state', 'moss'),
    taskDir: join(root, 'tasks'),
    approvalDir: join(root, 'approvals'),
    analyticsDir: join(root, 'analytics'),
    heartbeatDir: join(root, 'heartbeats'),
  };
}

beforeEach(() => {
  testDir = mkdtempSync(join(tmpdir(), 'cortextos-hb-lostupdate-'));
  paths = makePaths(testDir);
  mkdirSync(paths.stateDir, { recursive: true });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  if (originalTz === undefined) delete process.env.TZ;
  else process.env.TZ = originalTz;
  rmSync(testDir, { recursive: true, force: true });
});

describe('heartbeat timezone coercion', () => {
  it('NAMED HEARTBEAT BLANK TIMEZONE: omission preserves host-local mode', () => {
    process.env.TZ = 'America/Los_Angeles';
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-12T14:30:00Z')); // 07:30 PDT = night
    updateHeartbeat(paths, 'moss', 'online', { org: 'ascendops', timezone: '' });
    const heartbeat = JSON.parse(
      readFileSync(join(paths.stateDir, 'heartbeat.json'), 'utf-8'),
    ) as Heartbeat;
    expect(heartbeat.mode).toBe('night');
  });

  it('NAMED HEARTBEAT EXPLICIT TIMEZONE: configured zone overrides host', () => {
    process.env.TZ = 'America/Los_Angeles';
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-12T14:30:00Z')); // 10:30 EDT = day
    updateHeartbeat(paths, 'moss', 'online', {
      org: 'ascendops',
      timezone: 'America/New_York',
    });
    const heartbeat = JSON.parse(
      readFileSync(join(paths.stateDir, 'heartbeat.json'), 'utf-8'),
    ) as Heartbeat;
    expect(heartbeat.mode).toBe('day');
  });
});

describe('heartbeat lost-update — both writers take the per-agent stateDir lock', () => {
  it('updateHeartbeat acquires the stateDir lock', () => {
    const withLock = vi.spyOn(lock, 'withFileLockSync');
    updateHeartbeat(paths, 'moss', 'busy', { org: 'ascendops' });
    expect(withLock).toHaveBeenCalled();
    expect(withLock.mock.calls.some(([dir]) => dir === paths.stateDir)).toBe(true);
  });

  it('logEvent heartbeat refresh acquires the stateDir lock', () => {
    // A refresh now requires the agent-session credential as well. This test
    // asserts the ALLOW direction, so it has to stand where a real agent session
    // stands: inside a PTY-minted session. Before the credential existed this
    // line was unnecessary and the guard was fail-OPEN — absence of a marker was
    // enough. Its absence here is what the fail-closed half changed.
    process.env[HEARTBEAT_SESSION_ENV] = 'moss:test-session-nonce-000';
    recordSessionNonce(paths.ctxRoot, 'moss', 'test-session-nonce-000');
    // Refresh only runs when a heartbeat already exists.
    const hb: Heartbeat = {
      agent: 'moss', org: 'ascendops', status: 'online',
      current_task: '', mode: 'day',
      last_heartbeat: '2026-04-23T12:00:00Z', loop_interval: '4h',
    };
    writeFileSync(join(paths.stateDir, 'heartbeat.json'), JSON.stringify(hb));

    const withLock = vi.spyOn(lock, 'withFileLockSync');
    // Refresh is opt-in as of upstream 28500e76 (on-behalf writes must not spoof
    // liveness). This test's subject is the LOCK taken DURING a refresh, not the
    // always-refresh policy, so it opts in explicitly to keep exercising that path.
    logEvent(paths, 'moss', 'ascendops', 'action', 'tick', 'info', undefined, { refreshHeartbeat: true });
    expect(withLock.mock.calls.some(([dir]) => dir === paths.stateDir)).toBe(true);
  });
});

describe('heartbeat lost-update — the lock enforces mutual exclusion', () => {
  it('a second writer cannot enter the critical section while the stateDir lock is held', () => {
    // Seed: status=online (the value a stale RMW would clobber back to).
    const seed: Heartbeat = {
      agent: 'moss', org: 'ascendops', status: 'online',
      current_task: 'old-task', mode: 'day',
      last_heartbeat: '2026-04-23T12:00:00Z', loop_interval: '4h',
    };
    const hbPath = join(paths.stateDir, 'heartbeat.json');
    writeFileSync(hbPath, JSON.stringify(seed));

    // Model the exact lost-update interleave deterministically:
    //   (1) "writer A" (logEvent's refresh) holds the per-agent stateDir lock
    //       and reads the stale online snapshot.
    //   (2) WHILE A holds the lock, "writer B" (updateHeartbeat) tries to set
    //       status=busy. Both writers take the SAME lock, so B's attempt to
    //       acquire it MUST be refused — it cannot race into A's read→write
    //       window. We prove that directly: acquireLock(stateDir) returns
    //       false while A holds it.
    //   (3) A finishes its timestamp bump and releases.
    const refreshTimestamp = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');

    lock.withFileLockSync(paths.stateDir, () => {
      const aSnapshot = JSON.parse(readFileSync(hbPath, 'utf-8')) as Heartbeat;
      expect(aSnapshot.status).toBe('online');

      // B (updateHeartbeat) would call acquireLock(stateDir) first — and it is
      // refused while A holds the lock. So B cannot land status=busy between
      // A's read and write.
      expect(lock.acquireLock(paths.stateDir)).toBe(false);

      // A completes its bump on the snapshot it read, then releases.
      aSnapshot.last_heartbeat = refreshTimestamp;
      writeFileSync(hbPath, JSON.stringify(aSnapshot));
    });

    // After A released, B's update now applies cleanly and serially — the
    // post-fix world. Both contributions survive: B's status AND A's bump.
    updateHeartbeat(paths, 'moss', 'busy', { org: 'ascendops', currentTask: 'now-busy' });
    const final = JSON.parse(readFileSync(hbPath, 'utf-8')) as Heartbeat;
    expect(final.status).toBe('busy');
    expect(final.current_task).toBe('now-busy');
  });

  it('sequential overwrite-then-refresh keeps the overwrite status and a fresh timestamp', async () => {
    updateHeartbeat(paths, 'moss', 'online', { org: 'ascendops', currentTask: 'boot' });
    await new Promise((r) => setTimeout(r, 2));
    updateHeartbeat(paths, 'moss', 'busy', { org: 'ascendops', currentTask: 'working' });
    await new Promise((r) => setTimeout(r, 2));
    logEvent(paths, 'moss', 'ascendops', 'action', 'tick', 'info');

    const hbPath = join(paths.stateDir, 'heartbeat.json');
    expect(existsSync(hbPath)).toBe(true);
    const final = JSON.parse(readFileSync(hbPath, 'utf-8')) as Heartbeat;
    expect(final.status).toBe('busy');
    expect(final.current_task).toBe('working');
  });
});
