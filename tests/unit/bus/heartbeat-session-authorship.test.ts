import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { logEvent, borrowedIdentityMarker } from '../../../src/bus/event';
import { resolveEnv, writeCortextosEnv, HEARTBEAT_SESSION_ENV } from '../../../src/utils/env';
import type { BusPaths, Heartbeat, CtxEnv } from '../../../src/types';

import { recordSessionNonce } from '../../../src/bus/heartbeat-session-store';
/**
 * Guard 1 — a heartbeat refresh must be authored by the session it proves.
 *
 * PR #275 made the refresh opt-in, but `bus log-event` opts in
 * UNCONDITIONALLY. Any process that reaches that CLI while carrying a
 * BORROWED agent identity can therefore move an agent's `last_heartbeat`
 * without that agent's session having run at all.
 *
 * Both directions are asserted here on purpose. A guard that refuses
 * everything and a guard that works are indistinguishable if you only test
 * the refusal.
 */

const MARKER_VARS = ['CTX_SIDE_RUN', 'CTX_ON_BEHALF_OF', 'CTX_HEARTBEAT_SESSION'] as const;

describe('heartbeat session authorship', () => {
  let testDir: string;
  let paths: BusPaths;
  let savedMarkers: Record<string, string | undefined>;

  const OLD_TS = '2026-04-23T12:00:00Z';

  function writeHeartbeat(): string {
    const hb: Heartbeat = {
      agent: 'spark',
      org: 'eros-os',
      status: 'online',
      current_task: 'crashed-and-being-rolled-back',
      mode: 'day',
      last_heartbeat: OLD_TS,
      loop_interval: '4h',
    };
    const raw = JSON.stringify(hb);
    writeFileSync(join(paths.stateDir, 'heartbeat.json'), raw);
    return raw;
  }

  function readHeartbeatRaw(): string {
    return readFileSync(join(paths.stateDir, 'heartbeat.json'), 'utf-8');
  }

  function eventLines(): string[] {
    const today = new Date().toISOString().split('T')[0];
    const f = join(paths.analyticsDir, 'events', 'spark', `${today}.jsonl`);
    if (!existsSync(f)) return [];
    return readFileSync(f, 'utf-8').trim().split('\n').filter(Boolean);
  }

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'cortextos-hb-authorship-'));
    paths = {
      ctxRoot: testDir,
      inbox: join(testDir, 'inbox', 'spark'),
      inflight: join(testDir, 'inflight', 'spark'),
      processed: join(testDir, 'processed', 'spark'),
      logDir: join(testDir, 'logs', 'spark'),
      stateDir: join(testDir, 'state', 'spark'),
      taskDir: join(testDir, 'tasks'),
      approvalDir: join(testDir, 'approvals'),
      analyticsDir: join(testDir, 'analytics'),
      heartbeatDir: join(testDir, 'heartbeats'),
    };
    mkdirSync(paths.stateDir, { recursive: true });
    savedMarkers = {};
    for (const v of MARKER_VARS) {
      savedMarkers[v] = process.env[v];
      delete process.env[v];
    }
  });

  afterEach(() => {
    for (const v of MARKER_VARS) {
      if (savedMarkers[v] === undefined) delete process.env[v];
      else process.env[v] = savedMarkers[v]!;
    }
    rmSync(testDir, { recursive: true, force: true });
  });

  // ── DIRECTION 1: the guard REFUSES a borrowed-identity refresh ────────────

  it('DOES NOT move last_heartbeat when the process carries CTX_SIDE_RUN (cron side-run)', () => {
    // Mint the credential so this test ISOLATES the marker guard. Without it the
    // test passes for the wrong reason — no refresh because no credential — and
    // a mutation removing the marker check leaves it green. Proven: with this
    // line absent, dropping `borrowedIdentityMarker() === null` from the gate
    // killed only one of the three marker tests.
    process.env[HEARTBEAT_SESSION_ENV] = 'spark:test-session-nonce-000';
    recordSessionNonce(paths.ctxRoot, 'spark', 'test-session-nonce-000');
    const raw = writeHeartbeat();
    process.env.CTX_SIDE_RUN = '1';

    logEvent(paths, 'spark', 'eros-os', 'action', 'side_run_verdict', 'info', undefined, {
      refreshHeartbeat: true,
    });

    // Liveness claim withheld — byte-identical, not merely "close".
    expect(readHeartbeatRaw()).toBe(raw);
    // …but the event itself is still recorded. Withholding liveness must not
    // silently drop the audit record.
    expect(eventLines()).toHaveLength(1);
    expect(JSON.parse(eventLines()[0]).event).toBe('side_run_verdict');
  });

  it('DOES NOT move last_heartbeat when the process carries CTX_ON_BEHALF_OF (daemon watchdog write)', () => {
    // Mint the credential so this test ISOLATES the marker guard. Without it the
    // test passes for the wrong reason — no refresh because no credential — and
    // a mutation removing the marker check leaves it green. Proven: with this
    // line absent, dropping `borrowedIdentityMarker() === null` from the gate
    // killed only one of the three marker tests.
    process.env[HEARTBEAT_SESSION_ENV] = 'spark:test-session-nonce-000';
    recordSessionNonce(paths.ctxRoot, 'spark', 'test-session-nonce-000');
    const raw = writeHeartbeat();
    process.env.CTX_ON_BEHALF_OF = 'spark';

    logEvent(paths, 'spark', 'eros-os', 'error', 'watchdog_rollback_preflight', 'error', undefined, {
      refreshHeartbeat: true,
    });

    expect(readHeartbeatRaw()).toBe(raw);
    expect(eventLines()).toHaveLength(1);
  });

  // ── DIRECTION 2: the guard ALLOWS the agent's own session ─────────────────
  // Without this, a guard that refuses unconditionally would pass.

  it('DOES move last_heartbeat for an own-session log-event with no borrowed-identity marker', async () => {
    // A refresh now requires the agent-session credential as well. This test
    // asserts the ALLOW direction, so it has to stand where a real agent session
    // stands: inside a PTY-minted session. Before the credential existed this
    // line was unnecessary and the guard was fail-OPEN — absence of a marker was
    // enough. Its absence here is what the fail-closed half changed.
    process.env[HEARTBEAT_SESSION_ENV] = 'spark:test-session-nonce-000';
    recordSessionNonce(paths.ctxRoot, 'spark', 'test-session-nonce-000');
    writeHeartbeat();
    expect(borrowedIdentityMarker()).toBeNull();

    await new Promise((r) => setTimeout(r, 2));
    logEvent(paths, 'spark', 'eros-os', 'action', 'session_tick', 'info', undefined, {
      refreshHeartbeat: true,
    });

    const after = JSON.parse(readHeartbeatRaw()) as Heartbeat;
    expect(new Date(after.last_heartbeat).getTime()).toBeGreaterThan(new Date(OLD_TS).getTime());
    // Every other field survives the refresh.
    expect(after.status).toBe('online');
    expect(after.current_task).toBe('crashed-and-being-rolled-back');
    expect(after.mode).toBe('day');
    expect(after.loop_interval).toBe('4h');
  });

  it('DOES move last_heartbeat again once the borrowed-identity marker is cleared', async () => {
    // A refresh now requires the agent-session credential as well. This test
    // asserts the ALLOW direction, so it has to stand where a real agent session
    // stands: inside a PTY-minted session. Before the credential existed this
    // line was unnecessary and the guard was fail-OPEN — absence of a marker was
    // enough. Its absence here is what the fail-closed half changed.
    process.env[HEARTBEAT_SESSION_ENV] = 'spark:test-session-nonce-000';
    recordSessionNonce(paths.ctxRoot, 'spark', 'test-session-nonce-000');
    writeHeartbeat();

    process.env.CTX_SIDE_RUN = '1';
    logEvent(paths, 'spark', 'eros-os', 'action', 'blocked_tick', 'info', undefined, {
      refreshHeartbeat: true,
    });
    expect((JSON.parse(readHeartbeatRaw()) as Heartbeat).last_heartbeat).toBe(OLD_TS);

    delete process.env.CTX_SIDE_RUN;
    await new Promise((r) => setTimeout(r, 2));
    logEvent(paths, 'spark', 'eros-os', 'action', 'allowed_tick', 'info', undefined, {
      refreshHeartbeat: true,
    });
    expect(
      new Date((JSON.parse(readHeartbeatRaw()) as Heartbeat).last_heartbeat).getTime(),
    ).toBeGreaterThan(new Date(OLD_TS).getTime());
  });

  it('leaves the default (no opt-in) path untouched — markers only WITHHOLD, never authorize', () => {
    const raw = writeHeartbeat();
    process.env.CTX_SIDE_RUN = '1';
    logEvent(paths, 'spark', 'eros-os', 'message', 'telegram_received', 'info');
    expect(readHeartbeatRaw()).toBe(raw);
  });

  // ── marker predicate ──────────────────────────────────────────────────────

  describe('borrowedIdentityMarker', () => {
    it('names which marker fired, and returns null when none do', () => {
      expect(borrowedIdentityMarker({})).toBeNull();
      expect(borrowedIdentityMarker({ CTX_SIDE_RUN: '1' })).toBe('CTX_SIDE_RUN');
      expect(borrowedIdentityMarker({ CTX_ON_BEHALF_OF: 'rex' })).toBe('CTX_ON_BEHALF_OF');
    });

    it('does not treat a MISSING CTX_AGENT_NAME as evidence of a borrowed identity', () => {
      // Absence is not evidence. A misconfigured spawn with no agent name is
      // indistinguishable from a side-run by absence alone — which is exactly
      // why cron-side-run-runner.ts sets a positive marker instead.
      expect(borrowedIdentityMarker({ CTX_ORG: 'eros-os' })).toBeNull();
    });

    it('ignores a CTX_SIDE_RUN value other than the exact "1" the spawner sets', () => {
      expect(borrowedIdentityMarker({ CTX_SIDE_RUN: '0' })).toBeNull();
      expect(borrowedIdentityMarker({ CTX_SIDE_RUN: '' })).toBeNull();
    });
  });

  // ── census artifact ───────────────────────────────────────────────────────
  // Proves WHY the guard is needed rather than asserting it on faith: the
  // `delete env.CTX_AGENT_NAME` in cron-side-run-runner.ts does not prevent
  // the bus CLI from re-deriving the very same agent name.

  it('CENSUS: deleting CTX_AGENT_NAME does not stop resolveEnv re-deriving it from the agent dir', () => {
    const projectRoot = join(testDir, 'fw');
    const agentDir = join(projectRoot, 'orgs', 'eros-os', 'agents', 'spark');
    mkdirSync(agentDir, { recursive: true });

    const ctxEnv = {
      instanceId: 'default',
      ctxRoot: testDir,
      frameworkRoot: projectRoot,
      agentName: 'spark',
      org: 'eros-os',
      agentDir,
      projectRoot,
    } as CtxEnv;
    // AgentProcess.start() does exactly this on every boot.
    writeCortextosEnv(agentDir, ctxEnv);

    const cwd = process.cwd();
    const savedName = process.env.CTX_AGENT_NAME;
    try {
      process.chdir(agentDir);
      // Reproduce the side-run child env: CTX_AGENT_NAME deleted, cwd = agentDir.
      delete process.env.CTX_AGENT_NAME;
      const resolved = resolveEnv({ frameworkRoot: projectRoot, projectRoot });
      // The delete is defeated: the identity comes straight back off disk.
      expect(resolved.agentName).toBe('spark');
    } finally {
      process.chdir(cwd);
      if (savedName === undefined) delete process.env.CTX_AGENT_NAME;
      else process.env.CTX_AGENT_NAME = savedName;
    }
  });
});
