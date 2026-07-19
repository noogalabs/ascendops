import { appendFileSync, existsSync, readFileSync, unlinkSync, writeFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { randomBytes } from 'crypto';
import { createServer, createConnection } from 'net';
import type { AgentConfig, CtxEnv } from '../types/index.js';
import { OutputBuffer } from './output-buffer.js';
import type { TelegramAPI } from '../telegram/api.js';
import { ensureDir, atomicWriteSync } from '../utils/atomic.js';
import { resolvePaths } from '../utils/paths.js';
import { logEvent } from '../bus/event.js';
import { WsUnixJsonRpcClient, type JsonRpcResponse } from '../utils/ws-unix-client.js';

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
  configured_model: string;
  used_model: string;
  alerted_at: string;
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
// ENTITLEMENT NOTE (2026-06-04, proven by billed live turns): this ChatGPT
// account is NOT entitled to the codex-specialized models — BOTH gpt-5.3-codex
// AND gpt-5-codex return 400 "not supported when using Codex with a ChatGPT
// account". gpt-5.5 (general) is the only entitled/working executor model here,
// so it is the DEFAULT. gpt-5-codex is kept in SAFE_MODELS deliberately as the
// one-config-edit switch-back: if the Codex plan is upgraded to entitle it, set
// an agent's config.model=gpt-5-codex (the better executor) and resolveSafeModel
// will pass it through. The DEFAULT must always be an entitled model — an earlier
// gpt-5-codex default was an unproven assumption that 400'd; gpt-5.5 is proven.
const SAFE_MODELS: readonly string[] = ['gpt-5.5', 'gpt-5-codex'];
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
  private _writeBuffer = '';
  private _turnQueue: unknown[][] = [];
  private _turnCompletion: {
    resolve: () => void;
    reject: (err: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  } | null = null;
  private _spawnFn: SpawnFn | null = null;
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
      if (state?.configured_model === configured && state.used_model === DEFAULT_SAFE_MODEL) {
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
    } catch {
      /* non-fatal: alerting remains re-armed in memory for this lifecycle */
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
      await this.startOrResumeThread(mode);
      this._outputBuffer.push(`${BOOTSTRAP_PATTERN} thread=${this._threadId}\n`);
      this.reconcileModelGateAlert();
      if (prompt.trim()) {
        this.queueTurn([{ type: 'text', text: prompt, text_elements: [] }]);
      }
    } catch (err) {
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

  kill(): void {
    this._alive = false;
    this._activeTurnId = null;
    this._turnQueue = [];
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
    this._writeBuffer = '';
    this._turnQueue = [];
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

  private async handleInput(content: string): Promise<void> {
    const extracted = this.extractTelegramPayload(content);
    const input = extracted?.payload ?? content;
    const goalCommand = this.parseGoalCommand(input);
    if (goalCommand?.type === 'get') {
      await this.getGoal();
      return;
    }
    if (goalCommand?.type === 'clear') {
      await this.clearGoal();
      return;
    }
    if (goalCommand?.type === 'set') {
      await this.setGoal(goalCommand.objective);
      return;
    }
    if (input.startsWith('$')) {
      await this.handleSkillInput(input);
      return;
    }
    const slashMatch = input.match(SLASH_REWRITE_RE);
    if (slashMatch && !LOCAL_SLASH_COMMANDS.has(slashMatch[1].toLowerCase())) {
      const [, name, trailing] = slashMatch;
      const trimmed = trailing?.trim();
      const rewritten = trimmed ? `$${name} ${trimmed}` : `$${name}`;
      await this.handleSkillInput(rewritten);
      return;
    }
    const turnText = extracted?.replyDirective
      ? `${input}\n\n${extracted.replyDirective}`
      : input;
    this.queueTurn([{ type: 'text', text: turnText, text_elements: [] }]);
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
    if (!this._spawnFn) {
      const nodePty = require('node-pty');
      this._spawnFn = nodePty.spawn;
    }

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

  private async startOrResumeThread(mode: 'fresh' | 'continue'): Promise<void> {
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
   * Mid-turn parity with the Claude PTY-injection path: while a turn is
   * executing, try `turn/steer` so the message lands in the active turn at the
   * next model step instead of waiting for turn/completed. Any steer rejection
   * (ExpectedTurnMismatch = turn just ended, ActiveTurnNotSteerable =
   * review/compact, NoActiveTurn, transport error) falls back to the queue, so
   * no message is ever lost. CODEX_STEER_DISABLED=1 reverts to pure queueing.
   */
  private queueTurn(input: unknown[]): void {
    if (this._executing && this._activeTurnId && process.env.CODEX_STEER_DISABLED !== '1') {
      this.steerActiveTurn(input).catch((err) => {
        this._outputBuffer.push(`[codex-app-server] steer path failed: ${err}\n`);
      });
      return;
    }
    this.enqueueTurn(input);
  }

  private async steerActiveTurn(input: unknown[]): Promise<void> {
    const expectedTurnId = this._activeTurnId;
    if (!this._threadId || !expectedTurnId) {
      this.enqueueTurn(input);
      return;
    }
    try {
      await this.request('turn/steer', {
        threadId: this._threadId,
        expectedTurnId,
        input,
      });
      this._outputBuffer.push(`[codex-app-server] steered active turn ${expectedTurnId}\n`);
    } catch (err) {
      // Do not retry steer here: the rejection may be a non-steerable turn
      // (review/compact). Queueing guarantees delivery right after it ends.
      this._outputBuffer.push(`[codex-app-server] steer rejected, queueing: ${err}\n`);
      this.enqueueTurn(input);
    }
  }

  private enqueueTurn(input: unknown[]): void {
    this._turnQueue.push(input);
    if (!this._executing) {
      this.drainQueue().catch((err) => {
        this._outputBuffer.push(`[codex-app-server] turn queue failed: ${err}\n`);
      });
    }
  }

  private async drainQueue(): Promise<void> {
    while (this._alive && this._turnQueue.length > 0) {
      const input = this._turnQueue.shift()!;
      this._executing = true;
      try {
        await this.startTurn(input);
      } finally {
        this._executing = false;
      }
    }
  }

  private async startTurn(input: unknown[]): Promise<void> {
    if (!this._threadId) throw new Error('No Codex app-server thread is active');
    const completion = this.createTurnCompletion();
    await this.request('turn/start', { threadId: this._threadId, input, model: resolveSafeModel(this._config.model), ...TURN_PERMISSION_OVERRIDES });
    await completion;
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

  private async handleSkillInput(content: string): Promise<void> {
    const match = content.match(/^\$([A-Za-z0-9:_-]+)(?:\s+([\s\S]*))?$/);
    if (!match) {
      this.replyLocal('[skill] expected $skill_name [text]');
      return;
    }

    const [, skillName, trailingText] = match;
    const skills = await this.request<SkillsListResponse>('skills/list', {
      cwds: [this._cwd],
      forceReload: false,
    });
    const allSkills = (skills.result?.data || []).flatMap((entry) => entry.skills || []);
    const exact = allSkills.find((skill) => skill.enabled !== false && skill.name === skillName);
    if (!exact) {
      const matches = allSkills
        .filter((skill) => skill.enabled !== false && skill.name.includes(skillName))
        .slice(0, 5)
        .map((skill) => skill.name);
      this.replyLocal(matches.length > 0
        ? `[skill] unknown "${skillName}". Did you mean: ${matches.join(', ')}?`
        : `[skill] unknown "${skillName}". No enabled matches found.`);
      return;
    }

    const input: unknown[] = [{ type: 'skill', name: exact.name, path: exact.path }];
    if (trailingText?.trim()) {
      input.push({ type: 'text', text: trailingText.trim(), text_elements: [] });
    }
    this.queueTurn(input);
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
        if (isRecord(params.turn) && typeof params.turn.id === 'string') {
          this._activeTurnId = params.turn.id;
        }
        this.maybeFireTyping();
        this._outputBuffer.push('[codex-app-server] turn started\n');
        break;
      case 'turn/completed':
        this._activeTurnId = null;
        this.writeIdleFlag();
        this._outputBuffer.push('[codex-app-server] turn completed\n');
        this.resolveTurnCompletion();
        break;
      case 'item/agentMessage/delta':
        if (typeof params.delta === 'string') {
          this._outputBuffer.push(params.delta);
        }
        this.maybeFireTyping();
        break;
      case 'item/completed':
        if (isRecord(params.item) && params.item.type === 'agentMessage' && typeof params.item.text === 'string') {
          this._outputBuffer.push('\n');
        }
        break;
      case 'turn/plan/updated':
      case 'item/plan/delta':
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
        this._activeTurnId = null;
        this._outputBuffer.push(`[codex-app-server] error: ${JSON.stringify(params)}\n`);
        this.rejectTurnCompletion(new Error(JSON.stringify(params)));
        break;
      case 'thread/tokenUsage/updated':
        this.writeContextStatus(params);
        this.appendCodexTokenLog(params);
        this._outputBuffer.push(`[codex-app-server:event] ${method}\n`);
        break;
      case 'warning':
      case 'mcpServer/startupStatus/updated':
      case 'account/rateLimits/updated':
      case 'skills/changed':
      case 'item/started':
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

  private createTurnCompletion(timeoutMs = 30 * 60 * 1000): Promise<void> {
    if (this._turnCompletion) {
      this.rejectTurnCompletion(new Error('Superseded by a new turn'));
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._turnCompletion = null;
        reject(new Error('Timed out waiting for turn/completed'));
      }, timeoutMs);
      this._turnCompletion = { resolve, reject, timer };
    });
  }

  private resolveTurnCompletion(): void {
    if (!this._turnCompletion) return;
    const pending = this._turnCompletion;
    this._turnCompletion = null;
    clearTimeout(pending.timer);
    pending.resolve();
  }

  private rejectTurnCompletion(err: Error): void {
    if (!this._turnCompletion) return;
    const pending = this._turnCompletion;
    this._turnCompletion = null;
    clearTimeout(pending.timer);
    pending.reject(err);
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

    const entry = {
      timestamp: new Date().toISOString(),
      // Log the model we actually SEND on the turn (resolveSafeModel), not the
      // raw config — keeps the token-log label honest with the request so it
      // can never mask an unsafe-model default again.
      model: resolveSafeModel(this._config.model),
      input_tokens: typeof total.inputTokens === 'number' ? total.inputTokens : 0,
      output_tokens: typeof total.outputTokens === 'number' ? total.outputTokens : 0,
      cache_read_tokens: typeof total.cachedInputTokens === 'number' ? total.cachedInputTokens : 0,
      cache_write_tokens: 0,
      session_id: this._threadId,
      turn_id: turnId,
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

  private loadEnvFile(path: string, env: Record<string, string>): void {
    if (!existsSync(path)) return;
    try {
      for (const line of readFileSync(path, 'utf-8').split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eqIdx = trimmed.indexOf('=');
        if (eqIdx > 0) {
          env[trimmed.slice(0, eqIdx).trim()] = trimmed.slice(eqIdx + 1).trim();
        }
      }
    } catch {
      // Ignore env file read errors.
    }
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
