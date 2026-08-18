import { appendFileSync, existsSync, readFileSync, unlinkSync, writeFileSync } from 'fs';
import { isAbsolute, join } from 'path';
import { homedir } from 'os';
import { randomBytes, randomUUID } from 'crypto';
import { createServer, createConnection } from 'net';
import type { AgentConfig, CtxEnv } from '../types/index.js';
import { OutputBuffer } from './output-buffer.js';
import type { TelegramAPI } from '../telegram/api.js';
import { ensureDir, atomicWriteSync } from '../utils/atomic.js';
import { resolvePaths } from '../utils/paths.js';
import { logEvent } from '../bus/event.js';
import { WsUnixJsonRpcClient, type JsonRpcResponse } from '../utils/ws-unix-client.js';
import { sanitizeForInjection } from './inject.js';
import { parseEnvFile } from '../utils/env.js';
import { CodexTurnCustodyStore, type CustodiedTurn } from './codex-turn-custody.js';
import { prepareNodePtySpawn } from './node-pty-loader.js';

interface IPty {
  pid: number;
  write(data: string): void;
  onData(callback: (data: string) => void): { dispose(): void };
  onExit(callback: (e: { exitCode: number; signal?: number }) => void): { dispose(): void };
  kill(signal?: string): void;
}

interface IPtySpawnOptions {
  name?: string;
  cols?: number;
  rows?: number;
  cwd?: string;
  env?: Record<string, string>;
}

type SpawnFn = (file: string, args: string[], options: IPtySpawnOptions) => IPty;

interface ThreadState {
  threadId: string;
  cwd: string;
  updatedAt: string;
}

interface ModelGateAlertState {
  status?: 'cleared';
  configured_model: string;
  used_model: string;
  alerted_at: string;
  cleared_at?: string;
}

interface SocketPointer {
  socketPath?: string;
  host?: string;
  port?: number;
  fallback: boolean;
  reason?: string;
  updatedAt: string;
}

interface ThreadResponse {
  thread: {
    id: string;
    status?: unknown;
  };
}

interface SkillsListResponse {
  data?: Array<{
    cwd: string;
    skills: Array<{
      name: string;
      path: string;
      scope?: string;
      enabled?: boolean;
    }>;
  }>;
}

interface GoalResponse {
  goal: {
    objective?: string | null;
    status?: string | null;
  } | null;
}

export interface CodexTurnRouting {
  model: string;
  source: 'daemon-cron';
  cronName: string;
  reason: string;
  skillName?: string;
  requestedModel?: string;
  effort?: string;
}

interface QueuedTurnPayload {
  input: unknown[];
  deferredSkill?: string;
  routing?: CodexTurnRouting;
  cronSequence?: CronSequenceTransition;
}

interface QueuedTurn extends QueuedTurnPayload {
  workItemId: string;
  recoveredTurnId?: string;
}

type CronSequenceFailureStage = 'start_rejected' | 'active_turn_error' | 'completion_timeout';

interface CronSequenceTransition {
  id: string;
  continuation: QueuedTurnPayload;
  fallbackPrompt: string;
  fallbackRouting: CodexTurnRouting;
}

type RemoteTurnStatus = 'completed' | 'interrupted' | 'failed' | 'inProgress';

interface RemoteTurn {
  id: string;
  status: RemoteTurnStatus;
  items: unknown[];
}

type RemoteTurnLookup =
  | { kind: 'found'; turn: RemoteTurn }
  | { kind: 'absent' };

type ReconciledTurn =
  | { kind: 'terminal'; status: Exclude<RemoteTurnStatus, 'inProgress'> }
  | { kind: 'inProgress'; turnId: string }
  | { kind: 'absent' };

class TurnCustodyBlockedError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(cause === undefined
      ? message
      : `${message}: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = 'TurnCustodyBlockedError';
  }
}

class TurnRunError extends Error {
  constructor(
    readonly stage: CronSequenceFailureStage,
    cause: unknown,
  ) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = 'TurnRunError';
  }
}

interface EffectiveTurnRouting {
  model: string;
  routing?: CodexTurnRouting;
}

interface TurnEventIdentity {
  turnId: string | null;
  valid: boolean;
}

function readTurnEventIdentity(params: Record<string, unknown>): TurnEventIdentity {
  const topLevel = typeof params.turnId === 'string' ? params.turnId : null;
  const nestedTurn = isRecord(params.turn) ? params.turn : null;
  const nested = nestedTurn && typeof nestedTurn.id === 'string' ? nestedTurn.id : null;
  if (topLevel && nested && topLevel !== nested) {
    return { turnId: null, valid: false };
  }
  return { turnId: topLevel ?? nested, valid: true };
}

const THREAD_PERMISSION_OVERRIDES = {
  approvalPolicy: 'never',
  sandbox: 'danger-full-access',
} as const;

const TURN_PERMISSION_OVERRIDES = {
  approvalPolicy: 'never',
  sandboxPolicy: { type: 'dangerFullAccess' },
} as const;

// Codex model entitlement guard. gpt-5.3-codex (and -spark) are chatgpt-auth-
// unsafe: the codex-app-server ChatGPT account is not entitled to them, so a
// turn on that model 400s every time (willRetry:false). The codex-app-server
// protocol takes `model` as a TOP-LEVEL field on thread/start, thread/resume
// AND turn/start; when it is null/omitted the CLI picks its OWN default, which
// on codex-cli 0.130.0 is gpt-5.3-codex — the exact failure that took an agent
// down 2026-06-04 (every turn 400). We therefore ALWAYS send an explicit,
// allowlisted model on every thread/turn request (never null). Mirrors the
// hermes codex adapter's SAFE_MODELS gate for the app-server path.
//
// ENTITLEMENT NOTE (2026-07-15, proven by isolated codex-cli 0.145.0-alpha.15
// smoke): gpt-5.6-sol is entitled on this account after upgrading the Codex CLI.
// Keep gpt-5.5 as the DEFAULT because it is the known-safe fallback. Sol should
// be selected explicitly per agent only after the upgraded app-server binary is
// installed and the agent is restarted and verified from startup logs.
const SAFE_MODELS: readonly string[] = [
  'gpt-5.5',
  'gpt-5-codex',
  'gpt-5.6-sol',
  'gpt-5.6-lun',
  'gpt-5.6-terra',
];
const DEFAULT_SAFE_MODEL = 'gpt-5.5';

/**
 * Resolve the model to send on a codex-app-server thread/turn request.
 * Returns the configured model only if it is on the entitlement allowlist;
 * otherwise falls back to DEFAULT_SAFE_MODEL. NEVER returns null/undefined —
 * an absent model lets the CLI pick its own (unsafe) default, which is the bug
 * this guard exists to prevent.
 */
export function resolveSafeModel(configured: string | undefined): string {
  if (configured && SAFE_MODELS.includes(configured)) {
    return configured;
  }
  return DEFAULT_SAFE_MODEL;
}

const SOCKET_BASENAME = 'codex.sock';
const SOCKET_PATH_WARN_BYTES = 100;
const BOOTSTRAP_PATTERN = '[codex-app-server] ready';

const SLASH_REWRITE_RE = /^\/([a-z][a-z0-9_-]*)(?:\s+([\s\S]*))?$/i;
const LOCAL_SLASH_COMMANDS = new Set(['goal']);

/**
 * Codex app-server PTY adapter for cortextOS.
 *
 * Uses a persistent `codex app-server` process and speaks JSON-RPC over the
 * app-server's WebSocket-framed Unix socket transport. The approved default
 * socket is `$CTX_ROOT/state/<agent>/codex.sock`; if that resolved path is
 * longer than the conservative 100-byte Unix socket threshold, the adapter
 * falls back to `/tmp/cas-<short-uuid>.sock` and writes a state-dir pointer.
 */
export class CodexAppServerPTY {
  private _alive = false;
  private _executing = false;
  private _activeTurnId: string | null = null;
  private _activeWorkItemId: string | null = null;
  private _writeBuffer = '';
  private _turnQueue: QueuedTurn[] = [];
  private _turnCustodyBlocked = false;
  private _restoringTurnCustody = false;
  private _startingTurnRouting: EffectiveTurnRouting | null = null;
  private _turnRoutingById = new Map<string, EffectiveTurnRouting>();
  private _turnCompletion: {
    resolve: (status: RemoteTurnStatus) => void;
    reject: (err: Error) => void;
    timer: ReturnType<typeof setTimeout>;
    turnId: string | null;
    workItemId: string;
  } | null = null;
  private _turnCompletionTimeoutMs = 30 * 60 * 1000;
  private _turnReconcileDelayMs = 1000;
  private _turnReconcilePolls = 3;
  private _retiredTurnIds = new Set<string>();
  private _spawnFn: SpawnFn | null = null;
  private _prepareSpawnFn: (cachedSpawn: SpawnFn | null) => SpawnFn = prepareNodePtySpawn;
  private _appServerPty: IPty | null = null;
  private _rpc: WsUnixJsonRpcClient | null = null;
  private _rpcMessageUnsubscribe: (() => void) | null = null;
  private _rpcDisconnectUnsubscribe: (() => void) | null = null;
  private _pidPollTimer: ReturnType<typeof setInterval> | null = null;
  private _exitFinalized = false;
  private _onExitHandler: ((exitCode: number, signal?: number) => void) | null = null;
  private _outputBuffer: OutputBuffer;
  private _env: CtxEnv;
  private _config: AgentConfig;
  private _stateDir: string;
  private _cwd: string;
  private _socketPath: string;
  private _socketListenArg: string;
  private _socketCwd: string;
  private _rpcEndpoint: { host: string; port: number } | { socketPath: string } | null = null;
  private _threadStatePath: string;
  private _modelGateAlertPath: string;
  private _socketPointerPath: string;
  private _turnCustodyPath: string;
  private _turnCustody: CodexTurnCustodyStore;
  private _threadId: string | null = null;
  private _telegramApi: TelegramAPI | null = null;
  private _chatId: string | null = null;
  private _typingLastSent = 0;

  constructor(env: CtxEnv, config: AgentConfig, logPath?: string) {
    this._env = env;
    this._config = config;
    this._cwd = config.working_directory || env.agentDir || process.cwd();
    this._stateDir = join(env.ctxRoot, 'state', env.agentName);
    this._threadStatePath = join(this._stateDir, 'codex-app-server-thread.json');
    this._modelGateAlertPath = join(this._stateDir, 'codex-model-gate-alert.json');
    this._socketPointerPath = join(this._stateDir, 'codex-app-server-socket.json');
    this._turnCustodyPath = join(this._stateDir, 'codex-turn-custody.json');
    this._turnCustody = new CodexTurnCustodyStore(this._turnCustodyPath);
    const socket = this.resolveSocketPath();
    this._socketPath = socket.path;
    this._socketListenArg = socket.listenArg;
    this._socketCwd = socket.cwd;
    this._outputBuffer = new OutputBuffer(1000, logPath, BOOTSTRAP_PATTERN);
    this.warnIfModelGated();
  }

  /**
   * Observable downgrade (no silent failure): if an explicit config.model is set
   * but is NOT on the SAFE_MODELS allowlist, every thread/turn request gates it
   * down to DEFAULT_SAFE_MODEL (see resolveSafeModel). Surface that ONCE at
   * construction — via the agent log AND a dashboard event — so a genuinely
   * entitled new model that needs adding to SAFE_MODELS is visible rather than
   * silently downgraded. Warn-once (not per-resolve) avoids per-turn spam.
   */
  private warnIfModelGated(): void {
    const configured = this._config.model;
    if (!configured || SAFE_MODELS.includes(configured)) return;
    const msg = `[codex-app-server] WARNING: configured model '${configured}' is not in SAFE_MODELS [${SAFE_MODELS.join(', ')}] — using ${DEFAULT_SAFE_MODEL}. Add it to SAFE_MODELS if it is genuinely entitled.`;
    this._outputBuffer.push(msg + '\n');
    try {
      const paths = resolvePaths(this._env.agentName, this._env.instanceId, this._env.org);
      logEvent(
        paths,
        this._env.agentName,
        this._env.org,
        'action',
        'codex_model_gated_to_safe_default',
        'warning',
        {
          runtime: 'codex-app-server',
          configured_model: configured,
          used_model: DEFAULT_SAFE_MODEL,
          safe_models: SAFE_MODELS,
        },
      );
    } catch {
      /* non-fatal: the event is observability only */
    }
  }

  private reconcileModelGateAlert(): void {
    const configured = this._config.model;
    const gated = !!configured && !SAFE_MODELS.includes(configured);
    const stateExists = existsSync(this._modelGateAlertPath);
    let state: ModelGateAlertState | null = null;

    if (stateExists) {
      try {
        state = JSON.parse(readFileSync(this._modelGateAlertPath, 'utf-8')) as ModelGateAlertState;
      } catch {
        // Fail toward alerting: unreadable dedupe state must not suppress notice.
        state = null;
      }
    }

    if (gated) {
      if (state?.status !== 'cleared'
        && state?.configured_model === configured
        && state.used_model === DEFAULT_SAFE_MODEL) {
        return;
      }
      if (!this._telegramApi || !this._chatId) {
        this._outputBuffer.push('[codex-app-server] model gate alert deferred: no Telegram handle\n');
        return;
      }

      const alertText = `MODEL GATE: agent ${this._env.agentName} config.json requests model '${configured}', which is not on the codex SAFE_MODELS allowlist [${SAFE_MODELS.join(', ')}]. It is actually running '${DEFAULT_SAFE_MODEL}'. If '${configured}' is entitled and intended, add it to SAFE_MODELS in src/pty/codex-app-server-pty.ts, rebuild, and restart the agent. If it is a typo, fix "model" in the agent's config.json. This alert will not repeat for this model across restarts; it re-arms when the gate clears or the configured model changes.`;
      const alertState: ModelGateAlertState = {
        configured_model: configured,
        used_model: DEFAULT_SAFE_MODEL,
        alerted_at: new Date().toISOString(),
      };
      this._telegramApi.sendMessage(this._chatId, alertText, undefined, { parseMode: null })
        .then(() => {
          atomicWriteSync(this._modelGateAlertPath, JSON.stringify(alertState, null, 2));
          try {
            const paths = resolvePaths(this._env.agentName, this._env.instanceId, this._env.org);
            logEvent(
              paths,
              this._env.agentName,
              this._env.org,
              'action',
              'codex_model_gate_alert_sent',
              'warning',
              {
                configured_model: configured,
                used_model: DEFAULT_SAFE_MODEL,
                safe_models: SAFE_MODELS,
              },
            );
          } catch {
            /* non-fatal: the Telegram alert was delivered */
          }
        })
        .catch((err) => {
          this._outputBuffer.push(`[codex-app-server] model gate alert send failed: ${err}\n`);
        });
      return;
    }

    if (!stateExists) return;

    try {
      unlinkSync(this._modelGateAlertPath);
    } catch (unlinkErr) {
      const now = new Date().toISOString();
      const clearedState: ModelGateAlertState = {
        status: 'cleared',
        configured_model: state?.configured_model ?? configured ?? '',
        used_model: state?.used_model ?? DEFAULT_SAFE_MODEL,
        alerted_at: state?.alerted_at ?? now,
        cleared_at: now,
      };
      try {
        atomicWriteSync(this._modelGateAlertPath, JSON.stringify(clearedState, null, 2));
      } catch (writeErr) {
        this._outputBuffer.push(
          `[codex-app-server] model gate alert re-arm failed for ${this._modelGateAlertPath}: unlink failed (${unlinkErr}); cleared-tombstone write failed (${writeErr}); remove it manually before re-enabling a gated model.\n`,
        );
      }
      // Do not report a clear when the original gated-state file could not be removed.
      return;
    }

    if (this._telegramApi && this._chatId) {
      const clearedText = configured
        ? `MODEL GATE CLEARED: agent ${this._env.agentName} is now running its configured model ${configured}.`
        : `MODEL GATE CLEARED: agent ${this._env.agentName} no longer requests a gated model.`;
      this._telegramApi.sendMessage(this._chatId, clearedText, undefined, { parseMode: null })
        .catch((err) => {
          this._outputBuffer.push(`[codex-app-server] model gate cleared alert send failed: ${err}\n`);
        });
    }

    try {
      const paths = resolvePaths(this._env.agentName, this._env.instanceId, this._env.org);
      logEvent(
        paths,
        this._env.agentName,
        this._env.org,
        'action',
        'codex_model_gate_cleared',
        'info',
        {
          configured_model: configured ?? null,
          previous_configured_model: state?.configured_model ?? null,
        },
      );
    } catch {
      /* non-fatal: the state reconciliation already completed */
    }
  }

  async spawn(mode: 'fresh' | 'continue', prompt: string): Promise<void> {
    if (this._alive) {
      throw new Error('CodexAppServerPTY already spawned. Kill first.');
    }

    ensureDir(this._stateDir);
    this._exitFinalized = false;
    this._alive = true;

    try {
      await this.startAppServerWithRetry();
      await this.connectRpc();
      await this.initializeRpc();
      const pendingCustody = this.loadTurnCustody();
      const custodyThreadId = this.resolveCustodyThreadId(pendingCustody);
      await this.startOrResumeThread(mode, custodyThreadId);
      this._outputBuffer.push(`${BOOTSTRAP_PATTERN} thread=${this._threadId}\n`);
      this.reconcileModelGateAlert();
      this._restoringTurnCustody = true;
      const restoredTurns = await this.restoreTurnCustody(pendingCustody);
      if (prompt.trim()) {
        this.queueTurn([{ type: 'text', text: prompt, text_elements: [] }]);
      }
      this._restoringTurnCustody = false;
      if ((restoredTurns > 0 || this._turnQueue.length > 0) && !this._executing && !this._turnCustodyBlocked) {
        this.drainQueue().catch((err) => {
          this._outputBuffer.push(`[codex-app-server] recovered turn queue failed: ${err}\n`);
        });
      }
    } catch (err) {
      this._restoringTurnCustody = false;
      this._alive = false;
      this._outputBuffer.push(`[codex-app-server] degraded: ${err}\n`);
      this.kill();
      throw err;
    }
  }

  write(data: string): void {
    if (!this._alive) return;

    if (data === '\r') {
      const content = this._writeBuffer
        .replace(/\x1b\[200~/g, '')
        .replace(/\x1b\[201~/g, '')
        .trim();
      this._writeBuffer = '';
      if (content) {
        this.handleInput(content).catch((err) => {
          this._outputBuffer.push(`[codex-app-server] input failed: ${err}\n`);
        });
      }
    } else {
      this._writeBuffer += data;
    }
  }

  /**
   * Trusted structured injection path. The daemon may attach turn routing to a
   * cron fire without encoding authority in prompt text. Ordinary callers omit
   * routing and retain the configured agent model.
   */
  injectMessage(content: string, routing?: CodexTurnRouting): void {
    if (!this._alive) return;
    const safeContent = sanitizeForInjection(content).trim();
    if (!safeContent) return;
    this.handleInput(safeContent, routing).catch((err) => {
      this._outputBuffer.push(`[codex-app-server] injected input failed: ${err}\n`);
    });
  }

  /** Queue a reviewed mechanical cron preflight and its Sol continuation atomically. */
  injectCronSequence(
    preflightContent: string,
    preflightRouting: CodexTurnRouting,
    continuationContent: string,
    fallbackContent: string,
  ): void {
    if (!this._alive) return;
    const preflight = sanitizeForInjection(preflightContent).trim();
    const continuation = sanitizeForInjection(continuationContent).trim();
    const fallback = sanitizeForInjection(fallbackContent).trim();
    if (!preflight || !continuation || !fallback) return;

    const continuationRouting = {
      ...preflightRouting,
      model: resolveSafeModel(this._config.model),
      reason: 'configured_sol_continuation',
    };
    this.enqueueQueuedTurn({
      input: [{ type: 'text', text: preflight, text_elements: [] }],
      routing: preflightRouting,
      cronSequence: {
        id: randomBytes(8).toString('hex'),
        continuation: {
          input: [{ type: 'text', text: continuation, text_elements: [] }],
          routing: continuationRouting,
        },
        fallbackPrompt: fallback,
        fallbackRouting: {
          ...preflightRouting,
          model: resolveSafeModel(this._config.model),
          reason: 'preflight_failed_sol_fallback',
        },
      },
    });
  }

  kill(): void {
    this._alive = false;
    this._activeTurnId = null;
    this._activeWorkItemId = null;
    this._turnQueue = [];
    this._turnCustodyBlocked = false;
    this._restoringTurnCustody = false;
    this._startingTurnRouting = null;
    this._turnRoutingById.clear();
    this._retiredTurnIds.clear();
    this.rejectTurnCompletion(new Error('Codex app-server stopped'));
    if (this._rpc) {
      this._rpc.close();
      this._rpc = null;
    }
    if (this._appServerPty) {
      try {
        this._appServerPty.kill();
      } catch {
        // Ignore shutdown errors.
      }
    }
  }

  isAlive(): boolean {
    return this._alive;
  }

  getPid(): number | null {
    return this._appServerPty?.pid ?? null;
  }

  onExit(handler: (exitCode: number, signal?: number) => void): void {
    this._onExitHandler = handler;
  }

  getOutputBuffer(): OutputBuffer {
    return this._outputBuffer;
  }

  setTelegramHandle(api: TelegramAPI, chatId: string): void {
    this._telegramApi = api;
    this._chatId = chatId;
    // Deliberately store-only: reconcileModelGateAlert is invoked ONLY from
    // spawn() after bootstrap succeeds. Reconciling from a post-start bind was
    // tried and produced three consecutive defects (missed retry, retry
    // suppression, dedupe-state corruption during pending bootstrap) on a path
    // no production caller reaches - the sole caller binds pre-start
    // (agent-manager.ts:601). If a post-start caller is ever added, see the
    // PR #48 review thread before reintroducing reconcile here.
  }

  private finalizeExit(exitCode: number, signal?: number, reason?: string): void {
    if (this._exitFinalized) return;
    this._exitFinalized = true;
    this._alive = false;
    // Flush any held-back partial-JWT tail — the stream is over, so the
    // hold can never be resolved by a next chunk (see OutputBuffer.close).
    this._outputBuffer.close();
    this._executing = false;
    this._activeTurnId = null;
    this._activeWorkItemId = null;
    this._writeBuffer = '';
    this._turnQueue = [];
    this._turnCustodyBlocked = false;
    this._restoringTurnCustody = false;
    this._startingTurnRouting = null;
    this._turnRoutingById.clear();
    this.rejectTurnCompletion(new Error(reason ? `Codex app-server stopped: ${reason}` : 'Codex app-server stopped'));
    this.stopPidPoll();
    this._rpcMessageUnsubscribe?.();
    this._rpcMessageUnsubscribe = null;
    this._rpcDisconnectUnsubscribe?.();
    this._rpcDisconnectUnsubscribe = null;
    if (this._rpc) {
      this._rpc.close();
      this._rpc = null;
    }
    this._appServerPty = null;
    this._rpcEndpoint = null;
    this.removeSocket();
    const onExit = this._onExitHandler;
    this._onExitHandler = null;
    onExit?.(exitCode, signal);
  }

  private startPidPoll(pid: number): void {
    this.stopPidPoll();
    if (!(pid > 0)) return;
    this._pidPollTimer = setInterval(() => {
      if (!this._alive || this._exitFinalized) return;
      let alive = true;
      try {
        process.kill(pid, 0);
      } catch (err) {
        alive = (err as NodeJS.ErrnoException).code === 'EPERM';
      }
      if (!alive) {
        this.finalizeExit(1, undefined, `pid ${pid} no longer exists`);
      }
    }, 30000);
  }

  private stopPidPoll(): void {
    if (!this._pidPollTimer) return;
    clearInterval(this._pidPollTimer);
    this._pidPollTimer = null;
  }

  private handleInput(content: string, routing?: CodexTurnRouting): Promise<void> {
    const extracted = this.extractTelegramPayload(content);
    const input = extracted?.payload ?? content;
    const goalCommand = this.parseGoalCommand(input);
    if (goalCommand?.type === 'get') {
      return this.getGoal();
    }
    if (goalCommand?.type === 'clear') {
      return this.clearGoal();
    }
    if (goalCommand?.type === 'set') {
      return this.setGoal(goalCommand.objective);
    }
    if (input.startsWith('$')) {
      this.queueSkillInput(input, routing);
      return Promise.resolve();
    }
    const slashMatch = input.match(SLASH_REWRITE_RE);
    if (slashMatch && !LOCAL_SLASH_COMMANDS.has(slashMatch[1].toLowerCase())) {
      const [, name, trailing] = slashMatch;
      const trimmed = trailing?.trim();
      const rewritten = trimmed ? `$${name} ${trimmed}` : `$${name}`;
      this.queueSkillInput(rewritten, routing);
      return Promise.resolve();
    }
    const turnText = extracted?.replyDirective
      ? `${input}\n\n${extracted.replyDirective}`
      : input;
    this.queueTurn([{ type: 'text', text: turnText, text_elements: [] }], routing);
    return Promise.resolve();
  }

  private extractTelegramPayload(
    content: string,
  ): { payload: string; replyDirective: string | null } | null {
    if (!content.startsWith('=== TELEGRAM')) return null;

    const headerMatch = content.match(/^=== TELEGRAM(?:\s+(PHOTO|DOCUMENT|VOICE|AUDIO|VIDEO|VIDEO_NOTE))?\s+from/);
    const mediaType = headerMatch?.[1] ?? null;

    const chatIdMatch = content.match(/^=== TELEGRAM[^\n]*\(chat_id:(-?\d+)\)/);
    const chatId = chatIdMatch?.[1] ?? null;

    const beforeReply = content
      .split('\n[Your last message:', 1)[0]
      .split('\nReply using:', 1)[0];

    const replyToContext = this.extractReplyToContext(beforeReply);
    const replyDirective = chatId
      ? `Reply via: cortextos bus send-telegram ${chatId} '<your reply>' — this is the only path that surfaces in Telegram and on the dashboard. Do not reply through the codex channel.`
      : null;
    const wrap = (payload: string | null): { payload: string; replyDirective: string | null } | null => {
      if (!payload) return null;
      const withReplyTo = replyToContext ? `${payload}\n\n${replyToContext}` : payload;
      return { payload: withReplyTo, replyDirective };
    };

    if (mediaType) {
      const mediaPayload = this.buildMediaPayload(mediaType, beforeReply);
      if (mediaPayload) return wrap(mediaPayload);
    }

    const lines = beforeReply
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0);

    for (let i = lines.length - 1; i >= 0; i -= 1) {
      const line = lines[i];
      if (line.startsWith('=== TELEGRAM')) continue;
      if (line.startsWith('[Recent conversation:]')) continue;
      if (line.startsWith('[reply_to:')) continue;
      if (line.startsWith('[Replying to:')) continue;
      if (line.startsWith('/') || line.startsWith('$')) return wrap(line);
      break;
    }

    const fencedBlocks = [...beforeReply.matchAll(/(`{3,})(?:[a-zA-Z0-9_-]+)?\n([\s\S]*?)\n\1/g)];
    if (fencedBlocks.length > 0) {
      return wrap(fencedBlocks[fencedBlocks.length - 1]?.[2]?.trim() || null);
    }

    for (let i = lines.length - 1; i >= 0; i -= 1) {
      const line = lines[i];
      if (line.startsWith('=== TELEGRAM')) continue;
      if (line.startsWith('[Recent conversation:]')) continue;
      if (line.startsWith('[reply_to:')) continue;
      if (line.startsWith('[Replying to:')) continue;
      return wrap(line);
    }

    return null;
  }

  private buildMediaPayload(mediaType: string, beforeReply: string): string | null {
    // Match a dynamically-sized fence (3+ backticks): wrapFenceSafe grows the
    // fence to outlast any backtick run in the body, so the close must be the
    // same length as the open (backreference \1). Group 2 is the body.
    const captionMatch = beforeReply.match(/caption:\s*\n(`{3,})(?:[a-zA-Z0-9_-]+)?\n([\s\S]*?)\n\1/);
    const caption = captionMatch?.[2]?.trim() ?? '';

    const transcriptMatch = beforeReply.match(/transcript:\s*\n(`{3,})(?:[a-zA-Z0-9_-]+)?\n([\s\S]*?)\n\1/);
    const transcript = transcriptMatch?.[2]?.trim() ?? '';

    const localFileMatch = beforeReply.match(/^local_file:\s*(.+)$/m);
    const localFile = localFileMatch?.[1]?.trim() ?? '';

    const fileNameMatch = beforeReply.match(/^file_name:\s*(.+)$/m);
    const fileName = fileNameMatch?.[1]?.trim() ?? '';

    const durationMatch = beforeReply.match(/^duration:\s*(.+)$/m);
    const duration = durationMatch?.[1]?.trim() ?? '';

    const lines: string[] = [`[${mediaType}]`];
    if (caption) lines.push(`caption: ${caption}`);
    if (transcript) lines.push(`transcript: ${transcript}`);
    if (fileName) lines.push(`file_name: ${fileName}`);
    if (localFile) lines.push(`local_file: ${localFile}`);
    if (duration) lines.push(`duration: ${duration}`);

    return lines.length > 1 ? lines.join('\n') : null;
  }

  private extractReplyToContext(beforeReply: string): string | null {
    const telegramReplyMatch = beforeReply.match(/\[Replying to:\s*"([\s\S]*?)"\]/);
    if (telegramReplyMatch) {
      const text = telegramReplyMatch[1].slice(0, 200);
      if (text) return `[in reply to: ${text}]`;
    }

    const replyToMatch = beforeReply.match(/\[reply_to:\s*(\d+)\]/);
    if (!replyToMatch) return null;
    const messageId = replyToMatch[1];

    try {
      const outboundLog = join(this._stateDir, 'outbound-messages.jsonl');
      if (!existsSync(outboundLog)) return `[in reply to message ${messageId}]`;
      const fileLines = readFileSync(outboundLog, 'utf-8').split('\n').filter((l) => l.trim());
      for (let i = fileLines.length - 1; i >= 0; i -= 1) {
        try {
          const entry = JSON.parse(fileLines[i]) as { message_id?: number | string; text?: string };
          if (entry.message_id !== undefined && String(entry.message_id) === messageId) {
            const text = (entry.text || '').slice(0, 200);
            return text ? `[in reply to: ${text}]` : `[in reply to message ${messageId}]`;
          }
        } catch {
          // skip malformed lines
        }
      }
      return `[in reply to message ${messageId}]`;
    } catch {
      return `[in reply to message ${messageId}]`;
    }
  }

  private parseGoalCommand(content: string): { type: 'get' | 'clear' } | { type: 'set'; objective: string } | null {
    const match = content.trim().match(/^\/goal(?:@[A-Za-z0-9_]+)?(?:\s+([\s\S]*))?$/i);
    if (!match) return null;

    const objective = match[1]?.trim();
    if (!objective) return { type: 'get' };
    if (objective.toLowerCase() === 'clear') return { type: 'clear' };
    return { type: 'set', objective };
  }

  private async startAppServerWithRetry(): Promise<void> {
    const delays = [1000, 4000, 16000];
    let lastErr: unknown;

    for (let attempt = 0; attempt < delays.length; attempt += 1) {
      try {
        this.removeSocket();
        await this.startAppServer();
        return;
      } catch (err) {
        lastErr = err;
        this.cleanupSpawnAttempt();
        this._outputBuffer.push(`[codex-app-server] spawn attempt ${attempt + 1} failed: ${err}\n`);
        if (attempt < delays.length - 1) {
          await sleep(delays[attempt]);
        }
      }
    }

    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }

  private async startAppServer(): Promise<void> {
    // Repair on every child spawn, even when this long-lived server object has
    // cached node-pty's spawn function and npm has since replaced the package.
    this._spawnFn = this._prepareSpawnFn(this._spawnFn);

    // codex-cli 0.118.0 dropped `unix://` --listen support. Allocate a free
    // ephemeral TCP port on loopback and spawn with `--listen ws://127.0.0.1:<port>`.
    // The WebSocket frame parsing in WsUnixJsonRpcClient is transport-agnostic;
    // only the connect path differs.
    const port = await allocateFreePort();
    const listenArg = `ws://127.0.0.1:${port}`;
    this._socketListenArg = listenArg;
    this._rpcEndpoint = { host: '127.0.0.1', port };
    try {
      const pointer: SocketPointer = {
        host: '127.0.0.1',
        port,
        fallback: false,
        updatedAt: new Date().toISOString(),
      };
      ensureDir(this._stateDir);
      writeFileSync(this._socketPointerPath, `${JSON.stringify(pointer, null, 2)}\n`, 'utf-8');
    } catch {
      // Non-fatal — pointer is informational.
    }

    return new Promise<void>((resolve, reject) => {
      // Note: PR-#369 originally passed `--enable goals` to opt into the
      // goal-tracking feature, but codex-cli 0.118.0 reports
      // `Error: Unknown feature flag: goals` because this feature is not yet
      // present in the local codex build. Drop the flag for compatibility;
      // /goal RPC calls degrade to a clean error if codex doesn't expose
      // them. Re-enable once codex-cli ships goal support.
      const spawnFn = this._spawnFn!;
      const pty = spawnFn('codex', [
        'app-server',
        '--listen', listenArg,
      ], {
        name: 'xterm-256color',
        cols: 200,
        rows: 50,
        cwd: this._socketCwd,
        env: this.buildEnv(),
      });

      this._appServerPty = pty;
      this.startPidPoll(pty.pid);
      pty.onData((data) => {
        this._outputBuffer.push(data);
        if (data.includes('Error:')) {
          reject(new Error(data.trim()));
        }
      });
      pty.onExit(({ exitCode, signal }) => {
        if (this._appServerPty !== pty) return;
        this.finalizeExit(exitCode, signal, 'pty exit');
      });

      this.waitForPort(port).then(resolve, reject);
    });
  }

  private async waitForPort(port: number, timeoutMs = 10000): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const ok = await new Promise<boolean>((res) => {
        const probe = createConnection({ host: '127.0.0.1', port });
        probe.once('connect', () => { probe.destroy(); res(true); });
        probe.once('error', () => { probe.destroy(); res(false); });
      });
      if (ok) return;
      await sleep(100);
    }
    throw new Error(`Timed out waiting for app-server port: 127.0.0.1:${port}`);
  }

  private async waitForSocket(timeoutMs = 10000): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (existsSync(this._socketPath)) return;
      await sleep(100);
    }
    throw new Error(`Timed out waiting for app-server socket: ${this._socketPath}`);
  }

  private async connectRpc(): Promise<void> {
    // Prefer the TCP endpoint allocated in startAppServer(). Fall back to the
    // legacy unix-socket path if no endpoint was set (e.g. tests using the
    // older constructor flow).
    const endpoint = this._rpcEndpoint ?? { socketPath: this._socketPath };
    this._rpc = new WsUnixJsonRpcClient(endpoint);
    this._rpcMessageUnsubscribe = this._rpc.onMessage((message) => this.handleRpcMessage(message));
    this._rpcDisconnectUnsubscribe = this._rpc.onDisconnect((err) => {
      this.finalizeExit(1, undefined, err.message || 'rpc disconnect');
    });
    await this._rpc.connect();
  }

  private async initializeRpc(): Promise<void> {
    await this.request('initialize', {
      clientInfo: {
        name: 'cortextos',
        title: 'cortextOS',
        version: this.getPackageVersion(),
      },
      capabilities: { experimentalApi: true },
    });
    this._rpc?.notify('initialized');
  }

  private async startOrResumeThread(
    mode: 'fresh' | 'continue',
    custodyThreadId: string | null = null,
  ): Promise<void> {
    if (custodyThreadId) {
      const resumed = await this.request<ThreadResponse>('thread/resume', {
        threadId: custodyThreadId,
        cwd: this._cwd,
        model: resolveSafeModel(this._config.model),
        ...THREAD_PERMISSION_OVERRIDES,
        config: { features: { goals: true } },
        excludeTurns: true,
        persistExtendedHistory: true,
      });
      if (resumed.error) {
        throw this.blockTurnCustody(
          `failed to resume custodied thread ${custodyThreadId}`,
          resumed.error.message,
        );
      }
      const resumedThreadId = resumed.result?.thread.id;
      if (resumedThreadId !== custodyThreadId) {
        throw this.blockTurnCustody(
          `custodied thread identity changed from ${custodyThreadId} to ${resumedThreadId ?? 'missing'}`,
        );
      }
      this.setThreadId(custodyThreadId);
      return;
    }
    if (mode === 'continue') {
      const persisted = this.readThreadState();
      if (persisted) {
        try {
          const resumed = await this.request<ThreadResponse>('thread/resume', {
            threadId: persisted.threadId,
            cwd: this._cwd,
            model: resolveSafeModel(this._config.model),
            ...THREAD_PERMISSION_OVERRIDES,
            config: { features: { goals: true } },
            excludeTurns: true,
            persistExtendedHistory: true,
          });
          this.setThreadId(resumed.result?.thread.id || persisted.threadId);
          return;
        } catch (err) {
          this._outputBuffer.push(`[codex-app-server] persisted resume failed: ${err}\n`);
        }
      }

      const latest = await this.findLatestThreadForCwd();
      if (latest) {
        const resumed = await this.request<ThreadResponse>('thread/resume', {
          threadId: latest,
          cwd: this._cwd,
          model: resolveSafeModel(this._config.model),
          ...THREAD_PERMISSION_OVERRIDES,
          config: { features: { goals: true } },
          excludeTurns: true,
          persistExtendedHistory: true,
        });
        this.setThreadId(resumed.result?.thread.id || latest);
        return;
      }
    }

    const started = await this.request<ThreadResponse>('thread/start', {
      cwd: this._cwd,
      model: resolveSafeModel(this._config.model),
      ...THREAD_PERMISSION_OVERRIDES,
      config: { features: { goals: true } },
      sessionStartSource: 'startup',
      experimentalRawEvents: false,
      persistExtendedHistory: true,
    });
    this.setThreadId(started.result!.thread.id);
  }

  private async findLatestThreadForCwd(): Promise<string | null> {
    const response = await this.request<{ data: Array<{ id: string; cwd?: string }> }>('thread/list', {
      cwd: this._cwd,
      limit: 1,
      sortKey: 'updated_at',
      sortDirection: 'desc',
      archived: false,
    });
    return response.result?.data?.[0]?.id || null;
  }

  /**
   * Every inbound command becomes its own durably admitted turn. App-server
   * `turn/steer` has no caller-supplied idempotency identity, so an accepted
   * request followed by a lost response cannot be distinguished from a
   * rejected request after a crash. Queueing preserves FIFO while keeping the
   * stable work-item identity available for restart reconciliation.
   */
  private queueTurn(input: unknown[], routing?: CodexTurnRouting, _forceQueue = false): void {
    this.enqueueTurn(input, routing);
  }

  private enqueueTurn(input: unknown[], routing?: CodexTurnRouting): void {
    this.enqueueQueuedTurn({ input, routing });
  }

  private enqueueQueuedTurn(payload: QueuedTurnPayload, position: 'front' | 'back' = 'back'): void {
    if (this._turnCustodyBlocked) {
      throw new TurnCustodyBlockedError('turn custody is blocked; restart reconciliation is required');
    }
    if (!this._threadId) {
      throw this.blockTurnCustody('cannot admit a turn without an active thread');
    }
    const queued: QueuedTurn = {
      ...payload,
      workItemId: randomUUID(),
    };
    try {
      this._turnCustody.admit(this.toCustodiedTurn(queued), position);
    } catch (err) {
      throw this.blockTurnCustody(`failed to admit work item ${queued.workItemId}`, err);
    }
    if (position === 'front') {
      this._turnQueue.unshift(queued);
    } else {
      this._turnQueue.push(queued);
    }
    if (!this._executing && !this._turnCustodyBlocked && !this._restoringTurnCustody) {
      this.drainQueue().catch((err) => {
        this._outputBuffer.push(`[codex-app-server] turn queue failed: ${err}\n`);
      });
    }
  }

  private async drainQueue(): Promise<void> {
    while (this._alive && !this._turnCustodyBlocked && this._turnQueue.length > 0) {
      const queued = this._turnQueue.shift()!;
      this._executing = true;
      try {
        const status = await this.startTurn(queued);
        if (queued.cronSequence && status === 'completed') {
          this.transitionQueuedTurn(
            queued.workItemId,
            queued.cronSequence.continuation,
            'front',
          );
          this.emitCronSequenceOutcome('cron_model_preflight_completed', queued.cronSequence, {
            effective_model: queued.routing?.model ?? resolveSafeModel(this._config.model),
          });
        } else if (queued.cronSequence) {
          this.prepareCronSequenceFallback(
            queued.workItemId,
            queued.cronSequence,
            new TurnRunError('active_turn_error', `preflight ended ${status}`),
          );
        } else {
          try {
            this._turnCustody.settle(queued.workItemId);
          } catch (settleErr) {
            throw this.blockTurnCustody(
              `failed to settle completed work item ${queued.workItemId}`,
              settleErr,
            );
          }
        }
      } catch (err) {
        if (err instanceof TurnCustodyBlockedError || this._turnCustodyBlocked) {
          this._turnQueue.unshift(queued);
          throw err;
        }
        if (!this._alive) throw err;
        if (err instanceof TurnRunError && !queued.cronSequence) {
          try {
            this._turnCustody.settle(queued.workItemId);
          } catch (settleErr) {
            this._turnQueue.unshift(queued);
            throw this.blockTurnCustody(
              `failed to settle terminal work item ${queued.workItemId}`,
              settleErr,
            );
          }
        }
        if (!queued.cronSequence) {
          this._outputBuffer.push(`[codex-app-server] turn failed, continuing queue: ${err}\n`);
          continue;
        }
        if (!(err instanceof TurnRunError)) {
          this._turnQueue.unshift(queued);
          throw this.blockTurnCustody(
            `unexpected cron turn failure for ${queued.workItemId}`,
            err,
          );
        }
        this.prepareCronSequenceFallback(queued.workItemId, queued.cronSequence, err);
      } finally {
        this._executing = false;
      }
    }
  }

  private async startTurn(queued: QueuedTurn): Promise<RemoteTurnStatus> {
    if (!this._threadId) throw new Error('No Codex app-server thread is active');
    if (queued.deferredSkill) {
      if (queued.recoveredTurnId) {
        throw this.blockTurnCustody(
          `remote turn ${queued.recoveredTurnId} exists for unresolved skill ${queued.workItemId}`,
        );
      }
      if (!await this.resolveDeferredSkill(queued)) return 'completed';
    }
    const effective = {
      model: resolveSafeModel(queued.routing?.model ?? this._config.model),
      routing: queued.routing,
    };
    if (queued.recoveredTurnId) {
      return this.awaitExistingTurn(queued, queued.recoveredTurnId, effective);
    }

    while (true) {
      let attempt: number;
      try {
        attempt = this._turnCustody.noteStartAttempt(queued.workItemId);
      } catch (err) {
        throw this.blockTurnCustody(
          `failed to persist start attempt for ${queued.workItemId}`,
          err,
        );
      }
      const completion = this.createTurnCompletion(queued.workItemId);
      this._activeWorkItemId = queued.workItemId;
      this._startingTurnRouting = effective;
      let knownTurnId: string | null = null;
      try {
        const started = await this.request<{ turnId?: string; turn?: { id?: string } }>('turn/start', {
          threadId: this._threadId,
          clientUserMessageId: queued.workItemId,
          input: queued.input,
          model: effective.model,
          ...TURN_PERMISSION_OVERRIDES,
        });
        if (started.error) {
          throw new Error(`turn/start rejected (${started.error.code}): ${started.error.message}`);
        }
        if (isRecord(started.result)) {
          const startedIdentity = readTurnEventIdentity(started.result);
          if (!startedIdentity.valid) {
            throw new Error('turn/start returned conflicting turn identities');
          }
          knownTurnId = startedIdentity.turnId;
          if (knownTurnId && !this.bindStartedTurn(knownTurnId)) {
            throw new Error(`turn/start identity ${knownTurnId} could not be bound`);
          }
        }
      } catch (err) {
        this.abandonTurnCompletion();
        this._startingTurnRouting = null;
        const reconciled = await this.reconcileRemoteTurn(queued, knownTurnId, 'start_rejected');
        if (reconciled.kind === 'terminal') {
          if (reconciled.status === 'completed') return reconciled.status;
          throw new TurnRunError('start_rejected', `remote turn ended ${reconciled.status}`);
        }
        if (reconciled.kind === 'inProgress') {
          return this.awaitExistingTurn(queued, reconciled.turnId, effective);
        }
        if (await this.verifyRemoteAbsence(queued.workItemId)) {
          if (attempt < 2) {
            this._outputBuffer.push(
              `[codex-app-server] verified empty remote start for ${queued.workItemId}; retrying once\n`,
            );
            continue;
          }
          if (queued.cronSequence) {
            throw new TurnRunError('start_rejected', err);
          }
        }
        throw this.blockTurnCustody(
          `cannot prove start disposition for ${queued.workItemId}`,
          err,
        );
      }

      let completionStatus: RemoteTurnStatus;
      try {
        completionStatus = await completion;
      } catch (err) {
        const stage = err instanceof Error && err.message === 'Timed out waiting for turn/completed'
          ? 'completion_timeout'
          : 'active_turn_error';
        const reconciled = await this.reconcileRemoteTurn(queued, knownTurnId, stage);
        if (reconciled.kind === 'terminal') {
          if (reconciled.status === 'completed') return reconciled.status;
          throw new TurnRunError(stage, `remote turn ended ${reconciled.status}`);
        }
        if (reconciled.kind === 'inProgress') {
          const terminal = await this.interruptAndAwaitTerminal(queued, reconciled.turnId);
          if (terminal === 'completed') return terminal;
          if (terminal) throw new TurnRunError(stage, `remote turn ended ${terminal}`);
        }
        throw this.blockTurnCustody(
          `remote turn for ${queued.workItemId} remained ambiguous after ${stage}`,
          err,
        );
      }
      if (completionStatus === 'completed') return completionStatus;
      throw new TurnRunError('active_turn_error', `remote turn ended ${completionStatus}`);
    }
  }

  private prepareCronSequenceFallback(
    parentWorkItemId: string,
    sequence: CronSequenceTransition,
    failure: TurnRunError,
  ): void {
    const routing = {
      ...sequence.fallbackRouting,
      reason: `preflight_failed_sol_fallback:${failure.stage}`,
    };
    const prompt = `${sequence.fallbackPrompt}\nFailure stage: ${failure.stage}.`;
    this.transitionQueuedTurn(parentWorkItemId, {
      input: [{ type: 'text', text: prompt, text_elements: [] }],
      routing,
    }, 'front');
    this.emitCronSequenceOutcome('cron_model_preflight_fallback', sequence, {
      failure_stage: failure.stage,
      effective_model: routing.model,
    });
  }

  private toCustodiedTurn(queued: QueuedTurn): CustodiedTurn {
    return {
      workItemId: queued.workItemId,
      threadId: this._threadId!,
      input: queued.input,
      ...(queued.deferredSkill === undefined ? {} : { deferredSkill: queued.deferredSkill }),
      ...(queued.routing === undefined ? {} : { routing: queued.routing }),
      ...(queued.cronSequence === undefined ? {} : { cronSequence: queued.cronSequence }),
      admittedAt: new Date().toISOString(),
      startAttempts: 0,
    };
  }

  private transitionQueuedTurn(
    parentWorkItemId: string,
    payload: QueuedTurnPayload,
    position: 'front' | 'back' = 'front',
  ): void {
    if (this._turnCustodyBlocked) {
      throw new TurnCustodyBlockedError('turn custody is blocked; restart reconciliation is required');
    }
    if (!this._threadId) {
      throw this.blockTurnCustody('cannot transition a turn without an active thread');
    }
    const successor: QueuedTurn = {
      ...payload,
      workItemId: randomUUID(),
    };
    try {
      this._turnCustody.replace(
        parentWorkItemId,
        this.toCustodiedTurn(successor),
        position,
      );
    } catch (err) {
      throw this.blockTurnCustody(
        `failed to transition work item ${parentWorkItemId} to ${successor.workItemId}`,
        err,
      );
    }
    if (position === 'front') {
      this._turnQueue.unshift(successor);
    } else {
      this._turnQueue.push(successor);
    }
  }

  private fromCustodiedTurn(turn: CustodiedTurn): QueuedTurn {
    return {
      workItemId: turn.workItemId,
      input: turn.input,
      ...(turn.deferredSkill === undefined ? {} : { deferredSkill: turn.deferredSkill }),
      ...(turn.routing === undefined ? {} : { routing: turn.routing as CodexTurnRouting }),
      ...(turn.cronSequence === undefined
        ? {}
        : { cronSequence: turn.cronSequence as CronSequenceTransition }),
    };
  }

  private loadTurnCustody(): CustodiedTurn[] {
    let pending: CustodiedTurn[];
    try {
      pending = this._turnCustody.load();
    } catch (err) {
      throw this.blockTurnCustody('failed to load durable turn custody', err);
    }
    return pending;
  }

  private resolveCustodyThreadId(pending: CustodiedTurn[]): string | null {
    const threadIds = new Set(pending.map((record) => record.threadId));
    if (threadIds.size > 1) {
      throw this.blockTurnCustody(
        `durable custody spans multiple threads: ${[...threadIds].join(', ')}`,
      );
    }
    return threadIds.values().next().value ?? null;
  }

  private async restoreTurnCustody(pending: CustodiedTurn[] = this.loadTurnCustody()): Promise<number> {
    if (pending.some((record) => record.threadId !== this._threadId)) {
      throw this.blockTurnCustody('active thread does not match durable turn custody');
    }
    let restored = 0;
    for (const record of pending) {
      const queued = this.fromCustodiedTurn(record);
      const remote = await this.lookupRestoredRemoteTurn(record.workItemId, 'initial');
      if (remote.kind === 'found') {
        if (remote.turn.status === 'inProgress') {
          queued.recoveredTurnId = remote.turn.id;
          this._turnQueue.push(queued);
          restored += 1;
          continue;
        }
        this.finalizeRestoredTurn(queued, remote.turn.status);
        this._outputBuffer.push(
          `[codex-app-server] reconciled terminal ${remote.turn.status} work item ${record.workItemId}\n`,
        );
        continue;
      }

      if (!await this.verifyRemoteAbsence(record.workItemId)) {
        const raced = await this.lookupRestoredRemoteTurn(record.workItemId, 'raced');
        if (raced.kind === 'found') {
          if (raced.turn.status === 'inProgress') {
            queued.recoveredTurnId = raced.turn.id;
            this._turnQueue.push(queued);
            restored += 1;
            continue;
          }
          this.finalizeRestoredTurn(queued, raced.turn.status);
          continue;
        }
        throw this.blockTurnCustody(
          `remote absence for restored work item ${record.workItemId} was not stable`,
        );
      }
      if (record.startAttempts >= 2) {
        throw this.blockTurnCustody(
          `restored work item ${record.workItemId} exhausted its two start attempts`,
        );
      }
      this._turnQueue.push(queued);
      restored += 1;
    }
    if (restored > 0) {
      this._outputBuffer.push(`[codex-app-server] restored ${restored} custodied turn(s)\n`);
    }
    return restored;
  }

  private finalizeRestoredTurn(queued: QueuedTurn, status: Exclude<RemoteTurnStatus, 'inProgress'>): void {
    if (queued.cronSequence && status === 'completed') {
      this.transitionQueuedTurn(queued.workItemId, queued.cronSequence.continuation, 'front');
      this.emitCronSequenceOutcome('cron_model_preflight_completed', queued.cronSequence, {
        effective_model: queued.routing?.model ?? resolveSafeModel(this._config.model),
      });
      return;
    }
    if (queued.cronSequence) {
      this.prepareCronSequenceFallback(
        queued.workItemId,
        queued.cronSequence,
        new TurnRunError('active_turn_error', `recovered preflight ended ${status}`),
      );
      return;
    }
    try {
      this._turnCustody.settle(queued.workItemId);
    } catch (err) {
      throw this.blockTurnCustody(
        `failed to settle restored terminal work item ${queued.workItemId}`,
        err,
      );
    }
  }

  private async awaitExistingTurn(
    queued: QueuedTurn,
    turnId: string,
    effective: EffectiveTurnRouting,
  ): Promise<RemoteTurnStatus> {
    this._activeWorkItemId = queued.workItemId;
    this._startingTurnRouting = effective;
    const completion = this.createTurnCompletion(queued.workItemId, turnId);
    if (!this.bindStartedTurn(turnId)) {
      this.abandonTurnCompletion();
      throw this.blockTurnCustody(
        `recovered turn ${turnId} conflicts with local authority for ${queued.workItemId}`,
      );
    }
    try {
      const status = await completion;
      if (status === 'completed') return status;
      throw new TurnRunError('active_turn_error', `remote turn ended ${status}`);
    } catch (err) {
      if (err instanceof TurnRunError) throw err;
      const stage = err instanceof Error && err.message === 'Timed out waiting for turn/completed'
        ? 'completion_timeout'
        : 'active_turn_error';
      const reconciled = await this.reconcileRemoteTurn(queued, turnId, stage);
      if (reconciled.kind === 'terminal') {
        if (reconciled.status === 'completed') return reconciled.status;
        throw new TurnRunError(stage, `remote turn ended ${reconciled.status}`);
      }
      if (reconciled.kind === 'inProgress') {
        const terminal = await this.interruptAndAwaitTerminal(queued, reconciled.turnId);
        if (terminal === 'completed') return terminal;
        if (terminal) throw new TurnRunError(stage, `remote turn ended ${terminal}`);
      }
      throw this.blockTurnCustody(
        `recovered turn ${turnId} remained ambiguous for ${queued.workItemId}`,
        err,
      );
    }
  }

  private async reconcileRemoteTurn(
    queued: QueuedTurn,
    knownTurnId: string | null,
    stage: CronSequenceFailureStage,
  ): Promise<ReconciledTurn> {
    let lookup: RemoteTurnLookup;
    try {
      lookup = await this.lookupRemoteTurn(queued.workItemId);
    } catch (err) {
      throw this.blockTurnCustody(
        `remote reconciliation read failed for ${queued.workItemId} after ${stage}`,
        err,
      );
    }
    if (lookup.kind === 'absent') {
      if (knownTurnId) {
        throw this.blockTurnCustody(
          `known remote turn ${knownTurnId} is absent from custody history for ${queued.workItemId}`,
        );
      }
      return { kind: 'absent' };
    }
    if (knownTurnId && lookup.turn.id !== knownTurnId) {
      throw this.blockTurnCustody(
        `remote turn identity changed from ${knownTurnId} to ${lookup.turn.id} for ${queued.workItemId}`,
      );
    }
    if (lookup.turn.status === 'inProgress') {
      return { kind: 'inProgress', turnId: lookup.turn.id };
    }
    this.clearTurnAuthority(lookup.turn.id, lookup.turn.status);
    return { kind: 'terminal', status: lookup.turn.status };
  }

  private async interruptAndAwaitTerminal(
    queued: QueuedTurn,
    turnId: string,
  ): Promise<Exclude<RemoteTurnStatus, 'inProgress'> | null> {
    if (!this._threadId) return null;
    try {
      const interrupted = await this.request('turn/interrupt', {
        threadId: this._threadId,
        turnId,
      });
      if (interrupted.error) {
        throw new Error(`turn/interrupt rejected (${interrupted.error.code}): ${interrupted.error.message}`);
      }
    } catch (err) {
      this._outputBuffer.push(`[codex-app-server] timed-out turn interrupt failed: ${err}\n`);
      return null;
    }

    for (let attempt = 0; attempt < this._turnReconcilePolls; attempt += 1) {
      await sleep(this._turnReconcileDelayMs);
      let lookup: RemoteTurnLookup;
      try {
        lookup = await this.lookupRemoteTurn(queued.workItemId);
      } catch (err) {
        throw this.blockTurnCustody(
          `post-interrupt reconciliation failed for ${queued.workItemId}`,
          err,
        );
      }
      if (lookup.kind === 'absent') return null;
      if (lookup.turn.id !== turnId) {
        throw this.blockTurnCustody(
          `post-interrupt turn identity changed from ${turnId} to ${lookup.turn.id}`,
        );
      }
      if (lookup.turn.status !== 'inProgress') {
        this.clearTurnAuthority(turnId, lookup.turn.status);
        return lookup.turn.status;
      }
    }
    return null;
  }

  private async verifyRemoteAbsence(workItemId: string): Promise<boolean> {
    for (let attempt = 0; attempt < this._turnReconcilePolls; attempt += 1) {
      if (attempt > 0) await sleep(this._turnReconcileDelayMs);
      let lookup: RemoteTurnLookup;
      try {
        lookup = await this.lookupRemoteTurn(workItemId);
      } catch (err) {
        throw this.blockTurnCustody(
          `verified-empty read failed for ${workItemId}`,
          err,
        );
      }
      if (lookup.kind !== 'absent') return false;
    }
    return true;
  }

  private async lookupRestoredRemoteTurn(
    workItemId: string,
    stage: 'initial' | 'raced',
  ): Promise<RemoteTurnLookup> {
    try {
      return await this.lookupRemoteTurn(workItemId);
    } catch (err) {
      throw this.blockTurnCustody(
        `${stage} restart reconciliation read failed for ${workItemId}`,
        err,
      );
    }
  }

  private async lookupRemoteTurn(workItemId: string): Promise<RemoteTurnLookup> {
    if (!this._threadId) throw new Error('No Codex app-server thread is active');
    let cursor: string | null = null;
    const seenCursors = new Set<string>();
    let match: RemoteTurn | null = null;

    for (let page = 0; page < 100; page += 1) {
      const response: JsonRpcResponse<{ data: unknown[]; nextCursor: string | null }> =
        await this.request<{ data: unknown[]; nextCursor: string | null }>('thread/turns/list', {
        threadId: this._threadId,
        cursor,
        limit: 100,
        sortDirection: 'desc',
        itemsView: 'full',
        });
      if (response.error) {
        throw new Error(`thread/turns/list failed (${response.error.code}): ${response.error.message}`);
      }
      if (!isRecord(response.result) || !Array.isArray(response.result.data)) {
        throw new Error('thread/turns/list returned malformed data');
      }
      for (const candidate of response.result.data) {
        const turn = this.parseRemoteTurn(candidate);
        const ownsWorkItem = turn.items.some((item) =>
          isRecord(item) && item.type === 'userMessage' && item.clientId === workItemId,
        );
        if (!ownsWorkItem) continue;
        if (match) {
          throw new Error(`multiple remote turns claim work item ${workItemId}`);
        }
        match = turn;
      }
      const nextCursor: string | null = response.result.nextCursor;
      if (nextCursor === null || nextCursor === undefined) {
        return match ? { kind: 'found', turn: match } : { kind: 'absent' };
      }
      if (typeof nextCursor !== 'string' || nextCursor.length === 0 || seenCursors.has(nextCursor)) {
        throw new Error('thread/turns/list returned an invalid pagination cursor');
      }
      seenCursors.add(nextCursor);
      cursor = nextCursor;
    }
    throw new Error('thread/turns/list exceeded the 100-page reconciliation bound');
  }

  private parseRemoteTurn(candidate: unknown): RemoteTurn {
    if (!isRecord(candidate) ||
        typeof candidate.id !== 'string' ||
        !Array.isArray(candidate.items) ||
        !isRemoteTurnStatus(candidate.status)) {
      throw new Error('thread/turns/list returned a malformed turn');
    }
    return {
      id: candidate.id,
      status: candidate.status,
      items: candidate.items,
    };
  }

  private clearTurnAuthority(turnId: string, _status: RemoteTurnStatus): void {
    this.retireTurn(turnId);
    if (this._activeTurnId === turnId) this._activeTurnId = null;
    this._activeWorkItemId = null;
    this._startingTurnRouting = null;
    this.abandonTurnCompletion();
  }

  private blockTurnCustody(message: string, cause?: unknown): TurnCustodyBlockedError {
    this._turnCustodyBlocked = true;
    this._activeTurnId = null;
    this._activeWorkItemId = null;
    this._startingTurnRouting = null;
    this.abandonTurnCompletion();
    this._outputBuffer.push(`[codex-app-server] TURN CUSTODY BLOCKED: ${message}\n`);
    try {
      const paths = resolvePaths(this._env.agentName, this._env.instanceId, this._env.org);
      logEvent(paths, this._env.agentName, this._env.org, 'error', 'codex_turn_custody_blocked', 'error', {
        message,
        cause: cause instanceof Error ? cause.message : cause === undefined ? null : String(cause),
        pending_work_items: this._turnCustody.snapshot().map((turn) => turn.workItemId),
      });
    } catch {
      // The durable custody file remains the recovery authority.
    }
    return new TurnCustodyBlockedError(message, cause);
  }

  private emitCronSequenceOutcome(
    event: 'cron_model_preflight_completed' | 'cron_model_preflight_fallback',
    sequence: CronSequenceTransition,
    meta: Record<string, unknown>,
  ): void {
    try {
      const paths = resolvePaths(this._env.agentName, this._env.instanceId, this._env.org);
      logEvent(paths, this._env.agentName, this._env.org, 'action', event, 'info', {
        sequence_id: sequence.id,
        cron: sequence.fallbackRouting.cronName,
        ...meta,
      });
    } catch {
      // Token telemetry remains the authoritative effective-model record.
    }
  }

  /**
   * Local-command reply: writes to the agent log AND mirrors back to Telegram.
   * Local commands (`/goal`, `$skill` errors) are handled inside the adapter
   * without an LLM turn, so the user only sees a response if we send it.
   */
  private replyLocal(text: string): void {
    this._outputBuffer.push(text + '\n');
    if (this._telegramApi && this._chatId) {
      this._telegramApi.sendMessage(this._chatId, text, undefined, { parseMode: null }).catch(() => {});
    }
  }

  private async setGoal(objective: string): Promise<void> {
    if (!this._threadId) throw new Error('No Codex app-server thread is active');
    const response = await this.request<GoalResponse>('thread/goal/set', {
      threadId: this._threadId,
      objective,
    });
    this.replyLocal(`[goal] ${response.result?.goal?.status || 'active'}: ${objective}`);
  }

  private async getGoal(): Promise<void> {
    if (!this._threadId) throw new Error('No Codex app-server thread is active');
    const response = await this.request<GoalResponse>('thread/goal/get', { threadId: this._threadId });
    const goal = response.result?.goal;
    this.replyLocal(goal?.objective
      ? `[goal] ${goal.status || 'active'}: ${goal.objective}`
      : '[goal] none set');
  }

  private async clearGoal(): Promise<void> {
    if (!this._threadId) throw new Error('No Codex app-server thread is active');
    await this.request('thread/goal/clear', { threadId: this._threadId });
    this.replyLocal('[goal] cleared');
  }

  private queueSkillInput(content: string, routing?: CodexTurnRouting): void {
    const match = content.match(/^\$([A-Za-z0-9:_-]+)(?:\s+([\s\S]*))?$/);
    if (!match) {
      this.replyLocal('[skill] expected $skill_name [text]');
      return;
    }

    this.enqueueQueuedTurn({
      input: [],
      deferredSkill: content,
      routing,
    });
  }

  private async resolveDeferredSkill(queued: QueuedTurn): Promise<boolean> {
    const content = queued.deferredSkill;
    const match = content?.match(/^\$([A-Za-z0-9:_-]+)(?:\s+([\s\S]*))?$/);
    if (!content || !match) {
      throw this.blockTurnCustody(`invalid deferred skill intent for ${queued.workItemId}`);
    }

    const [, skillName, trailingText] = match;
    let skills: JsonRpcResponse<SkillsListResponse>;
    try {
      skills = await this.request<SkillsListResponse>('skills/list', {
        cwds: [this._cwd],
        forceReload: false,
      });
    } catch (err) {
      throw this.blockTurnCustody(
        `skills/list transport failed while resolving ${queued.workItemId}`,
        err,
      );
    }
    if (skills.error || !isRecord(skills.result) || !Array.isArray(skills.result.data)) {
      throw this.blockTurnCustody(
        `skills/list failed while resolving ${queued.workItemId}`,
        skills.error?.message,
      );
    }
    const entries = skills.result.data;
    if (entries.length === 0) {
      throw this.blockTurnCustody(
        `skills/list returned no workspace data while resolving ${queued.workItemId}`,
      );
    }

    let workspaceSkills: unknown[] | null = null;
    for (const entry of entries) {
      if (!isRecord(entry) ||
          typeof entry.cwd !== 'string' || entry.cwd.length === 0 ||
          !Array.isArray(entry.skills)) {
        throw this.blockTurnCustody(
          `skills/list returned a malformed data entry while resolving ${queued.workItemId}`,
        );
      }
      if (entry.cwd !== this._cwd) {
        throw this.blockTurnCustody(
          `skills/list returned foreign workspace ${entry.cwd} while resolving ${queued.workItemId}`,
        );
      }
      if (workspaceSkills !== null) {
        throw this.blockTurnCustody(
          `skills/list returned duplicate workspace data while resolving ${queued.workItemId}`,
        );
      }
      workspaceSkills = entry.skills;
    }
    if (workspaceSkills === null) {
      throw this.blockTurnCustody(
        `skills/list omitted requested workspace while resolving ${queued.workItemId}`,
      );
    }

    const allSkills: Array<{
      name: string;
      path: string;
      enabled?: boolean;
    }> = [];
    for (const skill of workspaceSkills) {
      if (!isRecord(skill) ||
          typeof skill.name !== 'string' ||
          !/^[A-Za-z0-9:_-]+$/.test(skill.name) ||
          typeof skill.path !== 'string' ||
          !isAbsolute(skill.path) ||
          (skill.enabled !== undefined && typeof skill.enabled !== 'boolean')) {
        throw this.blockTurnCustody(
          `skills/list returned a malformed skill while resolving ${queued.workItemId}`,
        );
      }
      allSkills.push({
        name: skill.name,
        path: skill.path,
        ...(skill.enabled === undefined ? {} : { enabled: skill.enabled }),
      });
    }
    const exactMatches = allSkills
      .filter((skill) => skill.enabled !== false && skill.name === skillName);
    if (exactMatches.length > 1) {
      throw this.blockTurnCustody(
        `skills/list returned duplicate enabled matches for ${skillName} while resolving ${queued.workItemId}`,
      );
    }
    const exact = exactMatches[0];
    if (!exact) {
      const matches = allSkills
        .filter((skill) => skill.enabled !== false && skill.name.includes(skillName))
        .slice(0, 5)
        .map((skill) => skill.name);
      this.replyLocal(matches.length > 0
        ? `[skill] unknown "${skillName}". Did you mean: ${matches.join(', ')}?`
        : `[skill] unknown "${skillName}". No enabled matches found.`);
      return false;
    }

    const input: unknown[] = [{ type: 'skill', name: exact.name, path: exact.path }];
    if (trailingText?.trim()) {
      input.push({ type: 'text', text: trailingText.trim(), text_elements: [] });
    }
    try {
      this._turnCustody.resolveDeferredSkill(queued.workItemId, input);
    } catch (err) {
      throw this.blockTurnCustody(
        `failed to persist resolved skill ${queued.workItemId}`,
        err,
      );
    }
    queued.input = input;
    delete queued.deferredSkill;
    return true;
  }

  private handleRpcMessage(message: unknown): void {
    if (!isRecord(message)) return;

    if ('method' in message && 'id' in message) {
      const method = String(message.method);
      const id = message.id as number | string;
      this._outputBuffer.push(`[codex-app-server] unsupported request: ${method}\n`);
      this.emitUnsupportedRequestEvent(method);
      this._rpc?.respondError(id, -32601, `Unsupported app-server request: ${method}`);
      return;
    }

    if (!('method' in message)) return;
    const method = String(message.method);
    const params = isRecord(message.params) ? message.params : {};
    const turnIdentity = readTurnEventIdentity(params);

    switch (method) {
      case 'thread/started':
        this._outputBuffer.push('[codex-app-server] thread started\n');
        break;
      case 'thread/status/changed':
        this._outputBuffer.push(`[codex-app-server] status ${JSON.stringify(params.status)}\n`);
        if (isRecord(params.status) && params.status.type === 'idle') {
          this.writeIdleFlag();
        } else {
          this.maybeFireTyping();
        }
        break;
      case 'turn/started':
        if (!turnIdentity.valid) {
          this._outputBuffer.push('[codex-app-server] ignored turn/started with conflicting identities\n');
          break;
        }
        if (turnIdentity.turnId && !this.bindStartedTurn(turnIdentity.turnId)) {
          break;
        }
        this.maybeFireTyping();
        this._outputBuffer.push('[codex-app-server] turn started\n');
        break;
      case 'turn/completed':
        if (!turnIdentity.valid) {
          this._outputBuffer.push('[codex-app-server] ignored turn/completed with conflicting identities\n');
          break;
        }
        if (this.shouldIgnoreTurnEvent('completion', turnIdentity.turnId)) {
          break;
        }
        const completedStatus = readCompletedTurnStatus(params);
        const completedTurnId = turnIdentity.turnId ?? this._activeTurnId;
        if (completedTurnId) this.retireTurn(completedTurnId);
        this._activeTurnId = null;
        this._activeWorkItemId = null;
        this.writeIdleFlag();
        this._outputBuffer.push('[codex-app-server] turn completed\n');
        this.resolveTurnCompletion(completedStatus);
        break;
      case 'item/agentMessage/delta':
        if (!turnIdentity.valid || this.shouldIgnoreTurnEvent('agent message delta', turnIdentity.turnId)) {
          break;
        }
        if (typeof params.delta === 'string') {
          this._outputBuffer.push(params.delta);
        }
        this.maybeFireTyping();
        break;
      case 'item/completed':
        if (!turnIdentity.valid || this.shouldIgnoreTurnEvent('item completion', turnIdentity.turnId)) {
          break;
        }
        if (isRecord(params.item) && params.item.type === 'agentMessage' && typeof params.item.text === 'string') {
          this._outputBuffer.push('\n');
        }
        break;
      case 'turn/plan/updated':
      case 'item/plan/delta':
        if (!turnIdentity.valid || this.shouldIgnoreTurnEvent('plan update', turnIdentity.turnId)) {
          break;
        }
        this._outputBuffer.push(`[plan] ${JSON.stringify(params)}\n`);
        this.maybeFireTyping();
        break;
      case 'thread/goal/updated':
        if (isRecord(params.goal)) {
          this._outputBuffer.push(`[goal] ${params.goal.status || 'active'}: ${params.goal.objective || ''}\n`);
        }
        break;
      case 'thread/goal/cleared':
        this._outputBuffer.push('[goal] cleared\n');
        break;
      case 'error':
        if (!turnIdentity.valid) {
          this._outputBuffer.push('[codex-app-server] ignored error with conflicting turn identities\n');
          break;
        }
        if (this.shouldIgnoreTurnEvent('error', turnIdentity.turnId)) {
          break;
        }
        if (params.willRetry === true) {
          this._outputBuffer.push(`[codex-app-server] retryable turn error: ${JSON.stringify(params)}\n`);
          break;
        }
        if (this._activeTurnId) this.retireTurn(this._activeTurnId);
        this._activeTurnId = null;
        this._activeWorkItemId = null;
        this._outputBuffer.push(`[codex-app-server] error: ${JSON.stringify(params)}\n`);
        this.resolveTurnCompletion('failed');
        break;
      case 'thread/tokenUsage/updated':
        if (!turnIdentity.valid || this.shouldIgnoreTurnEvent('token usage', turnIdentity.turnId)) {
          break;
        }
        this.writeContextStatus(params);
        this.appendCodexTokenLog(params);
        this._outputBuffer.push(`[codex-app-server:event] ${method}\n`);
        break;
      case 'warning':
      case 'mcpServer/startupStatus/updated':
      case 'account/rateLimits/updated':
      case 'skills/changed':
        this._outputBuffer.push(`[codex-app-server:event] ${method}\n`);
        break;
      case 'item/started':
        if (!turnIdentity.valid || this.shouldIgnoreTurnEvent('item start', turnIdentity.turnId)) {
          break;
        }
        this._outputBuffer.push(`[codex-app-server:event] ${method}\n`);
        break;
      default:
        this._outputBuffer.push(`[codex-app-server:event] ${method}\n`);
    }
  }

  private request<T>(method: string, params: unknown): Promise<JsonRpcResponse<T>> {
    if (!this._rpc) throw new Error('Codex app-server RPC is not connected');
    return this._rpc.request<T>(method, params);
  }

  private bindStartedTurn(turnId: string): boolean {
    if (this._retiredTurnIds.has(turnId)) {
      this._outputBuffer.push(`[codex-app-server] ignored late start for retired turn ${turnId}\n`);
      return false;
    }
    const expected = this._activeTurnId ?? this._turnCompletion?.turnId ?? null;
    if (expected && expected !== turnId) {
      this._outputBuffer.push(`[codex-app-server] ignored turn/start identity ${turnId}; current turn is ${expected}\n`);
      return false;
    }
    this._activeTurnId = turnId;
    if (this._turnCompletion) this._turnCompletion.turnId = turnId;
    if (this._startingTurnRouting) {
      this._turnRoutingById.set(turnId, this._startingTurnRouting);
      this._startingTurnRouting = null;
      while (this._turnRoutingById.size > 100) {
        const oldest = this._turnRoutingById.keys().next().value;
        if (typeof oldest !== 'string') break;
        this._turnRoutingById.delete(oldest);
      }
    }
    return true;
  }

  private shouldIgnoreTurnEvent(kind: string, turnId: string | null): boolean {
    if (turnId && this._retiredTurnIds.has(turnId)) {
      this._outputBuffer.push(`[codex-app-server] ignored late ${kind} for retired turn ${turnId}\n`);
      return true;
    }
    const expected = this._activeTurnId ?? this._turnCompletion?.turnId ?? null;
    if (expected && turnId !== expected) {
      this._outputBuffer.push(
        `[codex-app-server] ignored ${kind} for ${turnId ?? 'an unbound turn'}; current turn is ${expected}\n`,
      );
      return true;
    }
    if (!expected && turnId && this._turnCompletion) {
      this._turnCompletion.turnId = turnId;
      this._activeTurnId = turnId;
    }
    return false;
  }

  private retireTurn(turnId: string): void {
    this._retiredTurnIds.add(turnId);
    this._turnRoutingById.delete(turnId);
    while (this._retiredTurnIds.size > 100) {
      const oldest = this._retiredTurnIds.values().next().value;
      if (typeof oldest !== 'string') break;
      this._retiredTurnIds.delete(oldest);
    }
  }

  private createTurnCompletion(workItemId: string, turnId: string | null = null): Promise<RemoteTurnStatus> {
    if (this._turnCompletion) {
      this.rejectTurnCompletion(new Error('Superseded by a new turn'));
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this._turnCompletion?.workItemId !== workItemId) return;
        this._turnCompletion = null;
        reject(new Error('Timed out waiting for turn/completed'));
      }, this._turnCompletionTimeoutMs);
      this._turnCompletion = { resolve, reject, timer, turnId, workItemId };
    });
  }

  private resolveTurnCompletion(status: RemoteTurnStatus = 'completed'): void {
    if (!this._turnCompletion) return;
    const pending = this._turnCompletion;
    this._turnCompletion = null;
    clearTimeout(pending.timer);
    pending.resolve(status);
  }

  private rejectTurnCompletion(err: Error): void {
    if (!this._turnCompletion) return;
    const pending = this._turnCompletion;
    this._turnCompletion = null;
    clearTimeout(pending.timer);
    pending.reject(err);
  }

  private abandonTurnCompletion(): void {
    if (!this._turnCompletion) return;
    clearTimeout(this._turnCompletion.timer);
    this._turnCompletion = null;
  }

  private emitUnsupportedRequestEvent(method: string): void {
    try {
      const paths = resolvePaths(this._env.agentName, this._env.instanceId, this._env.org);
      logEvent(
        paths,
        this._env.agentName,
        this._env.org,
        'error',
        'codex_app_server_unsupported_request',
        'error',
        {
          runtime: 'codex-app-server',
          method,
          thread_id: this._threadId,
        },
      );
    } catch {
      // OutputBuffer warning above is the user-visible fallback.
    }
  }

  private setThreadId(threadId: string): void {
    this._threadId = threadId;
    const state: ThreadState = {
      threadId,
      cwd: this._cwd,
      updatedAt: new Date().toISOString(),
    };
    writeFileSync(this._threadStatePath, `${JSON.stringify(state, null, 2)}\n`, 'utf-8');
  }

  /**
   * Translate a `thread/tokenUsage/updated` notification from codex-app-server
   * into the context_status.json shape consumed by the FastChecker context
   * monitor. Writes atomically; failures are non-fatal (observability only).
   *
   * Mapping (per codex schema ThreadTokenUsageUpdatedNotification):
   *   - used_percentage = last.inputTokens / cap * 100  (clamped to [0, 100])
   *   - context_window_size = modelContextWindow ?? config.codex_context_cap ?? 256000
   *   - exceeds_200k_tokens = last.inputTokens > 200000
   *   - current_usage.{input,output,cache_read} from last.{input,output,cachedInput}Tokens
   *   - session_id = current threadId
   */
  private writeContextStatus(params: Record<string, unknown>): void {
    const tokenUsage = isRecord(params.tokenUsage) ? params.tokenUsage : null;
    if (!tokenUsage) return;
    const last = isRecord(tokenUsage.last) ? tokenUsage.last : null;
    if (!last) return;
    const currentWindowInputTokens = typeof last.inputTokens === 'number' ? last.inputTokens : null;
    if (currentWindowInputTokens === null) return;

    const modelContextWindow = typeof tokenUsage.modelContextWindow === 'number'
      ? tokenUsage.modelContextWindow
      : null;
    const cap = modelContextWindow ?? this._config.codex_context_cap ?? 256000;
    const usedPct = cap > 0
      ? Math.min(100, Math.max(0, (currentWindowInputTokens / cap) * 100))
      : null;

    const inputTokens = currentWindowInputTokens;
    const outputTokens = typeof last.outputTokens === 'number' ? last.outputTokens : 0;
    // Codex invariant, verified from rollout samples and live notification
    // payloads: last.inputTokens is the full current-window size and already
    // includes cachedInputTokens. cachedInputTokens is a subset of inputTokens
    // (cached <= input), while total tokens = input + output. Do not add
    // cachedInputTokens to this metric; unlike Anthropic cache_read semantics,
    // that would double-count the cached subset and trigger premature handoffs.
    const cachedInputTokens = typeof last.cachedInputTokens === 'number' ? last.cachedInputTokens : 0;

    const payload = JSON.stringify({
      used_percentage: usedPct,
      context_window_size: cap,
      exceeds_200k_tokens: currentWindowInputTokens > 200000,
      current_usage: {
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        cache_read_input_tokens: cachedInputTokens,
        cache_creation_input_tokens: 0,
      },
      session_id: this._threadId,
      written_at: new Date().toISOString(),
    });

    try {
      atomicWriteSync(join(this._stateDir, 'context_status.json'), payload);
    } catch {
      // Non-fatal: FastChecker will skip stale/missing files gracefully.
    }
  }

  /**
   * Append a per-turn token usage record to <ctxRoot>/logs/<agent>/codex-tokens.jsonl
   * so the dashboard cost-parser can scan it alongside ~/.claude/projects/*.jsonl.
   * One JSONL line per `thread/tokenUsage/updated` notification; dedup by
   * (session_id, turn_id) is the parser's responsibility.
   */
  private appendCodexTokenLog(params: Record<string, unknown>): void {
    const tokenUsage = isRecord(params.tokenUsage) ? params.tokenUsage : null;
    if (!tokenUsage) return;
    const total = isRecord(tokenUsage.total) ? tokenUsage.total : null;
    if (!total) return;

    const turnId = typeof params.turnId === 'string' ? params.turnId : null;
    if (!turnId || !this._threadId) return;

    const effective = this._turnRoutingById.get(turnId);

    const entry = {
      timestamp: new Date().toISOString(),
      // Log the model we actually SEND on the turn (resolveSafeModel), not the
      // raw config — keeps the token-log label honest with the request so it
      // can never mask an unsafe-model default again.
      model: effective?.model ?? resolveSafeModel(this._config.model),
      input_tokens: typeof total.inputTokens === 'number' ? total.inputTokens : 0,
      output_tokens: typeof total.outputTokens === 'number' ? total.outputTokens : 0,
      cache_read_tokens: typeof total.cachedInputTokens === 'number' ? total.cachedInputTokens : 0,
      cache_write_tokens: 0,
      session_id: this._threadId,
      turn_id: turnId,
      ...(effective?.routing ? {
        routing_source: effective.routing.source,
        cron_name: effective.routing.cronName,
        routing_reason: effective.routing.reason,
        skill_name: effective.routing.skillName ?? null,
        requested_model: effective.routing.requestedModel ?? null,
        requested_effort: effective.routing.effort ?? null,
      } : {}),
    };

    try {
      const logDir = join(this._env.ctxRoot, 'logs', this._env.agentName);
      ensureDir(logDir);
      appendFileSync(join(logDir, 'codex-tokens.jsonl'), `${JSON.stringify(entry)}\n`);
    } catch {
      // Non-fatal: cost reporting is observability only.
    }
  }

  private readThreadState(): ThreadState | null {
    if (!existsSync(this._threadStatePath)) return null;
    try {
      const parsed = JSON.parse(readFileSync(this._threadStatePath, 'utf-8')) as ThreadState;
      return parsed.cwd === this._cwd && parsed.threadId ? parsed : null;
    } catch {
      return null;
    }
  }

  private resolveSocketPath(): { path: string; listenArg: string; cwd: string } {
    const defaultPath = join(this._stateDir, SOCKET_BASENAME);
    if (Buffer.byteLength(defaultPath) < SOCKET_PATH_WARN_BYTES) {
      return { path: defaultPath, listenArg: `unix://./${SOCKET_BASENAME}`, cwd: this._stateDir };
    }

    const fallbackBasename = `cas-${randomBytes(4).toString('hex')}.sock`;
    const fallback = join('/tmp', fallbackBasename);
    const pointer: SocketPointer = {
      socketPath: fallback,
      fallback: true,
      reason: 'state socket path exceeded 100 bytes',
      updatedAt: new Date().toISOString(),
    };
    try {
      ensureDir(this._stateDir);
      writeFileSync(this._socketPointerPath, `${JSON.stringify(pointer, null, 2)}\n`, 'utf-8');
    } catch {
      // Non-fatal; spawn will still use fallback path.
    }
    return { path: fallback, listenArg: `unix://./${fallbackBasename}`, cwd: '/tmp' };
  }

  private removeSocket(): void {
    try {
      if (existsSync(this._socketPath)) unlinkSync(this._socketPath);
    } catch {
      // Ignore stale socket cleanup failures.
    }
  }

  private cleanupSpawnAttempt(): void {
    this.stopPidPoll();
    this._rpcMessageUnsubscribe?.();
    this._rpcMessageUnsubscribe = null;
    this._rpcDisconnectUnsubscribe?.();
    this._rpcDisconnectUnsubscribe = null;
    if (this._rpc) {
      this._rpc.close();
      this._rpc = null;
    }
    const pty = this._appServerPty;
    this._appServerPty = null;
    if (pty) {
      try {
        pty.kill();
      } catch {
        // Ignore failed attempt cleanup errors.
      }
    }
    this._rpcEndpoint = null;
    this.removeSocket();
  }

  private writeIdleFlag(): void {
    try {
      writeFileSync(join(this._stateDir, 'last_idle.flag'), Math.floor(Date.now() / 1000).toString(), 'utf-8');
    } catch {
      // Non-fatal.
    }
  }

  private maybeFireTyping(): void {
    if (!this._telegramApi || !this._chatId) return;
    const now = Date.now();
    if (now - this._typingLastSent < 4000) return;
    this._typingLastSent = now;
    this._telegramApi.sendChatAction(this._chatId, 'typing').catch(() => { /* non-fatal */ });
  }

  private buildEnv(): Record<string, string> {
    const env: Record<string, string> = {};

    const keepVars = ['PATH', 'HOME', 'USER', 'SHELL', 'TERM', 'LANG', 'LC_ALL', 'TMPDIR'];
    for (const key of keepVars) {
      if (process.env[key]) env[key] = process.env[key]!;
    }

    env['CTX_INSTANCE_ID'] = this._env.instanceId;
    env['CTX_ROOT'] = this._env.ctxRoot;
    env['CTX_FRAMEWORK_ROOT'] = this._env.frameworkRoot;
    env['CTX_AGENT_NAME'] = this._env.agentName;
    env['CTX_ORG'] = this._env.org;
    env['CTX_AGENT_DIR'] = this._env.agentDir;
    env['CTX_PROJECT_ROOT'] = this._env.projectRoot;

    if (this._env.org && this._env.projectRoot) {
      this.loadEnvFile(join(this._env.projectRoot, 'orgs', this._env.org, 'secrets.env'), env);
    }
    this.loadEnvFile(join(this._env.agentDir, '.env'), env);

    if (env['CHAT_ID']) env['CTX_TELEGRAM_CHAT_ID'] = env['CHAT_ID'];
    if (this._config.timezone) {
      env['CTX_TIMEZONE'] = this._config.timezone;
      env['TZ'] = this._config.timezone;
    }

    return env;
  }

  /**
   * Load a KEY=VALUE env file into `env`.
   *
   * Delegates to parseEnvFile (utils/env.ts), the canonical reader, which strips
   * surrounding quotes and tolerates BOM/CRLF. This method previously parsed the
   * file itself and did NOT strip quotes, so a quoted value reached the codex
   * session with its quote characters attached — the same defect fixed in
   * agent-pty.ts. Keeping the two in step matters because a value has to survive
   * BOTH paths identically; a fix applied to one is a silent divergence.
   *
   * Deliberately the TOLERANT reader, unlike AgentPTY which uses the strict one.
   * This method already swallowed read errors before the change (its own
   * try/catch returned silently), so `parseEnvFile` preserves the existing
   * contract exactly. The two call sites differ in failure semantics on purpose;
   * making them uniform would be a behaviour change smuggled in as cleanup.
   */
  private loadEnvFile(path: string, env: Record<string, string>): void {
    if (!existsSync(path)) return;
    Object.assign(env, parseEnvFile(path, { stripInlineComments: false }));
  }

  private getPackageVersion(): string {
    try {
      const pkg = require('../../package.json') as { version?: string };
      return pkg.version || '0.0.0';
    } catch {
      return '0.0.0';
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isRemoteTurnStatus(value: unknown): value is RemoteTurnStatus {
  return value === 'completed' || value === 'interrupted' || value === 'failed' || value === 'inProgress';
}

function readCompletedTurnStatus(params: Record<string, unknown>): RemoteTurnStatus {
  const nested = isRecord(params.turn) ? params.turn.status : undefined;
  const status = nested ?? params.status;
  return isRemoteTurnStatus(status) ? status : 'completed';
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Ask the kernel for an unused TCP port on loopback.
 *
 * `createServer().listen(0)` lets the OS pick a free ephemeral port; we read it
 * back from the bound address, then close the server so codex app-server can
 * claim it. There is a small TOCTOU window between close and codex bind, but
 * collisions are vanishingly rare on loopback ephemeral ports — and a fresh
 * spawn attempt will reallocate via the existing retry loop if it does happen.
 */
function allocateFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (typeof addr === 'object' && addr && 'port' in addr) {
        const port = addr.port;
        server.close(() => resolve(port));
      } else {
        server.close(() => reject(new Error('Failed to allocate ephemeral port')));
      }
    });
  });
}
