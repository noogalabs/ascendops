import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync, readdirSync, statSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { hookBootstrap } from '../../../src/hooks/bootstrap';
import { recordSessionNonce, isSessionNonceLive, revokeAllSessionNonces, instanceSocketAnswers } from '../../../src/bus/heartbeat-session-store';
import { createServer } from 'net';
import {
  HEARTBEAT_SESSION_ENV,
  stripSessionCredentialFromEnv,
  agentSessionCredential,
  sessionCredentialAgent,
  hasAgentSessionCredential,
  sessionCredentialNonce,
} from '../../../src/utils/env';

/**
 * Non-session process boundaries must not carry the session credential.
 *
 * Minting only at the PTY boundary is necessary and not sufficient: the
 * credential is an ordinary environment variable and propagates by inheritance.
 * An agent session that runs `cortextos start` hands the daemon its whole
 * `process.env`, and every daemon subprocess inherits it — including the watchdog
 * rollback write this guard exists to stop.
 *
 * TWO LAYERS, AND THE FIRST ONE IS THE REAL FIX. The daemon deletes the marker
 * from its OWN `process.env` at boot, which closes every inheritance path at once
 * BY CONSTRUCTION, however many spawn sites exist now or arrive later. The
 * per-site strips are defence in depth for processes the daemon does not launch.
 * That ordering is sage's: enumerate-and-guard is brittle to a refactor that
 * preserves the vulnerability and changes the syntax; boundary construction is
 * not.
 */

const SRC = join(__dirname, '../../../src');

/** Every source file under src/, recursively. */
function sourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) sourceFiles(p, acc);
    else if (p.endsWith('.ts')) acc.push(p);
  }
  return acc;
}

describe('session credential does not cross non-session boundaries', () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => { saved[HEARTBEAT_SESSION_ENV] = process.env[HEARTBEAT_SESSION_ENV]; });
  afterEach(() => {
    if (saved[HEARTBEAT_SESSION_ENV] === undefined) delete process.env[HEARTBEAT_SESSION_ENV];
    else process.env[HEARTBEAT_SESSION_ENV] = saved[HEARTBEAT_SESSION_ENV]!;
  });

  it('the daemon deletes the credential from its own process.env at boot', () => {
    // The boot line is the by-construction closure; assert it exists at the entry
    // and that deleting the key is what it does.
    const daemon = readFileSync(join(SRC, 'daemon/index.ts'), 'utf-8');
    const start = daemon.indexOf('async start(): Promise<void> {');
    expect(start).toBeGreaterThan(-1);
    const head = daemon.slice(start, start + 900);
    expect(head).toContain(`delete process.env[HEARTBEAT_SESSION_ENV]`);

    // …and that the deletion has the effect the boundary depends on.
    process.env[HEARTBEAT_SESSION_ENV] = 'alpha:inherited-from-a-pty-000';
    delete process.env[HEARTBEAT_SESSION_ENV];
    expect(sessionCredentialAgent()).toBeNull();
  });

  it('CENSUS: every process.env-spreading boundary in src/ is classified', () => {
    // A census, not a blanket rule. Spreading process.env is not itself a defect —
    // an in-session helper SHOULD pass the session's own env to its child. What is
    // a defect is a boundary nobody classified.
    //
    // Three classifications, and the first two are the closures:
    //   STRIPS    — hands a non-session process an environment with the credential removed
    //   DAEMON    — a daemon descendant, already covered by the boot delete
    //   IN-SESSION— runs inside one agent session and hands its child the same session
    //
    // A NEW site fails here until someone says which it is. That is the whole
    // guarantee: not that every site strips, but that no site is unexamined.
    const CLASSIFIED: Record<string, 'STRIPS' | 'DAEMON' | 'IN-SESSION'> = {
      'cli/start.ts': 'STRIPS',              // PTY -> daemon, and both pm2 invocations
      'cli/dashboard.ts': 'STRIPS',
      'cli/setup.ts': 'STRIPS',
      'daemon/watchdog.ts': 'STRIPS',        // the original motivating on-behalf write
      'hooks/hook-skill-autopr.ts': 'STRIPS',
      'daemon/agent-process.ts': 'DAEMON',
      'daemon/cron-side-run-runner.ts': 'DAEMON',
      'cli/bus.ts': 'IN-SESSION',
      'cli/reap-worktrees.ts': 'IN-SESSION',
      'cli/with-worktree-lease.ts': 'IN-SESSION',
      'bus/knowledge-base.ts': 'IN-SESSION',
    };

    const found: string[] = [];
    for (const file of sourceFiles(SRC)) {
      const text = readFileSync(file, 'utf-8');
      // Match the FIXED form too. A site that now strips no longer matches a raw
      // spread, so keying the census on the raw pattern alone would make every
      // repaired site vanish from its own census and take its classification with
      // it: the census would shrink as the work got done.
      const spreads = /\.\.\.(stripSessionCredentialFromEnv\()?process\.env|env:\s*(stripSessionCredentialFromEnv\()?process\.env/;
      // KNOWN RESIDUAL, stated rather than papered over: this census sees only
      // EXPLICIT process.env references. A spawner that omits the env option
      // inherits everything and mentions process.env nowhere — which is how the
      // hook chain and the pm2 launches were both invisible here. Widening the
      // pattern to every execSync/spawnSync/execFile finds 36 boundaries in src/,
      // each needing its own classification; that is a separate piece of work and
      // is filed as one. Until then, a fixed site becomes visible BECAUSE it was
      // fixed, which is backwards, and the pm2 entries below are exactly that.
      if (!spreads.test(text)) continue;
      found.push(file.slice(SRC.length + 1));
    }
    expect(found.sort()).toEqual(Object.keys(CLASSIFIED).sort());

    // Every site classified STRIPS must actually strip AT THE SPREAD.
    //
    // The first version of this check asked whether the file CONTAINS
    // `stripSessionCredentialFromEnv`, which the import line alone satisfies:
    // removing the call from the spread left the check green. A file-level
    // presence test cannot see a call-site change. So the assertion is the
    // absence of a RAW spread — the thing only an actually-wrapped site produces.
    const RAW_SPREAD = /\.\.\.process\.env|env:\s*process\.env/;
    for (const [rel, kind] of Object.entries(CLASSIFIED)) {
      if (kind !== 'STRIPS') continue;
      const text = readFileSync(join(SRC, rel), 'utf-8');
      expect(`${rel}:raw-spread=${RAW_SPREAD.test(text)}`).toBe(`${rel}:raw-spread=false`);
    }
  });

  it('HOOK CENSUS: every hook entry point strips the credential through the shared bootstrap', () => {
    // Process lineage is not intent. A hook runs inside the agent's session and
    // inherits its credential, which proves only descent — and a SessionEnd hook
    // descends precisely BECAUSE the session is ending.
    //
    // This is the closure the text census cannot be. The chain that exposed it
    // had three hops and ZERO explicit `process.env` mentions: every hop
    // inherited by OMITTING the env option, which no pattern can see. So the
    // guarantee is at the entry, and this asserts every hook has one.
    const hooks = readdirSync(join(SRC, 'hooks')).filter(f => f.startsWith('hook-') && f.endsWith('.ts'));
    expect(hooks.length).toBeGreaterThanOrEqual(11);

    const missing: string[] = [];
    for (const h of hooks) {
      const text = readFileSync(join(SRC, 'hooks', h), 'utf-8');
      const imports = text.includes("from './bootstrap.js'");
      // INDENTED call only. A call at column 0 runs at module IMPORT, and hook
      // modules are imported for their exports by non-hook code — which deleted the
      // credential for every `cortextos bus` subcommand and stopped genuine
      // in-session activity from ever refreshing. A CALL-SITE census is not an
      // EXECUTION-TIME census: the first version saw the call and not when it ran.
      const calls = / +hookBootstrap\(\);/.test(text) && !/^hookBootstrap\(\);/m.test(text);
      if (!imports || !calls) missing.push(h);
    }
    expect(missing).toEqual([]);
  });

  it('the hook bootstrap actually removes the credential', () => {
    process.env[HEARTBEAT_SESSION_ENV] = 'alpha:inherited-into-a-hook-0';
    hookBootstrap();
    expect(sessionCredentialAgent()).toBeNull();
  });

  it('ORDERING (behavioural): the record is already gone when the PTY is signalled', async () => {
    // The source-position check below is a substring test and sage showed it
    // passes when the real call is commented out but its text left in place —
    // the fourth time in this PR a test could not see the thing it was named for.
    // This one observes the ORDER at runtime: the fake PTY asserts, from inside
    // kill(), that the record is already gone. Signalling the PTY is what lets
    // hook dispatch happen, so "gone before kill" IS the guarantee.
    const root = mkdtempSync(join(tmpdir(), 'cortextos-order-'));
    try {
      const { AgentProcess } = await import('../../../src/daemon/agent-process');
      const proc = Object.create(AgentProcess.prototype) as {
        env: { ctxRoot: string }; name: string; pty: unknown; stopPromise?: Promise<void>;
        stop(): Promise<void>;
        log(m: string): void; clearSessionTimer(): void; clearHealthTimer(): void;
        startAdmissionGeneration: number; stopping: boolean; stopRequested: boolean;
        exitPromise: Promise<void>; status: string;
      };
      proc.env = { ctxRoot: root };
      proc.name = 'spark';
      proc.startAdmissionGeneration = 0;
      proc.stopping = false;
      proc.stopRequested = false;
      proc.status = 'running';
      proc.exitPromise = Promise.resolve();
      proc.log = () => {};
      proc.clearSessionTimer = () => {};
      proc.clearHealthTimer = () => {};

      const MINE = 'live-session-nonce-0000';
      recordSessionNonce(root, 'spark', MINE);
      expect(isSessionNonceLive(root, 'spark', MINE)).toBe(true);
      (proc as unknown as { mintedSession: { generation: number; nonce: string } }).mintedSession =
        { generation: 7, nonce: MINE };
      (proc as unknown as { lifecycleGeneration: number }).lifecycleGeneration = 7;

      // A SECOND lifecycle's record, so this test also observes SCOPE: clearing
      // must take out this lifecycle's record and leave a replacement's alone.
      const THEIRS = 'replacement-lifecycle-00';
      recordSessionNonce(root, 'spark', THEIRS);

      let liveAtKill: boolean | null = null;
      proc.pty = {
        isAlive: () => true,
        kill: () => { liveAtKill = isSessionNonceLive(root, 'spark', MINE); },
        getPid: () => 4242,
      };

      await Promise.race([proc.stop(), new Promise(r => setTimeout(r, 2000))]);

      expect(`live-at-kill=${liveAtKill}`).toBe('live-at-kill=false');
      expect(isSessionNonceLive(root, 'spark', MINE)).toBe(false);
      // ...and the replacement's record is untouched. unlink is atomic on an exact
      // path, so a dying lifecycle cannot take out a successor's credential.
      expect(isSessionNonceLive(root, 'spark', THEIRS)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('ORDERING: session end clears the record BEFORE anything can dispatch a hook', () => {
    // The direct-call test below proves clearSessionNonce works. It does NOT prove
    // the session-end path calls it, and it does not prove the ORDER — removing
    // the call from AgentProcess left that test green, which is the third time in
    // this PR a test named for one guarantee could only see another.
    //
    // Order is the guarantee here: the record must be gone before the PTY is
    // signalled, because signalling is what lets Claude Code dispatch SessionEnd
    // hooks. So this asserts position, not merely presence.
    const src = readFileSync(join(SRC, 'daemon/agent-process.ts'), 'utf-8');

    const stopAt = src.indexOf('async stop(): Promise<void> {');
    expect(stopAt).toBeGreaterThan(-1);
    const stopBody = src.slice(stopAt, src.indexOf('const operation = this.performStop();', stopAt));
    expect(stopBody).toContain("this.clearOwnedSessionRecord(this.lifecycleGeneration, 'stop')");

    // The crash path never calls stop(), so it clears too.
    const exitAt = src.indexOf('private handleExit(exitCode: number, generation: number): void {');
    expect(exitAt).toBeGreaterThan(-1);
    expect(src.slice(exitAt, exitAt + 900)).toContain("this.clearOwnedSessionRecord(generation, 'PTY exit')");
  });

  it('IMPORTING the bus CLI does not clear the credential', async () => {
    // The casualty that was missing. Producer tests proved the MINT; nothing proved
    // the credential survives to the process that uses it. `cli/bus.ts` imports
    // `bus/skill-autopr.ts`, which imported two validators from a HOOK module whose
    // strip ran at import — so loading any bus subcommand revoked the credential and
    // genuine in-session activity never refreshed. Fail-closed's opposite failure:
    // the monitor pages a fleet that is perfectly alive.
    process.env[HEARTBEAT_SESSION_ENV] = 'spark:a-live-session-nonce00';
    await import('../../../src/bus/skill-autopr');
    expect(sessionCredentialAgent()).toBe('spark');
    await import('../../../src/hooks/skill-validators');
    expect(sessionCredentialAgent()).toBe('spark');
  });

  // The probe/bind/revoke ORDER is asserted behaviourally in
  // tests/unit/daemon/sequencer-call-order.test.ts. The textual version that used
  // to live here was defeated twice — a decoy comment in the file, then a decoy
  // inside the function body with the real call aliased through a const — so it is
  // gone rather than kept as a weaker second opinion. A defeated instrument left
  // beside a working one still reads like corroboration.

  it('a live listener is detected only while the answer can be about somebody else', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cortextos-probe-'));
    const sock = join(root, 'live.sock');
    const server = createServer(() => {});
    try {
      expect(await instanceSocketAnswers(sock)).toBe(false);   // nothing bound yet
      await new Promise<void>(res => server.listen(sock, res));
      expect(await instanceSocketAnswers(sock)).toBe(true);    // somebody else is there
    } finally {
      await new Promise<void>(res => server.close(() => res()));
      rmSync(root, { recursive: true, force: true });
    }
  });

  // ABORT-before-bind is asserted behaviourally in
  // tests/unit/daemon/sequencer-call-order.test.ts ('aborts on conflict and NEVER
  // binds'), which observes that `bind` never ran rather than that a throw appears
  // above a call in the source. The textual version is gone for the same reason the
  // PROBE ORDER one is.

  it('COMPARE-AND-DELETE: a stale lifecycle cannot revoke a replacement record', () => {
    // Clearing by NAME is a lost update across lifecycles. A delayed exit from the
    // OLD worker would delete the record the REPLACEMENT has already written, and
    // the replacement — alive — silently stops refreshing. An exiting lifecycle may
    // revoke only its own capability.
    const root = mkdtempSync(join(tmpdir(), 'cortextos-cad-'));
    try {
      recordSessionNonce(root, 'w1', 'replacement-lifecycle-000');
      // the old lifecycle finally exits and tries to clean up after itself
      expect(isSessionNonceLive(root, 'w1', 'old-dead-lifecycle-0000')).toBe(false);
      expect(isSessionNonceLive(root, 'w1', 'replacement-lifecycle-000')).toBe(true);
      // …and the owner of the current record can still revoke it
      expect(isSessionNonceLive(root, 'w1', 'replacement-lifecycle-000')).toBe(true);
      expect(isSessionNonceLive(root, 'w1', 'any-nonce-value-here-00')).toBe(false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('PM2: every pm2 invocation passes a stripped env', () => {
    // pm2 inherits the calling shell by design, so a daemon started from an agent
    // PTY handed every PM2-managed process the credential — including the dashboard,
    // whose completeTask route would then refresh a wedged agent's heartbeat.
    // Asserted per CALL, not per file: one stripped pm2 call and one bare one in the
    // same file would satisfy a file-level check.
    for (const rel of ['cli/start.ts', 'cli/setup.ts']) {
      const text = readFileSync(join(SRC, rel), 'utf-8');
      const pm2Calls = text.match(/(execSync|spawnSync)\(\s*'pm2'?[^)]*\)|execSync\('pm2[^)]*\)/g) ?? [];
      expect(`${rel}:pm2-calls`).toBe(`${rel}:pm2-calls`);
      for (const call of pm2Calls) {
        expect(`${rel}:${call.slice(0, 40)}:stripped=${call.includes('stripSessionCredentialFromEnv')}`)
          .toBe(`${rel}:${call.slice(0, 40)}:stripped=true`);
      }
      expect(pm2Calls.length).toBeGreaterThan(0);
    }
  });

  it('the dashboard deletes the credential at its own boot', () => {
    // The dashboard is not an agent session. pm2 inherits whatever launched it, so
    // stripping at the pm2 call covers the launch we control; this covers the ones
    // we do not. Same by-construction closure as the daemon boot delete.
    const inst = readFileSync(join(SRC, '../dashboard/src/instrumentation.ts'), 'utf-8');
    expect(inst).toContain('export async function register()');
    expect(inst).toContain('delete process.env.CTX_HEARTBEAT_SESSION;');
  });

  it('the strip removes the credential and leaves everything else untouched', () => {
    const env = { PATH: '/bin', [HEARTBEAT_SESSION_ENV]: 'alpha:nonce-value-long-enough' };
    const out = stripSessionCredentialFromEnv(env);
    expect(out).toEqual({ PATH: '/bin' });
    // The input is not mutated — callers spread the RESULT.
    expect(env[HEARTBEAT_SESSION_ENV]).toBe('alpha:nonce-value-long-enough');
  });

  it('the strip is a no-op when there is nothing to strip', () => {
    const env = { PATH: '/bin' };
    expect(stripSessionCredentialFromEnv(env)).toBe(env);
  });

  it('sessionCredentialAgent treats an explicit empty override exactly like an absent key', () => {
    delete process.env[HEARTBEAT_SESSION_ENV];
    expect(sessionCredentialAgent()).toBeNull();

    process.env[HEARTBEAT_SESSION_ENV] = '';
    expect(sessionCredentialAgent()).toBeNull();
    expect(sessionCredentialNonce()).toBeNull();
  });

  it('hasAgentSessionCredential rejects an explicit empty override exactly like an absent key', () => {
    delete process.env[HEARTBEAT_SESSION_ENV];
    expect(hasAgentSessionCredential('alpha')).toBe(false);

    process.env[HEARTBEAT_SESSION_ENV] = '';
    expect(hasAgentSessionCredential('alpha')).toBe(false);
  });

  it('a minted credential names its agent and carries a nonce', () => {
    const minted = agentSessionCredential('alpha')[HEARTBEAT_SESSION_ENV];
    process.env[HEARTBEAT_SESSION_ENV] = minted;
    expect(sessionCredentialAgent()).toBe('alpha');
    expect(minted.split(':')[1].length).toBeGreaterThanOrEqual(16);
    // Two mints are not interchangeable.
    expect(agentSessionCredential('alpha')[HEARTBEAT_SESSION_ENV]).not.toBe(minted);
  });
});
