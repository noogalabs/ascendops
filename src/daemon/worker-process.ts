import { join } from 'path';
import { mkdirSync } from 'fs';
import type { CtxEnv, WorkerStatus, WorkerStatusValue } from '../types/index.js';
import { AgentPTY } from '../pty/agent-pty.js';
import { injectMessage } from '../pty/inject.js';
import { rawDaemonInjection, renderDaemonInjection } from '../utils/validate.js';

import { clearSessionNonce } from '../bus/heartbeat-session-store.js';
/**
 * WorkerProcess — ephemeral Claude Code session for parallelized tasks.
 *
 * Differences from AgentProcess:
 * - No crash recovery (exit = done, success or failure)
 * - No session timer (workers run until task is complete)
 * - No Telegram integration
 * - No fast-checker or inbox polling
 * - Working directory is the project dir, not the agent dir
 * - Status is exposed for IPC list-workers queries
 */
export class WorkerProcess {
  readonly name: string;
  readonly dir: string;
  readonly parent: string | undefined;

  private pty: AgentPTY | null = null;
  private status: WorkerStatusValue = 'starting';
  private spawnedAt: string;
  private exitCode: number | undefined;
  /** Kept so every exit path can clear the worker's session record, not just spawn(). */
  private ctxRoot: string | null = null;
  /** The nonce THIS lifecycle minted. Only this lifecycle may revoke it. */
  // {generation, nonce}, for the same reason AgentProcess carries one: a bare
  // cached nonce cannot tell its own record from a replacement's, so a late exit
  // from a finished run would revoke a live run's capability, and a run that
  // exits DURING spawn finds the field still holding the previous run's value.
  private mintedSession: { generation: number; nonce: string } | null = null;
  private runGeneration = 0;
  private onDoneCallback: ((name: string, exitCode: number) => void) | null = null;
  private log: (msg: string) => void;

  constructor(
    name: string,
    dir: string,
    parent: string | undefined,
    log?: (msg: string) => void,
  ) {
    this.name = name;
    this.dir = dir;
    this.parent = parent;
    this.spawnedAt = new Date().toISOString();
    this.log = log || ((msg) => console.log(`[worker:${name}] ${msg}`));
  }

  /**
   * Spawn the worker Claude Code session with the given task prompt.
   */
  async spawn(env: CtxEnv, prompt: string, config: { model?: string } = {}): Promise<void> {
    // Ensure bus dirs exist so the worker can use cortextos bus commands
    try {
      mkdirSync(join(env.ctxRoot, 'inbox', this.name), { recursive: true });
      mkdirSync(join(env.ctxRoot, 'state', this.name), { recursive: true });
      mkdirSync(join(env.ctxRoot, 'logs', this.name), { recursive: true });
    } catch { /* ignore */ }

    const logPath = join(env.ctxRoot, 'logs', this.name, 'stdout.log');
    this.pty = new AgentPTY(env, config, logPath);

    this.ctxRoot = env.ctxRoot;

    const myGeneration = ++this.runGeneration;
    this.mintedSession = null;                       // the run boundary, before it can mint
    const runPty = this.pty;
    this.pty.onExit((code) => {
      // PATH 1 and 2 — normal exit and failed exit. A worker runs on an AgentPTY,
      // so it MINTS a session credential like any agent session. Leaving the record
      // behind lets a detached descendant keep a valid credential for a worker that
      // no longer exists.
      //
      // COMPARE before deleting. Clearing by name is a lost update across
      // lifecycles: a delayed exit from THIS worker would delete the record a
      // REPLACEMENT worker has already written, and the replacement — alive —
      // would silently stop refreshing. An exiting lifecycle may revoke only its
      // own capability.
      // Read the nonce off the PTY THAT EXITED, not off a cached field: a run
      // that exits during spawn has already minted, and the field is not set yet.
      this.captureMintedNonce(runPty, myGeneration);
      const revoked = this.clearOwnedSessionRecord(env.ctxRoot, myGeneration, 'PTY exit');
      this.exitCode = code;
      this.status = revoked ? (code === 0 ? 'completed' : 'failed') : 'revoke-failed';
      this.log(`Exited with code ${code} → ${this.status}`);
      if (this.onDoneCallback) {
        this.onDoneCallback(this.name, code);
      }
      this.pty = null;
    });

    try {
      await this.pty.spawn('fresh', prompt);
      // Guarded: PTY doubles in tests need not implement this, and a runtime that
      // never minted has nothing to hand back.
      // From the CAPTURED reference, not the mutable field. There is one call
      // site today and no respawn path, so a concurrent second entry is not
      // reachable — but the field is shared and the local is not, so reading the
      // field here would tag THIS run generation onto the OTHER run nonce the
      // moment that changes. Every other site in this fix already reads runPty;
      // this was the one that did not. (reviewer finding on 36b60b5c.)
      this.captureMintedNonce(runPty, myGeneration);
    } catch (error) {
      // PATH 3 — the spawn itself failed, so onExit never fires and the record
      // written at mint would survive with no process behind it at all. The mint
      // happens inside spawn() before the failure, so read it back off the PTY
      // rather than assuming there is nothing to clear.
      this.captureMintedNonce(runPty, myGeneration);
      const revoked = this.clearOwnedSessionRecord(env.ctxRoot, myGeneration, 'spawn failure');
      this.pty = null;
      this.status = revoked ? 'failed' : 'revoke-failed';
      this.exitCode = -1;
      this.onDoneCallback?.(this.name, -1);
      throw error;
    }
    this.status = 'running';
    this.log(`Running (pid: ${this.pty.getPid()}, dir: ${this.dir})`);
  }

  /** Learn which nonce this run's PTY published. Idempotent within one run. */
  private captureMintedNonce(
    pty: { sessionNonce?: () => string | null } | null | undefined,
    generation: number,
  ): void {
    if (this.mintedSession?.generation === generation) return;
    const nonce = typeof pty?.sessionNonce === 'function' ? pty.sessionNonce() : null;
    this.mintedSession = nonce ? { generation, nonce } : null;
  }

  /**
   * Drop the record THIS run owns. A run that owns nothing — because a later run
   * has replaced the entry — deletes nothing, so a late exit cannot revoke a live
   * replacement's capability.
   */
  private clearOwnedSessionRecord(ctxRoot: string, generation: number, phase: string): boolean {
    if (!this.mintedSession || this.mintedSession.generation !== generation) return true;
    try {
      clearSessionNonce(ctxRoot, this.name, this.mintedSession.nonce);
    } catch (error) {
      // Retain the exact nonce in this worker's tombstone: that tombstone blocks
      // name reuse until its owner-named revoke succeeds. Across daemon restart,
      // boot revocation reconstructs the other half as a name-level quarantine.
      // Worker admission requires BOTH the exact tombstone and boot quarantine
      // clear; success from either gate never overrides refusal from the other.
      // Terminal bookkeeping still completes so the dead worker is visible as
      // revoke-failed rather than incorrectly remaining "running".
      console.error(
        `[worker:${this.name}] SESSION REVOCATION UNKNOWN during ${phase}; `
        + `retaining owned nonce: ${error}`,
      );
      return false;
    }
    this.mintedSession = null;
    return true;
  }

  /** Retry the exact credential retained by a revoke-failed terminal worker. */
  retryRetainedSessionRevocation(): boolean {
    if (this.status !== 'revoke-failed') return true;
    if (!this.ctxRoot) return false;
    const revoked = this.clearOwnedSessionRecord(
      this.ctxRoot,
      this.runGeneration,
      'worker-name reuse admission',
    );
    if (revoked) this.status = this.exitCode === 0 ? 'completed' : 'failed';
    return revoked;
  }

  /**
   * Terminate the worker session.
   */
  async terminate(): Promise<void> {
    if (!this.pty) {
      if (this.status === 'revoke-failed') {
        throw new Error(`SESSION REVOCATION UNKNOWN for worker ${this.name} after explicit termination`);
      }
      return;
    }
    const runPty = this.pty;
    this.log('Terminating...');
    try {
      runPty.write('\x03'); // Ctrl-C
      await sleep(500);
      runPty.kill();
    } catch { /* ignore */ }
    // A synchronous onExit callback already completed bookkeeping, including a
    // possible revoke-failed outcome. Do not overwrite it or notify twice.
    if (!this.pty) {
      if (this.status === 'revoke-failed') {
        throw new Error(`SESSION REVOCATION UNKNOWN for worker ${this.name} after explicit termination`);
      }
      return;
    }
    // PATH 2 — explicit termination. onExit may not fire after a hard kill, so the
    // record is cleared here too; clearing twice is harmless, clearing never is not.
    let revoked = true;
    if (this.ctxRoot) {
      revoked = this.clearOwnedSessionRecord(this.ctxRoot, this.runGeneration, 'explicit termination');
    }
    this.status = revoked ? 'completed' : 'revoke-failed';
    if (!revoked) {
      this.exitCode = -1;
      this.onDoneCallback?.(this.name, -1);
    }
    this.pty = null;
    if (!revoked) {
      throw new Error(`SESSION REVOCATION UNKNOWN for worker ${this.name} after explicit termination`);
    }
  }

  /**
   * Inject text into the worker's PTY (equivalent to tmux send-keys).
   * Use to nudge a stuck worker without restarting it.
   */
  inject(text: string): boolean {
    if (!this.pty || this.status !== 'running') return false;
    injectMessage((data) => this.pty?.write(data), renderDaemonInjection(rawDaemonInjection(text)));
    return true;
  }

  /**
   * Get current worker status snapshot.
   */
  getStatus(): WorkerStatus {
    return {
      name: this.name,
      status: this.status,
      pid: this.pty?.getPid() ?? undefined,
      dir: this.dir,
      parent: this.parent,
      spawnedAt: this.spawnedAt,
      exitCode: this.exitCode,
    };
  }

  isFinished(): boolean {
    return this.status === 'completed' || this.status === 'failed' || this.status === 'revoke-failed';
  }

  /**
   * Register a callback that fires when the worker exits.
   */
  onDone(cb: (name: string, exitCode: number) => void): void {
    this.onDoneCallback = cb;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
