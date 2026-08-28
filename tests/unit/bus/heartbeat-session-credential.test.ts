import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { logEvent } from '../../../src/bus/event';
import { HEARTBEAT_SESSION_ENV, stripReservedSessionCredential } from '../../../src/utils/env';
import { AgentPTY } from '../../../src/pty/agent-pty';
import { HermesPTY } from '../../../src/pty/hermes-pty';
import { OpencodePTY } from '../../../src/pty/opencode-pty';
import type { BusPaths, Heartbeat, CtxEnv, AgentConfig } from '../../../src/types';

import { recordSessionNonce, clearSessionNonce } from '../../../src/bus/heartbeat-session-store';
/**
 * The agent-session credential — the FAIL-CLOSED half of the heartbeat guard.
 *
 * #277 shipped a fail-OPEN guard: borrowed-identity markers can only WITHHOLD a
 * refresh, so a caller carrying no marker refreshes, and every on-behalf path
 * has to remember to set one. Three `execFile` sites that inherit ambient daemon
 * env were filed as FOUND, NOT GUARDED for exactly that reason.
 *
 * This inverts it. A positive credential must be PRESENT, and only a PTY session
 * boundary mints it. Absence means no refresh, so an unenumerated on-behalf path
 * is closed by construction rather than by someone remembering it.
 *
 * FAIL-CLOSED HAS THE OPPOSITE FAILURE MODE, AND IT IS WHY PART A EXISTS. A
 * session runtime that never mints the credential silently stops refreshing, and
 * the stale-heartbeat monitor pages for an agent that is perfectly alive. So the
 * producer census is asserted PER RUNTIME, not per env-builder: Hermes and
 * Opencode are covered today only because they extend AgentPTY without
 * overriding its env construction, and a future override must fail loudly.
 */

const MARKER_VARS = ['CTX_SIDE_RUN', 'CTX_ON_BEHALF_OF'] as const;

type CapturedSpawn = { env?: Record<string, string> };

describe('agent-session credential', () => {
  let testDir: string;
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'cortextos-hb-cred-'));
    saved = {};
    for (const v of [...MARKER_VARS, HEARTBEAT_SESSION_ENV]) {
      saved[v] = process.env[v];
      delete process.env[v];
    }
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    rmSync(testDir, { recursive: true, force: true });
  });

  // ── PART A: producer census — one named test per SESSION RUNTIME ──────────

  function ctxEnv(): CtxEnv {
    const agentDir = join(testDir, 'agent');
    mkdirSync(agentDir, { recursive: true });
    return {
      instanceId: 'default',
      ctxRoot: testDir,
      frameworkRoot: testDir,
      agentName: 'spark',
      org: 'eros-os',
      agentDir,
      projectRoot: testDir,
    } as CtxEnv;
  }

  /** Drive the real spawn() path and capture the env that would reach the child. */
  function writeStaleEnvFile(): void {
    writeFileSync(join(testDir, 'agent', '.env'), `${HEARTBEAT_SESSION_ENV}=stale\nBOT_TOKEN=x\n`);
  }

  async function envFromClaudeFamily(
    make: (env: CtxEnv, config: AgentConfig, logPath: string) => AgentPTY,
    stale = false,
  ): Promise<Record<string, string>> {
    const captured: CapturedSpawn = {};
    const e = ctxEnv();
    if (stale) writeStaleEnvFile();
    const pty = make(e, { name: 'spark' } as AgentConfig, join(testDir, 'stdout.log'));
    (pty as unknown as { spawnFn: unknown }).spawnFn = (
      _cmd: string, _args: string[], opts: { env?: Record<string, string> },
    ) => {
      captured.env = opts.env;
      return { onData() {}, onExit() {}, write() {}, resize() {}, kill() {}, pid: 4242 };
    };
    try { await (pty as unknown as { spawn(): Promise<void> }).spawn(); } catch { /* env captured before any post-spawn work */ }
    if (!captured.env) throw new Error('spawn() never reached the spawn function — the seam moved');
    return captured.env;
  }

  it('PRODUCER claude (AgentPTY) mints the session credential into the child env', async () => {
    const env = await envFromClaudeFamily((e, c, l) => new AgentPTY(e, c, l));
    expect(env[HEARTBEAT_SESSION_ENV]).toMatch(/^spark:\S{16,}$/);
  });

  it('PRODUCER hermes (HermesPTY) mints the session credential into the child env', async () => {
    const env = await envFromClaudeFamily((e, c, l) => new HermesPTY(e, c, l));
    expect(env[HEARTBEAT_SESSION_ENV]).toMatch(/^spark:\S{16,}$/);
  });

  it('PRODUCER opencode (OpencodePTY) mints the session credential into the child env', async () => {
    const env = await envFromClaudeFamily((e, c, l) => new OpencodePTY(e, c, l));
    expect(env[HEARTBEAT_SESSION_ENV]).toMatch(/^spark:\S{16,}$/);
  });

  it('PRODUCER codex-app-server (CodexAppServerPTY) mints the session credential into the child env', async () => {
    const { CodexAppServerPTY } = await import('../../../src/pty/codex-app-server-pty');
    const pty = new CodexAppServerPTY(ctxEnv(), { name: 'spark' } as AgentConfig, join(testDir, 'stdout.log'));
    const env = (pty as unknown as { buildEnv(): Record<string, string> }).buildEnv();
    expect(env[HEARTBEAT_SESSION_ENV]).toMatch(/^spark:\S{16,}$/);
  });

  // ── Two guards, and each family isolates its OWN guard ───────────────────
  //
  // The env-file path is defended TWICE: the loader strips the reserved name,
  // and the mint is the last write. Measured, not assumed: with the mint moved
  // back to construction time the env-file tests still passed, because the strip
  // had already removed the key. They were named for mint-ordering and could only
  // ever kill the strip. So they are named for the strip, and mint-ordering gets
  // its own family below that clobbers through a path the strip does not cover.
  //
  // This is the disarmed-guard shape from the review-lane conventions, produced
  // by the author of that convention within the hour of writing it.

  // ── RESERVED-NAME casualties: config cannot even try ──────────────────────
  //
  // Codex P2 3815567795: the credential was minted at construction time and both
  // env files are Object.assigned over that env afterwards, so an env file
  // defining CTX_HEARTBEAT_SESSION silently replaced the PTY-minted value. Two
  // directions, both real — a stale value stops a healthy agent refreshing, and a
  // configured `1` means the credential is no longer PTY-exclusive, which is the
  // invariant the whole mechanism rests on. Asserted PER RUNTIME through the real
  // spawn path, because the clobbering writer differs per runtime.

  // These assert the STRIP, which means they must observe something only the strip
  // produces. Asserting the final env value cannot do it: mint-last overwrites a
  // poisoned value whether or not the strip ran, so such a test passes with the
  // strip deleted entirely. Sage proved that by neutralising the strip and
  // watching all four survive. The strip's own observable is its warning.

  function reservedWarnings(spy: ReturnType<typeof vi.spyOn>): string[] {
    return spy.mock.calls
      .map(c => String(c[0]))
      .filter(m => m.includes(HEARTBEAT_SESSION_ENV) && m.includes('reserved'));
  }

  it('RESERVED-NAME claude: an agent .env setting the credential is refused by the loader', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const env = await envFromClaudeFamily((e, c, l) => new AgentPTY(e, c, l), true);
      expect(reservedWarnings(warn)).toHaveLength(1);
      expect(env[HEARTBEAT_SESSION_ENV]).toMatch(/^spark:\S{16,}$/);
    } finally { warn.mockRestore(); }
  });

  it('RESERVED-NAME hermes: an agent .env setting the credential is refused by the loader', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await envFromClaudeFamily((e, c, l) => new HermesPTY(e, c, l), true);
      expect(reservedWarnings(warn)).toHaveLength(1);
    } finally { warn.mockRestore(); }
  });

  it('RESERVED-NAME opencode: an agent .env setting the credential is refused by the loader', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await envFromClaudeFamily((e, c, l) => new OpencodePTY(e, c, l), true);
      expect(reservedWarnings(warn)).toHaveLength(1);
    } finally { warn.mockRestore(); }
  });

  it('RESERVED-NAME codex-app-server: an agent .env setting the credential is refused by the loader', async () => {
    const { CodexAppServerPTY } = await import('../../../src/pty/codex-app-server-pty');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const e = ctxEnv();
      writeStaleEnvFile();
      const pty = new CodexAppServerPTY(e, { name: 'spark' } as AgentConfig, join(testDir, 'stdout.log'));
      const env = (pty as unknown as { buildEnv(): Record<string, string> }).buildEnv();
      expect(reservedWarnings(warn)).toHaveLength(1);
      expect(env[HEARTBEAT_SESSION_ENV]).toMatch(/^spark:\S{16,}$/);
    } finally { warn.mockRestore(); }
  });

  // ── MINT-LAST casualties: the mint is the FINAL write ─────────────────────
  //
  // `customizeEnv()` runs after the env files and is NOT covered by the reserved
  // -name strip, so it isolates mint-ordering. OpencodePTY already overrides this
  // hook in production; the subclass below is the same shape a future runtime
  // would take, which is precisely the case that must not silently lose its
  // credential.

  class ClobberingPTY extends AgentPTY {
    protected customizeEnv(env: Record<string, string>): void {
      env[HEARTBEAT_SESSION_ENV] = 'clobbered-by-a-later-writer';
    }
  }

  it('MINT-LAST: a customizeEnv hook that overwrites the credential cannot win', async () => {
    const env = await envFromClaudeFamily((e, c, l) => new ClobberingPTY(e, c, l));
    expect(env[HEARTBEAT_SESSION_ENV]).toMatch(/^spark:\S{16,}$/);
  });

  class DeletingPTY extends AgentPTY {
    protected customizeEnv(env: Record<string, string>): void {
      delete env[HEARTBEAT_SESSION_ENV];
    }
  }

  it('MINT-LAST: a customizeEnv hook that deletes the credential cannot win', async () => {
    const env = await envFromClaudeFamily((e, c, l) => new DeletingPTY(e, c, l));
    expect(env[HEARTBEAT_SESSION_ENV]).toMatch(/^spark:\S{16,}$/);
  });

  it('RESERVED NAME: an env-file load strips the credential rather than passing it through', () => {
    const parsed = { BOT_TOKEN: 'x', [HEARTBEAT_SESSION_ENV]: 'spark:forged-nonce-value' };
    const out = stripReservedSessionCredential('/fake/.env', parsed);
    expect(out).toEqual({ BOT_TOKEN: 'x' });
    // The input is not mutated — callers Object.assign the RESULT.
    expect(parsed[HEARTBEAT_SESSION_ENV]).toBe('spark:forged-nonce-value');
  });

  /**
   * The census is only a census if a NEW runtime cannot arrive unnoticed.
   *
   * This reads the runtime strings out of the production selector in
   * `AgentProcess.start()` and compares them to the literal set the four
   * producer tests above cover. Adding a fifth runtime to that selector without
   * a producer test fails HERE, which is the whole point — a fail-closed
   * credential turns an uncovered runtime into a silently dead heartbeat.
   */
  it('CENSUS: every runtime in the production selector has a producer test', () => {
    const src = readFileSync(join(__dirname, '../../../src/daemon/agent-process.ts'), 'utf-8');
    const found = new Set(
      [...src.matchAll(/this\.config\.runtime === '([a-z-]+)'/g)].map(m => m[1]),
    );
    // The selector's final `else` branch is claude/AgentPTY, which has no string.
    found.add('claude');
    expect([...found].sort()).toEqual(['claude', 'codex-app-server', 'hermes', 'opencode']);
  });

  // ── PART B: the casualty pair on logEvent ─────────────────────────────────

  function busPaths(): BusPaths {
    const p = {
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
    } as BusPaths;
    mkdirSync(p.stateDir, { recursive: true });
    return p;
  }

  const OLD_TS = '2026-04-23T12:00:00Z';

  function writeHeartbeat(paths: BusPaths): string {
    const hb: Heartbeat = {
      agent: 'spark', org: 'eros-os', status: 'online',
      current_task: 'x', mode: 'day', last_heartbeat: OLD_TS, loop_interval: '4h',
    };
    const raw = JSON.stringify(hb);
    writeFileSync(join(paths.stateDir, 'heartbeat.json'), raw);
    return raw;
  }

  function eventLines(paths: BusPaths): string[] {
    const today = new Date().toISOString().split('T')[0];
    const f = join(paths.analyticsDir, 'events', 'spark', `${today}.jsonl`);
    return existsSync(f) ? readFileSync(f, 'utf-8').trim().split('\n').filter(Boolean) : [];
  }

  it('CASUALTY: an on-behalf write WITHOUT the credential records the event and does NOT refresh', () => {
    const paths = busPaths();
    const raw = writeHeartbeat(paths);
    // No credential, and no borrowed-identity marker either — this is the path
    // #277 could not close: an execFile inheriting ambient daemon env.
    logEvent(paths, 'spark', 'eros-os', 'action', 'ambient_env_write', 'info', undefined, {
      refreshHeartbeat: true,
    });
    expect(readFileSync(join(paths.stateDir, 'heartbeat.json'), 'utf-8')).toBe(raw);
    // Withholding liveness must never drop the audit record.
    expect(eventLines(paths)).toHaveLength(1);
    expect(JSON.parse(eventLines(paths)[0]).event).toBe('ambient_env_write');
  });

  it('MIRROR: a real agent session WITH the credential DOES refresh', () => {
    const paths = busPaths();
    const raw = writeHeartbeat(paths);
    process.env[HEARTBEAT_SESSION_ENV] = 'spark:test-session-nonce-000';
    recordSessionNonce(paths.ctxRoot, 'spark', 'test-session-nonce-000');
    logEvent(paths, 'spark', 'eros-os', 'heartbeat', 'heartbeat', 'info', undefined, {
      refreshHeartbeat: true,
    });
    const after = readFileSync(join(paths.stateDir, 'heartbeat.json'), 'utf-8');
    expect(after).not.toBe(raw);
    expect((JSON.parse(after) as Heartbeat).last_heartbeat).not.toBe(OLD_TS);
  });

  // ── The credential is a CAPABILITY, not a flag ────────────────────────────
  //
  // Codex P2 on ad75c321: a presence flag says "some session minted this" and
  // cannot say WHICH. A PTY child that changes CTX_AGENT_NAME — or exports
  // BUS_AGENT, as bin/quota-resume.sh does — keeps the flag and can then claim
  // liveness for the agent it borrowed. Binding the minted agent into the value
  // makes the credential authorise a refresh for exactly one agent.

  it('BORROWED IDENTITY: a credential minted for alpha does not refresh beta', () => {
    const paths = busPaths();
    const raw = writeHeartbeat(paths);
    process.env[HEARTBEAT_SESSION_ENV] = 'alpha:minted-for-alpha-000000';
    logEvent(paths, 'spark', 'eros-os', 'action', 'borrowed_name_write', 'info', undefined, {
      refreshHeartbeat: true,
    });
    expect(readFileSync(join(paths.stateDir, 'heartbeat.json'), 'utf-8')).toBe(raw);
    expect(eventLines(paths)).toHaveLength(1);
  });

  it('BORROWED IDENTITY MIRROR: the agent the credential was minted for DOES refresh', () => {
    const paths = busPaths();
    const raw = writeHeartbeat(paths);
    process.env[HEARTBEAT_SESSION_ENV] = 'spark:minted-for-spark-000000';
    recordSessionNonce(paths.ctxRoot, 'spark', 'minted-for-spark-000000');
    logEvent(paths, 'spark', 'eros-os', 'heartbeat', 'heartbeat', 'info', undefined, {
      refreshHeartbeat: true,
    });
    expect(readFileSync(join(paths.stateDir, 'heartbeat.json'), 'utf-8')).not.toBe(raw);
  });

  it('a malformed credential is not a match — no separator, empty agent, or short nonce', () => {
    const paths = busPaths();
    for (const bad of ['spark', ':nonce-value-long-enough', 'spark:short']) {
      const raw = writeHeartbeat(paths);
      process.env[HEARTBEAT_SESSION_ENV] = bad;
      logEvent(paths, 'spark', 'eros-os', 'action', 'malformed_credential', 'info', undefined, {
        refreshHeartbeat: true,
      });
      expect(readFileSync(join(paths.stateDir, 'heartbeat.json'), 'utf-8')).toBe(raw);
    }
  });

  it('FORGED NONCE: a well-formed credential with no daemon record does not refresh', () => {
    const paths = busPaths();
    const raw = writeHeartbeat(paths);
    // Shape-valid and never minted: this is what a shape-only check accepted.
    process.env[HEARTBEAT_SESSION_ENV] = 'spark:0000000000000000';
    logEvent(paths, 'spark', 'eros-os', 'action', 'forged_nonce', 'info', undefined, {
      refreshHeartbeat: true,
    });
    expect(readFileSync(join(paths.stateDir, 'heartbeat.json'), 'utf-8')).toBe(raw);
    expect(eventLines(paths)).toHaveLength(1);
  });

  it('STALE SESSION: a credential whose session has ended does not refresh', () => {
    const paths = busPaths();
    process.env[HEARTBEAT_SESSION_ENV] = 'spark:minted-then-ended-00000';
    recordSessionNonce(paths.ctxRoot, 'spark', 'minted-then-ended-00000');
    // …the session ends. The env still carries the credential; the record does not.
    clearSessionNonce(paths.ctxRoot, 'spark', 'minted-then-ended-00000');
    const raw = writeHeartbeat(paths);
    logEvent(paths, 'spark', 'eros-os', 'action', 'after_session_end', 'info', undefined, {
      refreshHeartbeat: true,
    });
    expect(readFileSync(join(paths.stateDir, 'heartbeat.json'), 'utf-8')).toBe(raw);
  });

  it('WRONG NONCE: a credential from a previous session of the same agent does not refresh', () => {
    const paths = busPaths();
    const raw = writeHeartbeat(paths);
    recordSessionNonce(paths.ctxRoot, 'spark', 'the-current-session-nonce');
    process.env[HEARTBEAT_SESSION_ENV] = 'spark:a-previous-session-nonce';
    logEvent(paths, 'spark', 'eros-os', 'action', 'previous_session', 'info', undefined, {
      refreshHeartbeat: true,
    });
    expect(readFileSync(join(paths.stateDir, 'heartbeat.json'), 'utf-8')).toBe(raw);
  });

  it('BELT: the credential does NOT override a borrowed-identity marker', () => {
    const paths = busPaths();
    const raw = writeHeartbeat(paths);
    process.env[HEARTBEAT_SESSION_ENV] = 'spark:test-session-nonce-000';
    recordSessionNonce(paths.ctxRoot, 'spark', 'test-session-nonce-000');
    process.env.CTX_ON_BEHALF_OF = 'spark';
    logEvent(paths, 'spark', 'eros-os', 'error', 'watchdog_rollback_preflight', 'error', undefined, {
      refreshHeartbeat: true,
    });
    expect(readFileSync(join(paths.stateDir, 'heartbeat.json'), 'utf-8')).toBe(raw);
  });

  it('the credential is not satisfied by an arbitrary truthy value', () => {
    const paths = busPaths();
    const raw = writeHeartbeat(paths);
    process.env[HEARTBEAT_SESSION_ENV] = 'yes';  // presence-shaped, no agent binding
    logEvent(paths, 'spark', 'eros-os', 'action', 'forged_credential', 'info', undefined, {
      refreshHeartbeat: true,
    });
    expect(readFileSync(join(paths.stateDir, 'heartbeat.json'), 'utf-8')).toBe(raw);
  });
});
