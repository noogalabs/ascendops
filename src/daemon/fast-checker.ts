import { readdirSync, readFileSync, existsSync, writeFileSync, unlinkSync, statSync, openSync, readSync, closeSync, watch, type FSWatcher } from 'fs';
import { execFile } from 'child_process';
import { join } from 'path';
import { createHash } from 'crypto';
import { hardRestart } from '../bus/system.js';
import type { InboxMessage, BusPaths, TelegramMessage, TelegramCallbackQuery, Event, TeamMember } from '../types/index.js';
import { checkInbox, ackInbox, sendMessage } from '../bus/message.js';
import { updateApproval } from '../bus/approval.js';
import { AgentProcess } from './agent-process.js';
import type { TelegramAPI } from '../telegram/api.js';
import { SlackAPI, type SlackMessage } from '../slack/api.js';
import {
  resolveSlackIdentity,
  evaluateSlackTrust,
  formatSlackOriginator,
} from '../slack/slack-identity.js';
import { KEYS } from '../pty/inject.js';
import { stripControlChars, sanitizeForPtyInjection, wrapFenceSafe, validateOrgName } from '../utils/validate.js';
import { resolve as pathResolve } from 'path';
import { atomicWriteSync } from '../utils/atomic.js';
import { logEvent } from '../bus/event.js';
import { updateHeartbeat } from '../bus/heartbeat.js';
// added 2026-04-29 via internal dispatch — RFC #15 Day-1 dispatcher integration; Piece 3 (handler-type wiring) deferred to Day-2
import { loadHookRegistry, matchHooks, dispatchHook, type HookRegistry } from '../bus/hooks.js';
import { registerBuiltInHandlers } from '../bus/hook-handlers/index.js';
import { agentHoldsContextHandoffLease, releaseContextHandoffLease, requestContextHandoffLease } from './context-handoff-lease.js';

type LogFn = (msg: string) => void;

type AskStateQuestion = {
  question: string;
  header: string;
  options: string[];
  multiSelect?: boolean;
};

type AskState = {
  total_questions: number;
  current_question: number;
  questions: AskStateQuestion[];
  multi_select_chosen?: number[];
};

type ContextStatus = {
  written_at: string;
  used_percentage: number | null;
  exceeds_200k_tokens: boolean;
  session_id?: string;
};

type WatchdogRestartMarker = {
  restartedAt: number;
  stdoutHighWater: number;
};

const ANSI_OSC_RE = /\x1b\][^\x07]*(?:\x07|\x1b\\)/g;
const ANSI_CSI_RE = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const SPINNER_ONLY_RE = /^[\s⠀-⣿|/\\\-◐-◓◰-◳✢✳✶✻✽·•*+◯○●◦]+$/u;
const SPINNER_STATUS_RE = /^[⠀-⣿◐-◓◰-◳✢✳✶✻✽·◯○●◦]\s*/u;
const STATUS_SHAPED_PREFIX_RE = /^[⠀-⣿|/\\\-◐-◓◰-◳✢✳✶✻✽·•*+◯○●◦]/u;
const MAX_MEANINGFUL_STDOUT_DELTA_BYTES = 256 * 1024;

export function meaningfulPrintableLines(chunk: string): string[] {
  return chunk
    .replace(ANSI_OSC_RE, '')
    .replace(ANSI_CSI_RE, '')
    .split(/[\r\n]+/)
    .map((line) => line.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '').trim())
    .filter((line) => line.length > 0 && !SPINNER_ONLY_RE.test(line) && !SPINNER_STATUS_RE.test(line));
}

function normalizeStatusLineForFingerprint(line: string): string {
  const statusShaped = STATUS_SHAPED_PREFIX_RE.test(line) || /tokens|↓|↑|esc to interrupt/i.test(line);
  return statusShaped ? line.replace(/\d+/g, '#') : line;
}

type FileRangeOps = {
  openSync: (path: string, flags: string) => number;
  readSync: (fd: number, buffer: Buffer, offset: number, length: number, position: number) => number;
  closeSync: (fd: number) => void;
};

export function readFileRangeSync(
  path: string,
  position: number,
  length: number,
  ops: FileRangeOps = { openSync, readSync, closeSync },
): Buffer {
  const fd = ops.openSync(path, 'r');
  try {
    const buffer = Buffer.alloc(length);
    ops.readSync(fd, buffer, 0, length, position);
    return buffer;
  } finally {
    ops.closeSync(fd);
  }
}

/**
 * Post-boot grace window (ms) during which soft context-handoff actions are
 * suppressed. Runtime-aware: codex-app-server and opencode briefly report
 * inflated prior prompt-cache context tokens, and that spurious spike can land
 * ~6-8min after a fresh boot (observed double-handoffs ~6-8min apart on a codex
 * agent), OUTSIDE a short grace. Those runtimes get a 10min window; all others
 * keep the original 2min.
 */
export function handoffGraceMs(runtime: string | undefined): number {
  if (runtime === 'codex-app-server' || runtime === 'opencode') return 600_000;
  return 120_000;
}

/**
 * Fast message checker for a single agent.
 * Replaces fast-checker.sh: polls Telegram and inbox, injects into PTY.
 */
export class FastChecker {
  private agent: AgentProcess;
  private paths: BusPaths;
  private running: boolean = false;
  private pollInterval: number;
  private log: LogFn;
  private typingLastSent: number = 0;
  // Hook-based typing: track when we last injected a Telegram message (ms)
  private lastMessageInjectedAt: number = 0;
  // Track outbound message log size to detect when agent sends a reply
  private outboundLogSize: number = 0;
  // Track stdout log size to detect when agent is actively producing output
  private stdoutLogSize: number = -1;
  private frameworkRoot: string;
  private telegramApi?: TelegramAPI;
  private chatId?: string;
  private allowedUserIds?: number[];

  // External Telegram handler (set by daemon)
  private telegramMessages: Array<{ formatted: string; ackIds: string[] }> = [];

  // Persistent dedup: message hashes to prevent duplicate delivery
  private seenHashes: Set<string> = new Set();
  private dedupFilePath: string = '';

  // SIGUSR1 wake: resolve to immediately wake from sleep
  private wakeResolve: (() => void) | null = null;

  // Idle-session heartbeat watchdog
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private pollCycleWatchdog: NodeJS.Timeout | null = null;

  // Gmail watch state
  private gmailWatch?: { query: string; intervalMs: number; processedLabelId?: string };
  private gmailLastCheckedAt: number = 0;
  private gmailLastCheckedPath: string = '';
  // Delivered-message-ID set with 30d TTL: id → delivery timestamp (ms).
  // Label-based exclusion is the primary dedup mechanism when configured;
  // this TTL is a safety net for queries that do not use processedLabelId.
  private gmailDeliveredIds: Map<string, number> = new Map();
  private gmailDeliveredIdsPath: string = '';
  private readonly GMAIL_DELIVERED_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30d
  // F8: Gmail checks run on their own timer (armed in start()), NOT inside
  // pollCycle — the worst-case Gmail batch takes minutes and would trip the
  // 30s pollCycle timeout. The tick is intentionally shorter than the watch
  // interval; checkGmailWatch self-gates on gmailWatch.intervalMs.
  private gmailWatchTimer: NodeJS.Timeout | null = null;
  private gmailCheckInFlight: boolean = false;
  private readonly GMAIL_TIMER_TICK_MS = 30_000;

  // Slack watch state
  private slackWatch?: { channel: string; intervalMs: number };
  private slackApi?: SlackAPI;
  private slackLastTs: string = '0';
  private slackLastCheckedAt: number = 0;
  private readonly SLACK_DEFAULT_INTERVAL_MS = 60 * 1000;
  // Slack identity + trust layer (P2 — text-enrich only).
  private slackTrustedUsers?: string[];
  private slackTeamMembers?: TeamMember[];
  // userId -> resolved identity; cache hits skip users.info.
  private slackIdentityCache: Map<string, { handle: string | null; displayName: string }> = new Map();
  // Loudly-open warning is logged at most once per checker instance.
  private slackOpenWarned: boolean = false;

  // Usage rate-limit guard state
  private usageLastCheckedAt: number = Date.now(); // skip check on startup; first run at 30-min mark
  private usageTier: 0 | 1 | 2 = 0; // 0=normal, 1=high(≥85%), 2=critical(≥95%)
  private usageTierFile: string = '';
  private readonly USAGE_CHECK_INTERVAL_MS = 30 * 60 * 1000;

  // Context-exhaustion + frozen-stdout watchdog state
  private bootstrappedAt: number = 0;
  private lastPollCycleCompletedAt: number = 0;
  private readonly POLL_CYCLE_TIMEOUT_MS = 30_000;
  // Circuit breaker state — track recent auto-restarts and pause the
  // watchdog if it keeps firing (upstream is down, restarting won't help)
  private watchdogRestarts: number[] = [];
  private watchdogCircuitBroken: boolean = false;
  private watchdogCircuitBrokenAt: number = 0;
  private readonly WATCHDOG_MAX_RESTARTS = 3;
  private readonly WATCHDOG_WINDOW_MS = 15 * 60 * 1000; // 15 min
  private readonly WATCHDOG_CIRCUIT_RESET_MS = 30 * 60 * 1000; // 30 min
  private lastHardRestartAt: number = 0;
  private watchdogRestartMarkerFile: string = '';
  private stdoutLastSize: number = 0;
  private stdoutLastChangeAt: number = 0;
  private watchdogTriggered: boolean = false;
  private readonly BOOTSTRAP_GRACE_MS = 10 * 60 * 1000;
  private readonly HARD_RESTART_COOLDOWN_MS = 15 * 60 * 1000;
  private readonly STDOUT_FROZEN_MS = 30 * 60 * 1000;
  private turnWatchdogThresholdMs: number = 30 * 60 * 1000;
  private turnWatchdogRecoveryFile: string = '';
  private turnWatchdogRecoveries: number[] = [];
  private turnWatchdogRecoveryStateValid: boolean = true;
  private turnWatchdogAlertedInjectAt: number = 0;
  private turnWatchdogTrackedInjectAt: number = 0;
  private stdoutMeaningfulOffset: number = -1;
  private meaningfulOutputFingerprints: Set<string> = new Set();
  private lastMeaningfulOutputAt: number = 0;
  private turnHung: boolean = false;
  private sessionStartedAt: number = Date.now();
  private idleFlagSeenThisSession: boolean = false;
  private idleFlagInactiveLogged: boolean = false;
  private readonly fileRangeOps: FileRangeOps;
  private readonly TURN_WATCHDOG_MAX_RECOVERIES = 2;
  private readonly TURN_WATCHDOG_WINDOW_MS = 6 * 60 * 60 * 1000;
  // Context-threshold graceful restart state (Signal 3)
  private ctxThresholdPct: number = 70;
  private ctxThresholdTriggeredAt: number = 0;
  private readonly CTX_THRESHOLD_COOLDOWN_MS = 10 * 60 * 1000;   // 10 min — no re-inject
  private readonly CTX_THRESHOLD_FALLBACK_MS = 15 * 60 * 1000;  // 15 min — hard-restart if ignored

  // Context monitor state
  private ctxConfigMtime: number = 0;
  private ctxWarningFiredAt: number = 0;    // dedup: 15min cooldown between warnings
  private ctxHandoffFiredAt: number = 0;    // fires once per session (0 = not yet)
  private ctxHandoffDeadlineAt: number = 0; // timestamp after which force-restart fires
  private ctxLastSessionId: string | null = null; // detects new session → clears stale deadline
  private ctxSessionStartedAt: number = 0; // when current session_id was first observed — handoff grace window anchor
  private ctxHandoffLeaseId: string | null = null;
  private ctxHandoffQueuedLogAt: number = 0;
  private ctxCircuitRestarts: number[] = []; // timestamps of recent context-triggered restarts
  private ctxHandoffFires: number[] = [];    // timestamps of recent Tier-2 handoff fires (cooperative-restart loop backstop)
  private ctxCircuitBrokenAt: number | null = null; // when circuit tripped (null = healthy)
  // Persisted to disk so --continue restarts don't reset the circuit breaker
  private ctxCircuitFile: string = '';

  // added 2026-04-29 via internal dispatch — RFC #15 Day-1 dispatcher integration; Piece 3 (handler-type wiring) deferred to Day-2
  // Hook dispatcher state. Inert until Day-1 wiring runs in start().
  // Per RFC #15 §9 fail-open: if org cannot be resolved (no CTX_ORG env, no
  // registry file), the dispatcher stays disabled and never fires hooks.
  private hookRegistry: HookRegistry = { schema_version: '0.1', hooks: [] };
  private hookRegistryPath: string = '';
  private hookRegistryWatcher: FSWatcher | null = null;
  private eventLogTailer: NodeJS.Timeout | null = null;
  private eventLogPosition: number = 0;
  private eventLogCurrentPath: string = '';
  private readonly EVENT_LOG_TAIL_INTERVAL_MS = 500;
  // TODO(RFC #15 Day-2): pass org via constructor; today we read CTX_ORG from
  // process.env which is set by the daemon when it spawns each agent's
  // fast-checker context. Falls back to inert dispatcher if env is missing.
  private hookOrg: string | null = null;

  private isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }

  private logCriticalValidationError(filePath: string, detail: string): void {
    console.error(`[fast-checker] CRITICAL: ${filePath} ${detail}`);
  }

  private validateAskState(raw: unknown, filePath: string): AskState | null {
    if (!this.isPlainObject(raw)) {
      this.logCriticalValidationError(filePath, 'invalid top-level shape: expected object');
      return null;
    }
    if (typeof raw.total_questions !== 'number') {
      this.logCriticalValidationError(filePath, 'invalid total_questions: expected number');
      return null;
    }
    if (typeof raw.current_question !== 'number') {
      this.logCriticalValidationError(filePath, 'invalid current_question: expected number');
      return null;
    }
    if (!Array.isArray(raw.questions)) {
      this.logCriticalValidationError(filePath, 'invalid questions: expected array');
      return null;
    }
    for (let i = 0; i < raw.questions.length; i++) {
      const question = raw.questions[i];
      if (!this.isPlainObject(question)) {
        this.logCriticalValidationError(filePath, `invalid questions[${i}]: expected object`);
        return null;
      }
      if (typeof question.question !== 'string') {
        this.logCriticalValidationError(filePath, `invalid questions[${i}].question: expected string`);
        return null;
      }
      if ('header' in question && typeof question.header !== 'string') {
        this.logCriticalValidationError(filePath, `invalid questions[${i}].header: expected string when present`);
        return null;
      }
      if (!Array.isArray(question.options) || question.options.some(option => typeof option !== 'string')) {
        this.logCriticalValidationError(filePath, `invalid questions[${i}].options: expected array of strings`);
        return null;
      }
      if ('multiSelect' in question && typeof question.multiSelect !== 'boolean') {
        this.logCriticalValidationError(filePath, `invalid questions[${i}].multiSelect: expected boolean when present`);
        return null;
      }
    }
    if (
      'multi_select_chosen' in raw &&
      (!Array.isArray(raw.multi_select_chosen) || raw.multi_select_chosen.some(index => typeof index !== 'number'))
    ) {
      this.logCriticalValidationError(filePath, 'invalid multi_select_chosen: expected array of numbers when present');
      return null;
    }
    return raw as AskState;
  }

  private validateContextStatus(raw: unknown, filePath: string): ContextStatus | null {
    if (!this.isPlainObject(raw)) {
      this.logCriticalValidationError(filePath, 'invalid top-level shape: expected object');
      return null;
    }
    if (typeof raw.written_at !== 'string') {
      this.logCriticalValidationError(filePath, 'invalid written_at: expected string');
      return null;
    }
    if (typeof raw.exceeds_200k_tokens !== 'boolean') {
      this.logCriticalValidationError(filePath, 'invalid exceeds_200k_tokens: expected boolean');
      return null;
    }
    if (!('used_percentage' in raw)) {
      // Absent used_percentage is a legitimate skip (status not yet computed /
      // partial write), not a corruption. Skip cleanly without the CRITICAL log;
      // a present-but-wrong-type value below still errors.
      return null;
    }
    if (raw.used_percentage === null) {
      // Null percentage is only actionable when the bridge also reports a hard
      // 200k overflow; otherwise it is a clean partial-write/status-not-ready skip.
      return raw.exceeds_200k_tokens ? raw as ContextStatus : null;
    }
    if (typeof raw.used_percentage !== 'number') {
      this.logCriticalValidationError(filePath, 'invalid used_percentage: expected number');
      return null;
    }
    if ('session_id' in raw && typeof raw.session_id !== 'string') {
      this.logCriticalValidationError(filePath, 'invalid session_id: expected string when present');
      return null;
    }
    return raw as ContextStatus;
  }

  constructor(
    agent: AgentProcess,
    paths: BusPaths,
    frameworkRoot: string,
    options: {
      pollInterval?: number;
      log?: LogFn;
      telegramApi?: TelegramAPI;
      chatId?: string;
      allowedUserId?: number;
      allowedUserIds?: number[];
      gmailWatch?: { query: string; intervalMs: number; processedLabelId?: string };
      slackWatch?: {
        channel: string;
        intervalMs: number;
        token: string;
        trustedSlackUsers?: string[];
        teamMembers?: TeamMember[];
      };
      ctxRestartThreshold?: number;
      turnWatchdogThresholdMinutes?: number;
      fileRangeOps?: FileRangeOps;
    } = {},
  ) {
    this.agent = agent;
    this.paths = paths;
    this.frameworkRoot = frameworkRoot;
    this.pollInterval = options.pollInterval || 1000;
    this.log = options.log || ((msg) => console.log(`[fast-checker/${agent.name}] ${msg}`));
    this.telegramApi = options.telegramApi;
    this.chatId = options.chatId;
    this.allowedUserIds = options.allowedUserIds ?? (options.allowedUserId !== undefined ? [options.allowedUserId] : undefined);
    this.ctxThresholdPct = options.ctxRestartThreshold ?? 70;
    this.fileRangeOps = options.fileRangeOps ?? { openSync, readSync, closeSync };
    const turnThresholdMinutes = options.turnWatchdogThresholdMinutes ?? 30;
    this.turnWatchdogThresholdMs = Number.isFinite(turnThresholdMinutes) && turnThresholdMinutes > 0
      ? turnThresholdMinutes * 60_000
      : 30 * 60_000;

    // Initialize persistent dedup
    this.dedupFilePath = join(paths.stateDir, '.message-dedup-hashes');
    this.loadDedupHashes();
    this.watchdogRestartMarkerFile = join(paths.stateDir, '.watchdog-restart-at');
    this.turnWatchdogRecoveryFile = join(paths.stateDir, '.turn-watchdog-recoveries.json');
    this.loadTurnWatchdogRecoveries();

    // Initialize Gmail watch
    if (options.gmailWatch) {
      this.gmailWatch = options.gmailWatch;
      this.gmailLastCheckedPath = join(paths.stateDir, 'gmail-last-checked.txt');
      this.gmailDeliveredIdsPath = join(paths.stateDir, 'gmail-delivered-ids.json');
      this.loadGmailLastCheckedAt();
      this.loadGmailDeliveredIds();
    }

    if (options.slackWatch) {
      this.slackWatch = { channel: options.slackWatch.channel, intervalMs: options.slackWatch.intervalMs };
      this.slackApi = new SlackAPI(options.slackWatch.token);
      this.slackLastTs = (Date.now() / 1000).toFixed(6);
      this.slackTrustedUsers = options.slackWatch.trustedSlackUsers;
      this.slackTeamMembers = options.slackWatch.teamMembers;
    }

    // Initialize usage tier state
    this.usageTierFile = join(paths.stateDir, 'usage-tier.json');
    this.loadUsageTier();

    // Load persisted circuit breaker state so --continue restarts don't reset it
    this.ctxCircuitFile = join(paths.stateDir, '.ctx-circuit.json');
    this.loadCtxCircuit();
  }

  private isAllowedTelegramUser(fromUserId: number | undefined): boolean {
    if (!this.allowedUserIds || this.allowedUserIds.length === 0) return true;
    return typeof fromUserId === 'number' && this.allowedUserIds.includes(fromUserId);
  }

  /**
   * Start the polling loop.
   */
  async start(): Promise<void> {
    this.running = true;
    this.log('Starting. Waiting for bootstrap...');

    // Register SIGUSR1 handler for immediate wake
    const sigusr1Handler = () => {
      this.log('SIGUSR1 received - waking immediately');
      if (this.wakeResolve) {
        this.wakeResolve();
        this.wakeResolve = null;
      }
    };
    if (process.platform !== 'win32') {
      process.on('SIGUSR1', sigusr1Handler);
    }

    // Wait for bootstrap
    await this.waitForBootstrap();
    // F5: stop() may have landed while we were waiting (stop/restart within
    // the ~30s bootstrap window is common). stop() clears timers only if they
    // are already set — arming them now would orphan them: nothing would ever
    // clear them and the heartbeat would keep marking a STOPPED agent online.
    if (!this.running) {
      this.log('Stopped during bootstrap wait — not arming timers or poll loop');
      if (process.platform !== 'win32') {
        process.removeListener('SIGUSR1', sigusr1Handler);
      }
      return;
    }
    this.log('Bootstrap complete. Beginning poll loop.');
    this.bootstrappedAt = Date.now();
    this.stdoutLastChangeAt = Date.now();
    this.watchdogTriggered = false;

    // Idle-session heartbeat watchdog: fires every 50 min regardless of REPL state
    const HEARTBEAT_INTERVAL_MS = 50 * 60 * 1000;
    const agentName = this.agent.name;
    // Fire-time onboarding gate. An agent that has not finished onboarding must NOT
    // mint a watchdog heartbeat: the daemon's retro-write in agent-process.ts
    // buildStartupPrompt now fires ONLY when IDENTITY.md + MEMORY.md contain
    // non-template bootstrap content (our 2d129a68; upstream #667 removed the
    // heartbeat-only arm). Gating heartbeats until .onboarded is written prevents a
    // partially-onboarded agent from accumulating live-watchdog pings and ensures
    // the role-cron registration on the next restart is not skipped prematurely.
    // The check is INSIDE the callback so it re-evaluates every tick and auto-resumes
    // the instant onboarding writes .onboarded (no restart). Path matches
    // agent-process.ts (stateDir/.onboarded).
    const onboardedMarkerPath = join(this.paths.stateDir, '.onboarded');
    this.heartbeatTimer = setInterval(() => {
      if (!existsSync(onboardedMarkerPath)) return;
      if (this.turnHung) {
        this.log(`Heartbeat watchdog suppressed: ${agentName} has a HUNG open turn`);
        return;
      }
      const ts = new Date().toISOString();
      execFile(
        'cortextos',
        ['bus', 'update-heartbeat', `[watchdog] ${agentName} alive — idle session ${ts}`],
        { timeout: 10_000 },
        (err) => {
          if (!err) return;
          const e = err as NodeJS.ErrnoException & { killed?: boolean };
          if (e.killed) {
            this.log(`Heartbeat watchdog timed out (10s) — cortextos CLI did not return`);
          } else {
            this.log(`Heartbeat watchdog error: ${err.message}`);
          }
        },
      );
    }, HEARTBEAT_INTERVAL_MS);

    // Poll-cycle watchdog: if pollCycle hasn't completed in 90s, force-restart
    // the agent PTY. Runs on its own setInterval so it can't get stuck inside
    // the poll loop. Gives the hung operation 30s (pollCycle timeout) + 60s
    // buffer before deciding the session is truly wedged.
    this.lastPollCycleCompletedAt = Date.now();
    const WATCHDOG_INTERVAL_MS = 30 * 1000;
    const STALL_THRESHOLD_MS = 90 * 1000;
    this.pollCycleWatchdog = setInterval(() => {
      const now = Date.now();
      if (this.bootstrappedAt === 0) return;
      if (now - this.bootstrappedAt < STALL_THRESHOLD_MS) return;

      // Auto-reset circuit breaker after 30 min of quiet
      if (
        this.watchdogCircuitBroken &&
        now - this.watchdogCircuitBrokenAt > this.WATCHDOG_CIRCUIT_RESET_MS
      ) {
        this.watchdogCircuitBroken = false;
        this.watchdogRestarts = [];
        this.log('Watchdog circuit breaker reset after 30min quiet window');
      }
      if (this.watchdogCircuitBroken) return;

      const stallMs = now - this.lastPollCycleCompletedAt;
      if (stallMs <= STALL_THRESHOLD_MS) return;

      // Prune restart history older than the window
      this.watchdogRestarts = this.watchdogRestarts.filter(
        t => now - t < this.WATCHDOG_WINDOW_MS,
      );

      // Circuit break: too many restarts mean restart isn't fixing it
      if (this.watchdogRestarts.length >= this.WATCHDOG_MAX_RESTARTS) {
        this.watchdogCircuitBroken = true;
        this.watchdogCircuitBrokenAt = now;
        const winMin = this.WATCHDOG_WINDOW_MS / 60_000;
        const resetMin = this.WATCHDOG_CIRCUIT_RESET_MS / 60_000;
        this.log(
          `Watchdog circuit breaker TRIPPED: ${this.watchdogRestarts.length} restarts in ${winMin}min. ` +
            `Halting auto-restart for ${resetMin}min — likely upstream issue (Telegram/Anthropic down). ` +
            `Check manually with: pm2 logs cortextos-daemon`,
        );
        if (this.telegramApi && this.chatId) {
          const agentName = this.agent.name;
          this.telegramApi
            .sendMessage(
              this.chatId,
              `⚠️ ${agentName} watchdog tripped — ${this.watchdogRestarts.length} auto-restarts in ${winMin}min. Restart loop paused ${resetMin}min. Likely upstream issue. Manual fix: pm2 restart cortextos-daemon`,
            )
            .then(() => {
              this.log(`Telegram watchdog circuit-breaker notification sent for ${agentName}`);
            })
            .catch(() => {});
        }
        this.lastPollCycleCompletedAt = now;
        return;
      }

      this.watchdogRestarts.push(now);
      this.log(
        `pollCycle stalled for ${Math.round(stallMs / 1000)}s — triggering hard-restart ` +
          `(${this.watchdogRestarts.length}/${this.WATCHDOG_MAX_RESTARTS} in ${this.WATCHDOG_WINDOW_MS / 60_000}min window)`,
      );
      this.agent.hardRestartSelf(`pollCycle stalled for ${Math.round(stallMs / 1000)}s`).catch(err => {
        this.log(`Force-restart error: ${err}`);
      });
      this.lastPollCycleCompletedAt = now;
    }, WATCHDOG_INTERVAL_MS);

    // F8: Gmail watch runs on its OWN timer, decoupled from the 1s pollCycle.
    // checkGmailWatch worst-case is minutes (up to 20 metadata fetches at 10s
    // each + 20 label-modifies at 10s each), which raced against
    // POLL_CYCLE_TIMEOUT_MS (30s) inside pollCycle — any Gmail batch beyond
    // ~3 messages tripped a spurious "pollCycle timeout" and left the
    // abandoned check running concurrently with new cycles. The timer ticks
    // every 30s; checkGmailWatch still self-gates on the configured
    // intervalMs (default 15 min), so the polling cadence is unchanged. The
    // in-flight flag prevents overlapping runs when a check outlasts a tick.
    if (this.gmailWatch) {
      this.gmailWatchTimer = setInterval(() => {
        if (this.gmailCheckInFlight) return;
        this.gmailCheckInFlight = true;
        this.checkGmailWatch()
          .catch(err => this.log(`Gmail watch error: ${err}`))
          .finally(() => { this.gmailCheckInFlight = false; });
      }, this.GMAIL_TIMER_TICK_MS);
    }

    // added 2026-04-29 via internal dispatch — RFC #15 Day-1 dispatcher integration; Piece 3 (handler-type wiring) deferred to Day-2
    this.startHookDispatcher();

    while (this.running) {
      try {
        // Check for urgent signal file
        this.checkUrgentSignal();
        // Race pollCycle against a timeout so a hung operation (e.g. stuck
        // fetch, slow execFile) can't freeze the loop indefinitely. If the
        // timeout fires, the underlying operation is abandoned (may still
        // resolve in the background) and the loop continues on the next tick.
        await Promise.race([
          this.pollCycle(),
          new Promise((_, reject) =>
            setTimeout(
              () => reject(new Error(`pollCycle timeout after ${this.POLL_CYCLE_TIMEOUT_MS}ms`)),
              this.POLL_CYCLE_TIMEOUT_MS,
            ),
          ),
        ]);
        this.lastPollCycleCompletedAt = Date.now();
      } catch (err) {
        this.log(`Poll error: ${err}`);
      }
      await this.sleepInterruptible(this.pollInterval);
    }

    if (process.platform !== 'win32') {
      process.removeListener('SIGUSR1', sigusr1Handler);
    }
  }

  /**
   * Stop the polling loop.
   */
  stop(): void {
    this.running = false;
    if (this.heartbeatTimer !== null) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.pollCycleWatchdog !== null) {
      clearInterval(this.pollCycleWatchdog);
      this.pollCycleWatchdog = null;
    }
    if (this.gmailWatchTimer !== null) {
      clearInterval(this.gmailWatchTimer);
      this.gmailWatchTimer = null;
    }
    // added 2026-04-29 via internal dispatch — RFC #15 Day-1 dispatcher integration; Piece 3 (handler-type wiring) deferred to Day-2
    if (this.hookRegistryWatcher !== null) {
      try { this.hookRegistryWatcher.close(); } catch { /* best-effort */ }
      this.hookRegistryWatcher = null;
    }
    if (this.eventLogTailer !== null) {
      clearInterval(this.eventLogTailer);
      this.eventLogTailer = null;
    }
  }

  // ── RFC #15 Day-1 hook dispatcher ─────────────────────────────────────────
  // added 2026-04-29 via internal dispatch — RFC #15 Day-1 dispatcher integration; Piece 3 (handler-type wiring) deferred to Day-2
  // Piece 1: load + watch hooks.json. Piece 2: tail today's event JSONL and
  // call matchHooks → dispatchHook (still stub). Piece 3 (per-handler-type
  // wiring with bash/send_message/log_event/webhook) is Day-2 work — see
  // TODOs below and your org internal docs §6.
  private startHookDispatcher(): void {
    const org = process.env.CTX_ORG;
    if (!org) {
      this.log('Hook dispatcher disabled — CTX_ORG env not set; fail-open per RFC #15 §9');
      return;
    }
    try {
      validateOrgName(org);
    } catch (err) {
      this.log(`Hook dispatcher disabled — invalid CTX_ORG '${org}': ${(err as Error).message}`);
      return;
    }
    this.hookOrg = org;
    const orgPath = join(this.frameworkRoot, 'orgs', org);
    // Belt-and-suspenders: confirm resolved org path stays inside frameworkRoot/orgs
    // even after symlink expansion. Defends against any path-traversal slip past validateOrgName.
    const orgsRoot = pathResolve(join(this.frameworkRoot, 'orgs'));
    const resolvedOrgPath = pathResolve(orgPath);
    if (!resolvedOrgPath.startsWith(orgsRoot + '/') && resolvedOrgPath !== orgsRoot) {
      this.log(`Hook dispatcher disabled — org path escaped frameworkRoot: ${orgPath}`);
      return;
    }
    this.hookRegistryPath = join(orgPath, 'hooks.json');
    this.loadAndAnnounceRegistry(orgPath, 'startup');

    // Wire built-in hook handlers (log_event, plus scaffold-throw bash_spawn /
    // send_message / webhook_fetch). Idempotent: registerHandler overwrites by
    // type, so re-init or hot-reload is safe. Without this call the dispatcher
    // always falls through to `no_handler_registered` and the Day-3 scaffolding
    // is dead code.
    const handlerCount = registerBuiltInHandlers();
    this.log(`Hook dispatcher: registered ${handlerCount} built-in handler(s)`);

    // Piece 1 — hot-reload on file change. Best-effort; missing file is OK
    // (loadHookRegistry returns empty registry, dispatcher just sees nothing).
    if (existsSync(this.hookRegistryPath)) {
      try {
        this.hookRegistryWatcher = watch(this.hookRegistryPath, () => {
          this.loadAndAnnounceRegistry(orgPath, 'change');
        });
      } catch (err) {
        this.log(`Hook registry watcher failed to attach: ${(err as Error).message}`);
      }
    }

    // Piece 2 — start the per-tick event-log tailer. Position 0 = read from
    // start of today's file on first tick; subsequent ticks read only new
    // bytes appended since the last position.
    this.eventLogPosition = 0;
    this.eventLogCurrentPath = this.computeEventLogPath();
    this.eventLogTailer = setInterval(() => {
      try {
        this.eventLogTailTick();
      } catch (err) {
        // best-effort — never throw out of an interval callback
        this.log(`Hook tail error: ${(err as Error).message}`);
      }
    }, this.EVENT_LOG_TAIL_INTERVAL_MS);
  }

  private loadAndAnnounceRegistry(orgPath: string, reason: 'startup' | 'change'): void {
    const next = loadHookRegistry(orgPath);
    this.hookRegistry = next;
    const enabledCount = next.hooks.filter((h) => h.enabled).length;
    // Best-effort observability event: schema_version + counts + reason
    execFile(
      'cortextos',
      [
        'bus',
        'log-event',
        'action',
        'hooks_registry_loaded',
        'info',
        '--meta',
        JSON.stringify({
          source_path: this.hookRegistryPath,
          hook_count: next.hooks.length,
          enabled_count: enabledCount,
          schema_version: next.schema_version,
          reason,
        }),
      ],
      { timeout: 5_000 },
      () => { /* fire-and-forget */ },
    );
  }

  private computeEventLogPath(): string {
    const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
    return join(this.paths.analyticsDir, 'events', this.agent.name, `${today}.jsonl`);
  }

  private eventLogTailTick(): void {
    // Day-rollover detection: if computed path differs, rotate.
    const expectedPath = this.computeEventLogPath();
    if (expectedPath !== this.eventLogCurrentPath) {
      this.eventLogCurrentPath = expectedPath;
      this.eventLogPosition = 0;
    }

    if (!existsSync(this.eventLogCurrentPath)) {
      // Today's file may not exist yet — nothing to tail.
      return;
    }

    const stats = statSync(this.eventLogCurrentPath);
    // Rotation/truncation guard: shrink → reset to 0.
    if (stats.size < this.eventLogPosition) {
      this.eventLogPosition = 0;
    }
    if (stats.size <= this.eventLogPosition) {
      return; // nothing new
    }

    const fd = openSync(this.eventLogCurrentPath, 'r');
    try {
      const toRead = stats.size - this.eventLogPosition;
      const buf = Buffer.alloc(toRead);
      // Honour readSync's return value — file can shrink between statSync and
      // readSync (rotation race). Advance position by ACTUAL bytes read so a
      // short read doesn't silently skip past unread data on the next tick.
      const bytesRead = readSync(fd, buf, 0, toRead, this.eventLogPosition);
      if (bytesRead <= 0) return;
      this.eventLogPosition += bytesRead;
      const text = buf.subarray(0, bytesRead).toString('utf-8');
      for (const line of text.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        let event: Event;
        try {
          event = JSON.parse(trimmed) as Event;
        } catch {
          continue; // skip malformed lines, preserve position so we don't refire
        }
        this.handleHookEvent(event);
      }
    } finally {
      closeSync(fd);
    }
  }

  private handleHookEvent(event: Event): void {
    const matched = matchHooks(this.hookRegistry, event, this.agent.name);
    if (matched.length === 0) return;
    for (const hook of matched) {
      // dispatchHook writes hooks.log locally AND emits exactly one
      // hook_fire / hook_block / hook_escalate bus event per dispatch — it is
      // the single source of truth for hook telemetry. The pre-dispatch
      // `hook_dispatch_attempted` emit was dropped (2026-04-30 ultrareview Fix 6,
      // Option A) — it doubled the subprocess spawn rate per hook with no
      // observability the dispatcher event does not already carry.
      dispatchHook(hook, event).catch((err) => {
        this.log(`dispatchHook error for ${hook.id}: ${(err as Error).message}`);
      });
    }
  }

  /**
   * Trigger immediate wake from sleep.
   * Cross-platform alternative to SIGUSR1, called by IPC 'wake' command.
   */
  wake(): void {
    if (this.wakeResolve) {
      this.wakeResolve();
      this.wakeResolve = null;
    }
  }

  /**
   * Queue a formatted Telegram message for injection.
   * Called by the daemon's Telegram handler.
   */
  queueTelegramMessage(formatted: string): void {
    this.telegramMessages.push({ formatted, ackIds: [] });
  }

  /**
   * Single poll cycle: check inbox + queued Telegram messages.
   */
  private async pollCycle(): Promise<void> {
    let messageBlock = '';
    const ackIds: string[] = [];

    // Process queued Telegram messages. Drain into a local buffer rather than
    // discarding outright — if injection fails because the agent is not running
    // (mid-restart / NOT_RUNNING) or the PTY cannot durably admit the message
    // (ADMISSION_FAILED), we must re-queue. The in-memory queue is the ONLY
    // backing store for Telegram (no inbox-style ACK/redelivery).
    // Mirrors the inbox ACK-after-inject recovery model below. DEDUPED failures
    // are dropped instead (see below) — retrying identical content can never
    // succeed and would loop forever.
    const drainedTelegram: typeof this.telegramMessages = [];
    while (this.telegramMessages.length > 0) {
      const msg = this.telegramMessages.shift()!;
      messageBlock += msg.formatted;
      drainedTelegram.push(msg);
    }
    const hasTelegramMessage = drainedTelegram.length > 0;

    // Check agent inbox
    let inboxMessages: InboxMessage[] = [];
    try {
      inboxMessages = checkInbox(this.paths);
    } catch (err) {
      // Keep independent Telegram delivery moving, but make the inbox failure
      // explicit in the daemon log. The next poll retries instead of claiming
      // a successful empty inbox.
      this.log(`Inbox check failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    for (const msg of inboxMessages) {
      messageBlock += this.formatInboxMessage(msg);
      ackIds.push(msg.id);
    }

    // Inject if there's anything
    if (messageBlock) {
      const injectResult = this.agent.injectMessageDetailed(messageBlock);
      if (injectResult.ok) {
        // ACK inbox messages
        for (const id of ackIds) {
          ackInbox(this.paths, id);
        }
        this.log(`Injected ${messageBlock.length} bytes`);
        // Only update typing timestamp for Telegram messages, not inbox/cron.
        // Inbox messages (agent-to-agent, session continuations) must not
        // restart the typing indicator after Stop has cleared it.
        if (hasTelegramMessage) {
          this.lastMessageInjectedAt = Date.now();
        }
        // Cooldown after injection
        await sleep(5000);
      } else if (drainedTelegram.length > 0) {
        if (injectResult.code === 'NOT_RUNNING' || injectResult.code === 'ADMISSION_FAILED') {
          // The agent cannot currently take custody. Re-queue the drained Telegram
          // messages at the FRONT so they are retried next cycle and preserve
          // original order. Inbox messages need no action — they were never
          // ACK'd, so checkInbox redelivers them. Without this, mid-restart
          // inbound Telegram is silently and permanently lost (offset already
          // advanced).
          this.telegramMessages.unshift(...drainedTelegram);
          this.log(`Inject failed (${injectResult.code}); re-queued ${drainedTelegram.length} Telegram message(s)`);
        } else {
          // F6: DEDUPED is permanent for identical content — the MessageDedup
          // hash window rejects the same block on every retry until unrelated
          // content changes the hash. Re-queueing would retry (and log) every
          // poll tick forever. Drop with a single log line instead; identical
          // content was already injected within the dedup window.
          this.log(`Inject deduped; dropped ${drainedTelegram.length} Telegram message(s) (duplicate of recently injected content)`);
        }
      }
    }

    // Typing indicator: send while Claude is actively working
    if (this.chatId && this.telegramApi && this.isAgentActive()) {
      await this.sendTyping(this.telegramApi, this.chatId);
    }

    // Watchdog: detect ctx-exhaustion survey + frozen stdout
    this.watchdogCheck();

    // NOTE (F8): Gmail watch is intentionally NOT checked here — it runs on
    // its own timer (see start()) because its worst case exceeds the 30s
    // pollCycle timeout. Slack/usage/context checks below stay in-cycle:
    // each is bounded well under the timeout (10-15s execFile timeouts or
    // local file reads) and moving Slack was explicitly out of scope.

    // Slack watch: check on configured interval (default 60 sec)
    await this.checkSlackWatch();

    // Usage rate-limit guard: check every 15 min
    await this.checkUsageTier();

    // Context monitor: check usage thresholds and fire warnings/handoffs
    await this.checkContextStatus();
  }

  /**
   * Detect stuck agent and trigger hard-restart.
   * Ported from CRM fast-checker.sh (FROZEN_RESTART + context-threshold logic).
   *
   * Two signals:
   *   1. Claude Code's "How is Claude doing this session?" survey prompt — fires
   *      when context is exhausted and the session needs to end. If it appears
   *      in stdout, the agent is cooked.
   *   2. stdout log unchanged for 30+ min while the agent is "active" (has a
   *      pending message and no idle flag) — passively frozen.
   */
  private watchdogCheck(): void {
    const now = Date.now();
    const restartMarker = this.readWatchdogRestartMarker();
    if (restartMarker.restartedAt > 0 && now - restartMarker.restartedAt < this.HARD_RESTART_COOLDOWN_MS) return;
    if (this.watchdogTriggered) return;
    if (this.bootstrappedAt === 0 || now - this.bootstrappedAt < this.BOOTSTRAP_GRACE_MS) return;
    if (this.lastHardRestartAt > 0 && now - this.lastHardRestartAt < this.HARD_RESTART_COOLDOWN_MS) return;

    const stdoutPath = join(this.paths.logDir, 'stdout.log');
    if (!existsSync(stdoutPath)) return;

    let size: number;
    try { size = statSync(stdoutPath).size; } catch { return; }
    let stdoutHighWater = restartMarker.stdoutHighWater;
    if (stdoutHighWater > size) {
      stdoutHighWater = 0;
      if (restartMarker.restartedAt > 0) {
        this.persistWatchdogRestartMarker(restartMarker.restartedAt, stdoutHighWater);
      }
    }

    if (size !== this.stdoutLastSize) {
      this.stdoutLastSize = size;
      this.stdoutLastChangeAt = now;
    }
    this.syncTurnWatchdogInjection();
    this.trackMeaningfulOutput(stdoutPath, size, now);

    // Read tail once — shared by Signals 3 and 4
    let tail = '';
    try {
      const tailBytes = Math.min(20000, size);
      if (tailBytes > 0) {
        const fd = openSync(stdoutPath, 'r');
        const buf = Buffer.alloc(tailBytes);
        readSync(fd, buf, 0, tailBytes, size - tailBytes);
        closeSync(fd);
        tail = buf.toString('utf-8');
      }
    } catch { /* non-critical */ }

    // Signal 1: session-survey prompt → immediate hard restart
    if (size > stdoutHighWater) {
      let surveyTail = '';
      try {
        const start = stdoutHighWater;
        const bytes = size - start;
        if (bytes > 0) {
          const fd = openSync(stdoutPath, 'r');
          const buf = Buffer.alloc(bytes);
          readSync(fd, buf, 0, bytes, start);
          closeSync(fd);
          surveyTail = buf.toString('utf-8');
        }
      } catch { /* non-critical */ }
      if (surveyTail && /How is Claude doing this session\?/.test(surveyTail)) {
        this.log('WATCHDOG: ctx-exhaustion survey prompt detected — hard-restarting');
        this.triggerHardRestart('ctx exhaustion: session survey prompt in stdout', size);
        return;
      }
    }

    // Signal 3: context-threshold → proactive graceful restart
    if (tail && this.ctxThresholdPct > 0) {
      // Strip ANSI escape codes before applying the pattern
      const stripped = tail.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
      // F8: anchor on the FULL status-line shape — the real line is
      // "[<Model>] <branch> · NN% context used". We require the percent, then
      // only same-line whitespace, then "context", then "used". This is
      // model-agnostic (no Sonnet|Opus|Haiku pinning, which silently disabled
      // Signal 3 for other model families) and kills the prose false positives
      // the previous /(\d{1,3})%[^\n]{0,15}context/ shape let through:
      //   - "85% context switches"          (a literal FP seen in an agent stdout)
      //   - "reduced X by 85% in the context of …"  (ordinary prose)
      //   - "hit the 85% proactive-context-reset"   (agent narrating the reset)
      // Those matched because any text (incl. " in the ", "-") sat between the
      // percent and "context". Requiring [^\S\n]{0,3} + "used" leaves only the
      // genuine status line.
      // Two deliberate constraints (Codex P2s on ae347cf):
      //   - "used" ONLY — NOT "left"/"remaining". The captured percent is fed
      //     straight into a USED-percent threshold (pct >= ctxThresholdPct
      //     below). A "left"/"remaining" line reports the inverse (30% left =
      //     70% used), so matching it would compare 30 >= 70 and silently miss
      //     a near-full session. If a future CLI build emits only "left"/
      //     "remaining", add a (100 - pct) conversion before thresholding —
      //     do NOT just widen the alternation.
      //   - [^\S\n] (same-line whitespace), NOT \s. In JS \s matches newlines,
      //     so \s{0,3}/\s+ would let the match span adjacent stdout lines
      //     (e.g. a line ending "85%" followed by a line containing
      //     "context used"). [^\S\n] pins percent + "context" + "used" to ONE
      //     status line. Proof: "85%\ncontext used" must NOT match.
      //   - BOTH gaps are zero-or-more ({0,3} and *), NOT one-or-more. The real
      //     PTY status line uses ANSI cursor-position escapes (ESC[NNNG) as the
      //     column separators between badge/percent/"context"/"used", and we
      //     strip ANSI FIRST (line 883). On the live wire those escapes are the
      //     ONLY separators, so after stripping the line collapses to
      //     "97%contextused" with ZERO whitespace. A second gap of [^\S\n]+
      //     (one-or-more) required >=1 space and matched NULL on the real
      //     stripped line, silently disabling Signal 3 (agents wedged at full
      //     context) — worse than the prose FP it killed. [^\S\n]* allows the
      //     collapsed shape while staying same-line. Proof: "97%contextused"
      //     must return 97.
      //   - percent capped at 3 digits and sanity-checked <= 100 below
      // F9 (Codex P2 on c34f7b7): anchor the match to a leading STATUS MARKER.
      // The F8 shape above was still UNANCHORED over the whole stripped tail, so
      // a bare literal "97%contextused" / "97% context used" printed ANYWHERE
      // (an agent echoing source, a diff, a test fixture, a bus message) matched
      // as a genuine status line and injected a false restart at the 70%
      // default. We now require a leading marker that the live status line
      // always carries immediately before the percent but bare-literal prose
      // never does: a progress-bar block (█ U+2588 / ░ U+2591) or a status dot
      // (🔴 U+1F534 / 🟡 U+1F7E1 / 🟢 U+1F7E2). Empirically (real an agent/an agent/
      // an agent stdout corpora) this kills the dominant remaining FP class
      // (markerless quotes+prose: ~72/86 on an agent, ~54/72 on an agent) while
      // losing ZERO genuine live renders. The /u flag is REQUIRED: the status
      // dots are astral (>U+FFFF); without /u, JS would match a lone surrogate
      // half of a dot = semantically broken. We use \u escapes (not literal
      // emoji) in this source so this very line carries no matchable marker.
      // ACCEPTED RESIDUAL (do NOT claim 0-FP): a FAITHFUL full-marker quote that
      // reproduces "<marker>NN% context used" verbatim (e.g. this feature being
      // debugged in a bus message that copies a real render) still matches.
      // Near-zero in steady state, elevated only while this code is itself under
      // discussion. A quotation-proof FUTURE hardening is the ANSI cursor
      // envelope (ESC[NNNG between every token, which the renderer emits but a
      // quote cannot carry) — NOT used now because production strips ANSI first
      // (line 883) and a space-rendering terminal would emit literal spaces,
      // making an envelope-only matcher false-NEGATIVE = Signal 3 silently
      // disabled = the worse failure.
      // RESIDUAL RISK: if a future Claude Code build rewords the status-line
      // suffix away from "used" OR drops the bar/dot marker rendering, Signal 3
      // silently stops firing — re-check this pattern against the live status
      // line on CLI upgrades. (Signal 1 survey-prompt + the fallback hard
      // restart are independent backstops.)
      const pctMatch = stripped.match(/[█░\u{1F534}\u{1F7E1}\u{1F7E2}][^\S\n]*(\d{1,3})%[^\S\n]{0,3}context[^\S\n]*used/u);
      if (pctMatch) {
        const pct = parseInt(pctMatch[1], 10);
        if (pct >= this.ctxThresholdPct && pct <= 100) {
          // §5d: A context handoff prompt was already injected this session — skip
          // Signal-3 injection to avoid two competing restart requests in the same
          // dying session. Tier-3's 5-min force-restart deadline preempts Signal 3's
          // 15-min fallback for wired agents, so no restart protection is lost here.
          if (this.ctxHandoffFiredAt > 0) return;
          if (this.ctxThresholdTriggeredAt > 0 &&
              now - this.ctxThresholdTriggeredAt > this.CTX_THRESHOLD_FALLBACK_MS) {
            // Agent ignored the injection for 15 min — fallback hard restart
            const minAgo = Math.round((now - this.ctxThresholdTriggeredAt) / 60000);
            this.log(`WATCHDOG: ctx threshold fallback — agent ignored restart request for ${minAgo}min`);
            this.triggerHardRestart(`ctx threshold fallback: agent at ${pct}% ignored graceful restart for ${minAgo}min`);
            return;
          } else if (this.ctxThresholdTriggeredAt === 0 ||
              now - this.ctxThresholdTriggeredAt > this.CTX_THRESHOLD_COOLDOWN_MS) {
            // First trigger (or cooldown expired): inject graceful restart request
            this.ctxThresholdTriggeredAt = now;
            const msg = `Context window at ${pct}%. Please write your session memory and observations now, then run: cortextos bus hard-restart --reason "proactive context reset at ${pct}%" and then run /exit to close this session.`;
            this.agent.injectMessage(msg);
            this.log(`WATCHDOG: ctx at ${pct}% >= threshold ${this.ctxThresholdPct}% — injected graceful restart request`);
          }
        }
      }
    }

    // Signal 4: 1M context billing gate — API refuses all calls, agent is dead
    if (tail && /Extra usage is required for 1M context/.test(tail)) {
      this.log('WATCHDOG: 1M context billing gate detected — agent cannot make API calls, hard-restarting');
      this.triggerHardRestart('1M context billing gate: extra usage required — session unrecoverable');
      return;
    }

    this.checkStalledTurn(now);
    if (this.turnHung) return;

    // Signal 2: stdout frozen for 30+ min while agent is active.
    if (
      this.lastMessageInjectedAt > 0 &&
      now - this.stdoutLastChangeAt > this.STDOUT_FROZEN_MS &&
      this.isAgentActive()
    ) {
      const stalledSec = Math.round((now - this.stdoutLastChangeAt) / 1000);
      this.log(`WATCHDOG: stdout frozen for ${stalledSec}s while active — hard-restarting`);
      this.triggerHardRestart(`frozen: stdout unchanged ${stalledSec}s while active`);
    }
  }

  private triggerHardRestart(reason: string, stdoutHighWater?: number): void {
    const status = this.agent.getStatus().status;
    if (status === 'halted' || status === 'stopped') {
      this.log(`WATCHDOG: refusing hard-restart in status=${status}: ${reason}`);
      return;
    }
    this.watchdogTriggered = true;
    this.lastHardRestartAt = Date.now();
    if (this.telegramApi && this.chatId) {
      this.telegramApi
        .sendMessage(this.chatId, `Got stuck (${reason}). Hard-restarting now.`)
        .then(() => {
          this.log(`Telegram watchdog hard-restart notification sent: ${reason}`);
        })
        .catch(() => { /* non-critical */ });
    }
    const currentMarker = this.readWatchdogRestartMarker();
    this.persistWatchdogRestartMarker(
      this.lastHardRestartAt,
      stdoutHighWater ?? currentMarker.stdoutHighWater,
    );
    // Preserve any recent handoff doc before the abrupt restart, same as the
    // metric-driven forceContextRestart (Tier 2/3) path. Without this, a
    // watchdog-triggered hard restart — including the cooperative ctx-threshold
    // 15min fallback (Signal 3) — drops the handoff context the agent just
    // wrote. This gap lost the Slack P1 dispatch context on the 2026-06-01
    // 00:52Z forced restart.
    this.preserveRecentHandoffDoc();
    this.agent.hardRestartSelf(reason).catch(e => this.log(`hardRestartSelf failed: ${e}`));
  }

  private trackMeaningfulOutput(stdoutPath: string, size: number, now: number): void {
    if (this.stdoutMeaningfulOffset < 0 || size < this.stdoutMeaningfulOffset) {
      this.stdoutMeaningfulOffset = size;
      return;
    }
    if (size === this.stdoutMeaningfulOffset) return;

    const bytes = size - this.stdoutMeaningfulOffset;
    const readLength = Math.min(bytes, MAX_MEANINGFUL_STDOUT_DELTA_BYTES);
    const readPosition = bytes > MAX_MEANINGFUL_STDOUT_DELTA_BYTES
      ? size - readLength
      : this.stdoutMeaningfulOffset;
    this.stdoutMeaningfulOffset = size;

    try {
      if (bytes > MAX_MEANINGFUL_STDOUT_DELTA_BYTES) {
        this.log(`WATCHDOG: stdout delta ${bytes}B exceeds cap; sampling tail`);
      }
      const buf = readFileRangeSync(stdoutPath, readPosition, readLength, this.fileRangeOps);

      let foundNetNew = false;
      for (const line of meaningfulPrintableLines(buf.toString('utf-8'))) {
        const fingerprint = createHash('sha256').update(normalizeStatusLineForFingerprint(line)).digest('hex');
        if (this.meaningfulOutputFingerprints.has(fingerprint)) continue;
        this.meaningfulOutputFingerprints.add(fingerprint);
        foundNetNew = true;
      }
      if (this.meaningfulOutputFingerprints.size > 1000) {
        this.meaningfulOutputFingerprints = new Set(Array.from(this.meaningfulOutputFingerprints).slice(-1000));
      }
      if (foundNetNew) this.lastMeaningfulOutputAt = now;
    } catch (err) {
      // A log rotation/read race is non-fatal; the cursor is already re-seeded.
      this.log(`WATCHDOG: stdout meaningful-output read failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private observeIdleFlagWriter(): void {
    if (this.idleFlagSeenThisSession) return;
    try {
      const idleFlagPath = join(this.paths.stateDir, 'last_idle.flag');
      if (statSync(idleFlagPath).mtimeMs >= this.sessionStartedAt) {
        this.idleFlagSeenThisSession = true;
      }
    } catch {
      // Missing or unreadable means the writer has not been proven this session.
    }
  }

  private readIdleTimestamp(): number {
    try {
      const path = join(this.paths.stateDir, 'last_idle.flag');
      if (!existsSync(path)) return 0;
      const seconds = Number.parseInt(readFileSync(path, 'utf-8').trim(), 10);
      return Number.isFinite(seconds) ? seconds * 1000 : 0;
    } catch {
      return 0;
    }
  }

  private checkStalledTurn(now: number): void {
    this.observeIdleFlagWriter();
    if (!this.idleFlagSeenThisSession) {
      this.turnHung = false;
      if (!this.idleFlagInactiveLogged) {
        this.idleFlagInactiveLogged = true;
        this.log('turn watchdog inactive: no Stop-hook idle-flag write observed this session (writer missing or settings drift)');
      }
      return;
    }

    const lastInjectAt = this.syncTurnWatchdogInjection();
    // Accepted false negatives until the Stop-hook protocol carries turn IDs:
    // (a) a Stop write and later inject in the same wall-clock second look closed;
    // (b) an inject arriving mid-turn can be closed by that turn's later Stop.
    // Keep this strict: >= would falsely kill quick turns.
    const turnOpen = lastInjectAt > 0 && Math.floor(lastInjectAt / 1000) * 1000 > this.readIdleTimestamp();
    if (!turnOpen) {
      this.turnHung = false;
      return;
    }

    const progressAt = Math.max(lastInjectAt, this.lastMeaningfulOutputAt);
    const stalledMs = now - progressAt;
    if (stalledMs <= this.turnWatchdogThresholdMs) {
      this.turnHung = false;
      return;
    }

    this.handleStalledTurn(lastInjectAt, stalledMs, now);
  }

  private syncTurnWatchdogInjection(): number {
    const lastInjectAt = this.getLastInjectedAt();
    if (lastInjectAt !== this.turnWatchdogTrackedInjectAt) {
      this.turnWatchdogTrackedInjectAt = lastInjectAt;
      this.lastMeaningfulOutputAt = 0;
      this.meaningfulOutputFingerprints.clear();
      this.turnHung = false;
    }
    return lastInjectAt;
  }

  private getLastInjectedAt(): number {
    return typeof (this.agent as AgentProcess & { getLastInjectedAt?: () => number }).getLastInjectedAt === 'function'
      ? (this.agent as AgentProcess & { getLastInjectedAt: () => number }).getLastInjectedAt()
      : this.lastMessageInjectedAt;
  }

  private handleStalledTurn(lastInjectAt: number, stalledMs: number, now: number): void {
    this.turnHung = true;
    if (this.turnWatchdogAlertedInjectAt === lastInjectAt) return;
    this.turnWatchdogAlertedInjectAt = lastInjectAt;
    this.loadTurnWatchdogRecoveries();
    this.turnWatchdogRecoveries = this.turnWatchdogRecoveries.filter(
      (timestamp) => now - timestamp < this.TURN_WATCHDOG_WINDOW_MS,
    );
    const recoveryStateUnavailable = !this.turnWatchdogRecoveryStateValid;
    let recoveryAllowed = !recoveryStateUnavailable &&
      this.turnWatchdogRecoveries.length < this.TURN_WATCHDOG_MAX_RECOVERIES;
    let persistenceFailed = false;
    if (recoveryAllowed) {
      const reservedRecoveries = [...this.turnWatchdogRecoveries, now];
      if (this.saveTurnWatchdogRecoveries(reservedRecoveries)) {
        this.turnWatchdogRecoveries = reservedRecoveries;
      } else {
        recoveryAllowed = false;
        persistenceFailed = true;
      }
    }
    const stalledMinutes = Math.floor(stalledMs / 60_000);
    const action = recoveryAllowed
      ? 'session-refresh recovery'
      : persistenceFailed
        ? 'alert-only (recovery persistence failed)'
        : recoveryStateUnavailable
          ? 'alert-only (recovery state unavailable)'
          : 'alert-only (recovery cap reached)';
    const reason = `open turn stalled ${stalledMinutes}min without meaningful printable output`;

    this.log(`WATCHDOG HUNG: ${this.agent.name} ${reason}; ${action}`);
    try {
      logEvent(this.paths, this.agent.name, process.env.CTX_ORG ?? '', 'error', 'stalled_turn_hung', 'error', {
        last_inject_at: new Date(lastInjectAt).toISOString(),
        last_meaningful_output_at: this.lastMeaningfulOutputAt > 0
          ? new Date(this.lastMeaningfulOutputAt).toISOString()
          : null,
        stalled_minutes: stalledMinutes,
        threshold_minutes: this.turnWatchdogThresholdMs / 60_000,
        recovery_count_6h: this.turnWatchdogRecoveries.length,
        action,
      });
    } catch (err) {
      this.log(`WATCHDOG HUNG bus-event failure: ${err instanceof Error ? err.message : String(err)}`);
    }

    try {
      updateHeartbeat(
        this.paths,
        this.agent.name,
        `[watchdog] ${this.agent.name} HUNG - ${reason}; ${action}`,
        { org: process.env.CTX_ORG ?? '' },
      );
    } catch (err) {
      this.log(`WATCHDOG HUNG heartbeat annotation failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (this.telegramApi && this.chatId) {
      const telegramMessage = recoveryAllowed
        ? `${this.agent.name} has a stalled open turn (${stalledMinutes} min without meaningful output). Refreshing the session now.`
        : persistenceFailed
          ? `${this.agent.name} still has a stalled open turn. Auto-recovery was not attempted because the recovery reservation could not be persisted. This alert is notification-only.`
          : recoveryStateUnavailable
            ? `${this.agent.name} still has a stalled open turn. Auto-recovery was not attempted because the persisted recovery state is invalid or unreadable. Repair the state file before recovery can resume.`
            : `${this.agent.name} still has a stalled open turn. Auto-recovery is capped at 2 attempts per 6 hours, so this alert is notification-only.`;
      this.telegramApi.sendMessage(
        this.chatId,
        telegramMessage,
      ).catch((err) => this.log(`WATCHDOG HUNG Telegram alert failed: ${err instanceof Error ? err.message : String(err)}`));
    }

    if (!recoveryAllowed) return;
    this.watchdogTriggered = true;
    this.lastHardRestartAt = now;
    this.preserveRecentHandoffDoc();
    this.agent.sessionRefresh().catch((err) => this.log(`Stalled-turn session refresh failed: ${err}`));
  }

  private loadTurnWatchdogRecoveries(): void {
    if (!existsSync(this.turnWatchdogRecoveryFile)) {
      this.turnWatchdogRecoveries = [];
      this.turnWatchdogRecoveryStateValid = true;
      return;
    }
    try {
      const parsed = JSON.parse(readFileSync(this.turnWatchdogRecoveryFile, 'utf-8')) as unknown;
      if (!this.isPlainObject(parsed) ||
          Object.keys(parsed).length !== 1 ||
          !Array.isArray(parsed.recoveries) ||
          !parsed.recoveries.every((value) => Number.isSafeInteger(value) && value >= 0)) {
        throw new Error('expected { recoveries: non-negative safe-integer timestamps[] }');
      }
      this.turnWatchdogRecoveries = [...parsed.recoveries] as number[];
      this.turnWatchdogRecoveryStateValid = true;
    } catch (err) {
      this.turnWatchdogRecoveries = [];
      this.turnWatchdogRecoveryStateValid = false;
      this.log(`WATCHDOG recovery state unavailable: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private saveTurnWatchdogRecoveries(recoveries: number[]): boolean {
    try {
      atomicWriteSync(this.turnWatchdogRecoveryFile, JSON.stringify({ recoveries }));
      return true;
    } catch {
      return false;
    }
  }

  private readWatchdogRestartMarker(): WatchdogRestartMarker {
    try {
      if (!existsSync(this.watchdogRestartMarkerFile)) return { restartedAt: 0, stdoutHighWater: 0 };
      const raw = readFileSync(this.watchdogRestartMarkerFile, 'utf-8').trim();
      const parsed = JSON.parse(raw) as Partial<WatchdogRestartMarker>;
      return {
        restartedAt: typeof parsed.restartedAt === 'number' && Number.isFinite(parsed.restartedAt) ? parsed.restartedAt : 0,
        stdoutHighWater: typeof parsed.stdoutHighWater === 'number' && Number.isFinite(parsed.stdoutHighWater) ? parsed.stdoutHighWater : 0,
      };
    } catch {
      return { restartedAt: 0, stdoutHighWater: 0 };
    }
  }

  private persistWatchdogRestartMarker(restartedAt: number, stdoutHighWater: number): void {
    try {
      atomicWriteSync(this.watchdogRestartMarkerFile, JSON.stringify({ restartedAt, stdoutHighWater }));
    } catch {
      // Non-fatal: the in-memory cooldown still protects this FastChecker instance.
    }
  }

  /**
   * If the agent wrote a handoff doc in the last 15 minutes but didn't get to
   * call `hard-restart --handoff-doc` (e.g. a watchdog or Tier-3 force-restart
   * cut it short), write the `.handoff-doc-path` marker so the next session
   * still receives the handoff context via AgentProcess.consumeHandoffBlock().
   * Non-fatal: any failure proceeds without handoff context.
   */
  private preserveRecentHandoffDoc(): void {
    try {
      const handoffsDir = join(this.agent.getAgentDir(), 'memory', 'handoffs');
      if (!existsSync(handoffsDir)) return;
      const cutoff = Date.now() - 15 * 60_000;
      const recent = readdirSync(handoffsDir)
        .filter(f => f.startsWith('handoff-') && f.endsWith('.md'))
        .map(f => ({ f, mtime: statSync(join(handoffsDir, f)).mtimeMs }))
        .filter(({ mtime }) => mtime >= cutoff)
        .sort((a, b) => b.mtime - a.mtime);
      if (recent.length > 0) {
        const docPath = join(handoffsDir, recent[0].f);
        // Don't resurrect an already-consumed handoff doc. A cooperative handoff
        // writes the doc, restarts, and the new session's consumeHandoffBlock()
        // records {path, mtimeMs} in .handoff-doc-consumed. If a watchdog restart
        // then fires within the 15-min window, re-preserving that same doc would
        // re-inject stale, already-actioned context. Skip ONLY when both the path
        // AND mtime match the consumed record: a NEWER doc (different path) OR a
        // rewrite at a REUSED filename (same path, newer mtime) is still preserved
        // so a genuinely-new handoff is never lost.
        const consumedMarker = join(this.paths.stateDir, '.handoff-doc-consumed');
        if (existsSync(consumedMarker)) {
          try {
            const consumed = JSON.parse(readFileSync(consumedMarker, 'utf-8')) as
              { path?: string; mtimeMs?: number };
            if (consumed.path === docPath && consumed.mtimeMs === recent[0].mtime) return;
          } catch { /* fall through — preserve rather than silently skip */ }
        }
        const markerPath = join(this.paths.stateDir, '.handoff-doc-path');
        writeFileSync(markerPath, docPath, 'utf-8');
        this.log(`Restart: found recent handoff doc, writing marker → ${docPath}`);
      }
    } catch { /* non-fatal — proceed without handoff context */ }
  }

  /**
   * Poll Gmail for unread messages matching the configured query.
   *
   * Runs on the configured interval (default 15 min). Uses the `gws` CLI
   * (https://github.com/google-workspace-utilities/gws) which reads OAuth
   * credentials from ~/.config/gws/. Requires `gws` to be authenticated.
   *
   * If unread messages are found: writes an inbox message so Claude wakes
   * and processes them. If nothing matches: does nothing (zero Claude cost).
   * Claude is responsible for marking messages read after processing.
   */
  private async checkGmailWatch(): Promise<void> {
    if (!this.gmailWatch) return;
    const now = Date.now();
    if (now - this.gmailLastCheckedAt < this.gmailWatch.intervalMs) return;
    this.gmailLastCheckedAt = now;
    this.saveGmailLastCheckedAt();
    const baseQuery = this.gmailWatch.query;
    const effectiveQuery = (this.gmailWatch.processedLabelId && !baseQuery.includes(`-label:${this.gmailWatch.processedLabelId}`))
      ? `${baseQuery} -label:${this.gmailWatch.processedLabelId}`
      : baseQuery;

    // Fetch unread message list
    let listOutput = '';
    try {
      listOutput = await new Promise<string>((resolve, reject) => {
        execFile('gws', ['gmail', 'users', 'messages', 'list',
          '--params', JSON.stringify({ userId: 'me', q: effectiveQuery }),
          '--format', 'json',
        ], { timeout: 15_000, maxBuffer: 2 * 1024 * 1024 }, (err, stdout) => {
          if (err) { reject(err); return; }
          resolve(stdout);
        });
      });
    } catch (err) {
      this.log(`Gmail watch list failed: ${err}`);
      return;
    }

    let messageIds: string[] = [];
    try {
      const data = JSON.parse(listOutput);
      messageIds = (data?.messages ?? []).map((m: { id: string }) => m.id).filter(Boolean);
    } catch {
      this.log('Gmail watch: could not parse list response');
      return;
    }

    if (messageIds.length === 0) return; // nothing to do

    // Filter out already-delivered IDs (30d TTL safety-net dedup)
    this.pruneGmailDeliveredIds();
    const newIds = messageIds.filter(id => !this.gmailDeliveredIds.has(id));
    if (newIds.length === 0) {
      this.log('Gmail watch: all messages already delivered — skipping');
      return;
    }

    // Fetch snippet + subject for each new message (metadata format only)
    const summaries: string[] = [];
    for (const id of newIds.slice(0, 20)) { // cap at 20 to avoid runaway fetches
      try {
        const getOutput = await new Promise<string>((resolve, reject) => {
          execFile('gws', ['gmail', 'users', 'messages', 'get',
            '--params', JSON.stringify({ userId: 'me', id, format: 'metadata', metadataHeaders: ['Subject', 'From'] }),
            '--format', 'json',
          ], { timeout: 10_000, maxBuffer: 2 * 1024 * 1024 }, (err, stdout) => {
            if (err) { reject(err); return; }
            resolve(stdout);
          });
        });
        const msg = JSON.parse(getOutput);
        const headers: Array<{ name: string; value: string }> = msg?.payload?.headers ?? [];
        const subject = headers.find(h => h.name === 'Subject')?.value ?? '(no subject)';
        const from = headers.find(h => h.name === 'From')?.value ?? '(unknown)';
        const snippet = msg?.snippet ?? '';
        summaries.push(`ID: ${id}\n   Subject: ${subject}\n   From: ${from}\n   Snippet: ${snippet.slice(0, 200)}`);
      } catch {
        summaries.push(`ID: ${id} (could not fetch details)`);
      }
    }

    const total = newIds.length;
    const shown = summaries.length;
    const header = `=== GMAIL WATCH: ${total} unread message${total !== 1 ? 's' : ''} ===\n` +
      `Query: ${effectiveQuery}\n\n`;
    const body = summaries.map((s, i) => `${i + 1}. ${s}`).join('\n\n');
    const footer = total > shown ? `\n\n(${total - shown} more not shown)` : '';
    const hint = `\n\nProcess: gws gmail users messages get --params '{"userId":"me","id":"<ID>","format":"full"}' --format json` +
      `\nMark read: gws gmail users messages modify --params '{"userId":"me","id":"<ID>"}' --json '{"removeLabelIds":["UNREAD"]}' --format json`;

    const inboxText = header + body + footer + hint;
    this.log(`Gmail watch: ${total} new unread message(s) — writing inbox`);

    try {
      sendMessage(this.paths, 'fast-checker', this.agent.name, 'normal', inboxText);
      // Record delivered IDs
      for (const id of newIds) {
        this.gmailDeliveredIds.set(id, now);
      }
      this.saveGmailDeliveredIds();
    } catch (err) {
      this.log(`Gmail watch inbox write failed: ${err}`);
    }

    // Apply processed label so emails are excluded from future polls even after daemon restart.
    // In-memory dedup is only a safety net — without a persistent label the same emails can re-deliver.
    if (this.gmailWatch?.processedLabelId) {
      const labelId = this.gmailWatch.processedLabelId;
      for (const id of newIds.slice(0, 20)) {
        try {
          await new Promise<void>((resolve, reject) => {
            execFile('gws', [
              'gmail', 'users', 'messages', 'modify',
              '--params', JSON.stringify({ userId: 'me', id }),
              '--json', JSON.stringify({ addLabelIds: [labelId] }),
              '--format', 'json',
            ], { timeout: 10_000 }, (err) => {
              if (err) {
                reject(err);
                return;
              }
              resolve();
            });
          });
        } catch (err) {
          this.log(`Gmail watch: could not apply label ${labelId} to ${id}: ${err}`);
        }
      }
    }
  }

  private loadGmailLastCheckedAt(): void {
    try {
      if (existsSync(this.gmailLastCheckedPath)) {
        const raw = readFileSync(this.gmailLastCheckedPath, 'utf-8').trim();
        const epoch = parseInt(raw, 10);
        if (!isNaN(epoch)) this.gmailLastCheckedAt = epoch;
      }
    } catch (err) {
      this.log(`Gmail watch: could not load last-checked timestamp (restart dedup disabled): ${err}`);
    }
  }

  private saveGmailLastCheckedAt(): void {
    try {
      writeFileSync(this.gmailLastCheckedPath, String(this.gmailLastCheckedAt) + '\n', 'utf-8');
    } catch (err) {
      this.log(`Gmail watch: could not persist last-checked timestamp: ${err}`);
    }
  }

  private loadGmailDeliveredIds(): void {
    try {
      if (existsSync(this.gmailDeliveredIdsPath)) {
        const raw = JSON.parse(readFileSync(this.gmailDeliveredIdsPath, 'utf-8'));
        if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
          for (const [id, ts] of Object.entries(raw)) {
            if (typeof ts === 'number') this.gmailDeliveredIds.set(id, ts);
          }
        }
      }
    } catch (err) {
      this.log(`Gmail watch: could not load delivered IDs (message dedup disabled): ${err}`);
    }
  }

  private saveGmailDeliveredIds(): void {
    try {
      const obj: Record<string, number> = {};
      for (const [id, ts] of this.gmailDeliveredIds) {
        obj[id] = ts;
      }
      writeFileSync(this.gmailDeliveredIdsPath, JSON.stringify(obj) + '\n', 'utf-8');
    } catch (err) {
      this.log(`Gmail watch: could not persist delivered IDs: ${err}`);
    }
  }

  private pruneGmailDeliveredIds(): void {
    const cutoff = Date.now() - this.GMAIL_DELIVERED_TTL_MS;
    for (const [id, ts] of this.gmailDeliveredIds) {
      if (ts < cutoff) this.gmailDeliveredIds.delete(id);
    }
  }

  private async checkSlackWatch(): Promise<void> {
    if (!this.slackWatch || !this.slackApi) return;
    const now = Date.now();
    if (now - this.slackLastCheckedAt < this.slackWatch.intervalMs) return;
    this.slackLastCheckedAt = now;

    let messages: SlackMessage[] = [];
    try {
      messages = await this.slackApi.getHistory(this.slackWatch.channel, this.slackLastTs);
    } catch (err) {
      this.log(`Slack watch poll failed: ${err}`);
      return;
    }

    if (messages.length === 0) return;
    // Advance the cursor to the RAW newest fetched message BEFORE filtering, so
    // bot-authored (self-echo) messages never stall it. If filtering ran first,
    // a poll whose newest/only event is the agent's own reply would drop it
    // without advancing slackLastTs, then re-fetch + re-drop it every poll until
    // a later human message arrived — and with limit:50, a run of bot messages
    // could push an older human message out of the window and lose it. The trust
    // gate below already relies on the cursor sitting past dropped messages.
    this.slackLastTs = messages[messages.length - 1].ts;

    // Filter out bot-authored messages to prevent self-wake / self-echo loops.
    // `bot_message` subtype catches classic bot posts; `bot_id` catches messages
    // the agent posts via its own bot token (which arrive as a normal message
    // with bot_id set and no bot_message subtype) — the self-echo path.
    messages = messages.filter(m => m.subtype !== 'bot_message' && !m.bot_id);
    if (messages.length === 0) return;

    const slackApi = this.slackApi;
    // Gate the WHOLE batch first, then cap for display. The 10-item display cap
    // must apply to DELIVERABLE messages, not raw history: slackLastTs has
    // already advanced to the batch's newest, so any message not delivered now
    // is permanently skipped. If we capped raw history at 10 and the first 10
    // were all dropped (untrusted/userless), a trusted message at position 11+
    // would be lost. Gating before the cap keeps trusted messages.
    const deliverable: string[] = [];
    for (const msg of messages) {
      let from: string;
      if (msg.user) {
        // Identity + trust gate (P2). Cache hits skip users.info.
        const identity = await resolveSlackIdentity(
          msg.user,
          (id) => slackApi.getUserInfo(id),
          this.slackTeamMembers,
          this.slackIdentityCache,
        );
        const trust = evaluateSlackTrust(identity.handle, this.slackTrustedUsers);
        if (trust.openWarning && !this.slackOpenWarned) {
          this.log('Slack allowlist not configured — all workspace users can drive the agent.');
          this.slackOpenWarned = true;
        }
        if (!trust.allowed) {
          this.log(`Slack message from untrusted user ${identity.handle ?? msg.user} dropped (not in allowlist)`);
          continue;
        }
        from = formatSlackOriginator(identity);
      } else {
        // No user id (e.g. some app/integration/webhook messages): the sender
        // cannot be resolved or trust-gated. FAIL-CLOSED — if an allowlist is
        // configured, drop it; otherwise a userless message would bypass the
        // allowlist entirely. When no allowlist is set (loudly-open), deliver
        // via the username fallback as before.
        if (this.slackTrustedUsers && this.slackTrustedUsers.length > 0) {
          this.log('Slack message with no user id dropped (allowlist configured — sender cannot be verified)');
          continue;
        }
        from = msg.username ?? 'unknown';
      }
      // Coerce text: captionless file/photo shares deliver with no text field,
      // so interpolating msg.text directly would render the literal string
      // "undefined" in the inbox body (the socket listener already guards this).
      deliverable.push(
        `=== SLACK from ${from} (channel:${this.slackWatch.channel} ts:${msg.ts}) ===\n` +
        `${msg.text ?? ''}\n` +
        `Reply using: cortextos bus send-slack ${this.slackWatch.channel} "<reply>"`,
      );
    }

    if (deliverable.length === 0) return;

    // Display cap applies to deliverable messages (see gating note above).
    const shown = deliverable.slice(0, 10);
    const remaining = deliverable.length - shown.length;
    const trailer = remaining > 0 ? `\n\n(${remaining} more messages not shown)` : '';
    const inboxText = shown.join('\n\n---\n\n') + trailer;

    this.log(`Slack watch: ${messages.length} new message(s) in ${this.slackWatch.channel} — writing inbox`);
    try {
      sendMessage(this.paths, 'fast-checker', this.agent.name, 'normal', inboxText);
    } catch (err) {
      this.log(`Slack watch inbox write failed: ${err}`);
    }
  }

  /**
   * Check Claude Max API utilization and send tier-transition alerts.
   *
   * Runs every 15 minutes. Calls `cortextos bus check-usage-api` and reads
   * the JSON output. Computes tier (0=normal, 1=high≥85%, 2=critical≥95%).
   * On tier change: sends a Telegram alert directly (no Claude wake) and
   * writes an inbox message so Claude acts on it next time it is awake.
   * Tier state persists across restarts in usage-tier.json.
   */
  private async checkUsageTier(): Promise<void> {
    const now = Date.now();
    if (now - this.usageLastCheckedAt < this.USAGE_CHECK_INTERVAL_MS) return;
    this.usageLastCheckedAt = now;

    let rawJson = '';
    try {
      rawJson = await new Promise<string>((resolve, reject) => {
        // Request JSON output — the CLI command doesn't accept the old shell
        // script's --warn-* flags. Alerting is handled here on tier transitions.
        execFile('cortextos', ['bus', 'check-usage-api', '--json'], { timeout: 10_000, maxBuffer: 2 * 1024 * 1024 }, (err, stdout) => {
          if (err) { reject(err); return; }
          resolve(stdout);
        });
      });
    } catch (err) {
      this.log(`Usage check failed: ${err}`);
      return;
    }

    let utilization = -1;
    try {
      const data = JSON.parse(rawJson);
      // Support both formats: new CLI flat 0-1 floats (five_hour_utilization)
      // and legacy nested percentage (five_hour.utilization). Percentages assumed
      // if value > 1.
      const rawFiveH = data?.five_hour_utilization ?? data?.five_hour?.utilization;
      const rawSevenD = data?.seven_day_utilization ?? data?.seven_day?.utilization;
      const toPct = (v: unknown): number =>
        typeof v === 'number' ? (v <= 1 ? v * 100 : v) : -1;
      const fiveH = toPct(rawFiveH);
      const sevenD = toPct(rawSevenD);
      utilization = Math.max(fiveH, sevenD);
    } catch {
      this.log('Usage check: could not parse response');
      return;
    }

    if (utilization < 0) return;

    const newTier: 0 | 1 | 2 = utilization >= 95 ? 2 : utilization >= 85 ? 1 : 0;
    const prevTier = this.usageTier;

    if (newTier === prevTier) return; // no transition — stay quiet

    this.usageTier = newTier;
    this.saveUsageTier();

    const pct = Math.round(utilization);
    const msg = newTier === 0
      ? `Rate limit recovered. Utilization at ${pct}%. Resuming normal operations.`
      : newTier === 1
        ? `Rate limit at ${pct}%. Tier 1 wind-down: finish current task, no new autonomous work.`
        : `Rate limit at ${pct}%. Critical threshold reached. Going dark — do not start new work. Will notify on reset.`;

    this.log(`Usage tier transition: ${prevTier} → ${newTier} (${pct}%)`);

    // 1. Send Telegram alert directly (no Claude wake needed)
    if (this.telegramApi && this.chatId) {
      this.telegramApi.sendMessage(this.chatId, msg).catch(() => { /* non-critical */ });
    }

    // 2. Write inbox message so Claude acts on it next time it is awake
    try {
      sendMessage(this.paths, 'fast-checker', this.agent.name, 'urgent', msg);
    } catch (err) {
      this.log(`Usage tier inbox write failed: ${err}`);
    }
  }

  /**
   * Load usage tier from persistent file.
   */
  private loadUsageTier(): void {
    try {
      if (existsSync(this.usageTierFile)) {
        const data = JSON.parse(readFileSync(this.usageTierFile, 'utf-8'));
        if (data.tier === 0 || data.tier === 1 || data.tier === 2) {
          this.usageTier = data.tier;
        }
      }
    } catch {
      this.usageTier = 0;
    }
  }

  /**
   * Persist current usage tier to file.
   */
  private saveUsageTier(): void {
    try {
      writeFileSync(this.usageTierFile, JSON.stringify({ tier: this.usageTier, checkedAt: Date.now() }) + '\n', 'utf-8');
    } catch {
      // Non-critical
    }
  }

  /**
   * Format an inbox message for injection.
   * Matches bash fast-checker.sh format exactly.
   */
  private formatInboxMessage(msg: InboxMessage): string {
    const from = sanitizeForPtyInjection(msg.from);
    const replyNote = msg.reply_to ? ` [reply_to: ${msg.reply_to}]` : '';
    return `=== AGENT MESSAGE from ${from}${replyNote} [msg_id: ${msg.id}] ===
${wrapFenceSafe(msg.text)}
Reply using: cortextos bus send-message ${from} normal '<your reply>' ${msg.id}

`;
  }

  /**
   * Format a Telegram text message for injection.
   * Matches bash fast-checker.sh format.
   */
  static formatTelegramTextMessage(
    from: string,
    chatId: string | number,
    text: string,
    frameworkRoot: string,
    replyToText?: string,
    lastSentText?: string,
    recentHistory?: string,
  ): string {
    // Every externally-influenced field below is untrusted (the sender controls
    // text/display-name; reply-context, last-sent and recent-history are built
    // from prior external messages). Sanitize each so none can escape the fence
    // or forge a containment header. Unfenced context fields (reply/history) are
    // the weakest surface — they sit raw in [Replying to: "..."] / [Recent ...].
    const replyCx = FastChecker.formatReplyContext(replyToText);

    let lastSentCtx = '';
    if (lastSentText) {
      lastSentCtx = `[Your last message: "${sanitizeForPtyInjection(lastSentText.slice(0, 500))}"]\n`;
    }

    let historyCx = '';
    if (recentHistory) {
      historyCx = `[Recent conversation:]\n${sanitizeForPtyInjection(recentHistory)}\n`;
    }

    // Use [USER: ...] wrapper to prevent prompt injection via crafted display names
    // Slash commands (text starting with /) are NOT wrapped in backticks so Claude Code
    // can recognize and invoke them via the Skill tool (e.g. /loop, /commit, /restart).
    const isSlashCommand = /^\/[a-zA-Z]/.test(stripControlChars(text).trim());
    const body = isSlashCommand
      ? sanitizeForPtyInjection(text).trim()
      : wrapFenceSafe(text);
    return `=== TELEGRAM from [USER: ${sanitizeForPtyInjection(from)}] (chat_id:${chatId}) ===
${replyCx}${historyCx}${body}
${lastSentCtx}Reply using: cortextos bus send-telegram ${chatId} '<your reply>'

`;
  }

  /**
   * Format a Telegram message_reaction update for PTY injection.
   * Reactions are emoji additions/removals on existing messages — they
   * surface to the agent so it can follow up on positive acknowledgements
   * or clarify after a negative reaction.
   *
   * `newReaction` is the current reaction state (an empty list means the
   * user REMOVED their reaction). `oldReaction` lets the formatter
   * distinguish "added X" from "removed Y". Custom emoji (type=custom_emoji)
   * render as [custom_emoji] since we don't resolve the custom_emoji_id.
   */
  static formatTelegramReaction(
    from: string,
    chatId: string | number,
    messageId: number,
    oldReaction: Array<{ type: 'emoji'; emoji: string } | { type: 'custom_emoji'; custom_emoji_id: string }>,
    newReaction: Array<{ type: 'emoji'; emoji: string } | { type: 'custom_emoji'; custom_emoji_id: string }>,
  ): string {
    const render = (list: typeof newReaction): string =>
      list.length === 0
        ? '(none)'
        : list.map((r) => (r.type === 'emoji' ? r.emoji : '[custom_emoji]')).join(' ');

    const removed = newReaction.length === 0 && oldReaction.length > 0;
    const label = removed ? `removed ${render(oldReaction)}` : render(newReaction);

    return `=== REACTION from [USER: ${sanitizeForPtyInjection(from)}] (chat_id:${chatId}) on message ${messageId}: ${label} ===

`;
  }

  /**
   * Format a Telegram photo message for injection.
   * Matches bash fast-checker.sh format.
   */
  static formatTelegramPhotoMessage(
    from: string,
    chatId: string | number,
    caption: string,
    imagePath: string,
    replyToText?: string,
  ): string {
    return `=== TELEGRAM PHOTO from ${sanitizeForPtyInjection(from)} (chat_id:${chatId}) ===
${FastChecker.formatReplyContext(replyToText)}caption:
${wrapFenceSafe(caption)}
local_file: ${imagePath}
Reply using: cortextos bus send-telegram ${chatId} '<your reply>'

`;
  }

  /**
   * Format a Telegram document message for injection.
   * Matches bash fast-checker.sh format.
   */
  static formatTelegramDocumentMessage(
    from: string,
    chatId: string | number,
    caption: string,
    filePath: string,
    fileName: string,
    replyToText?: string,
  ): string {
    return `=== TELEGRAM DOCUMENT from ${sanitizeForPtyInjection(from)} (chat_id:${chatId}) ===
${FastChecker.formatReplyContext(replyToText)}caption:
${wrapFenceSafe(caption)}
local_file: ${filePath}
file_name: ${sanitizeForPtyInjection(fileName)}
Reply using: cortextos bus send-telegram ${chatId} '<your reply>'

`;
  }

  /**
   * Format a Telegram voice/audio message for injection.
   * Matches bash fast-checker.sh format.
   *
   * `transcript` is populated by `src/telegram/transcribe.ts` when whisper-cli
   * and the GGML model are available; otherwise it stays undefined and the
   * agent receives only the .ogg path. The codex extractor surfaces the
   * transcript block when present.
   */
  static formatTelegramVoiceMessage(
    from: string,
    chatId: string | number,
    filePath: string,
    duration: number | undefined,
    transcript?: string,
    replyToText?: string,
  ): string {
    const dur = duration !== undefined ? duration : 'unknown';
    const transcriptBlock = transcript && transcript.trim()
      ? `transcript:\n${wrapFenceSafe(transcript.trim())}\n`
      : '';
    return `=== TELEGRAM VOICE from ${sanitizeForPtyInjection(from)} (chat_id:${chatId}) ===
${FastChecker.formatReplyContext(replyToText)}duration: ${dur}s
local_file: ${filePath}
${transcriptBlock}Reply using: cortextos bus send-telegram ${chatId} '<your reply>'

`;
  }

  /**
   * Format a Telegram video/video_note message for injection.
   * Matches bash fast-checker.sh format.
   */
  static formatTelegramVideoMessage(
    from: string,
    chatId: string | number,
    caption: string,
    filePath: string,
    fileName: string,
    duration: number | undefined,
    replyToText?: string,
  ): string {
    const dur = duration !== undefined ? duration : 'unknown';
    return `=== TELEGRAM VIDEO from ${sanitizeForPtyInjection(from)} (chat_id:${chatId}) ===
${FastChecker.formatReplyContext(replyToText)}caption:
${wrapFenceSafe(caption)}
duration: ${dur}s
local_file: ${filePath}
file_name: ${sanitizeForPtyInjection(fileName)}
Reply using: cortextos bus send-telegram ${chatId} '<your reply>'

`;
  }

  private static formatReplyContext(replyToText?: string): string {
    return replyToText
      ? `[Replying to: "${sanitizeForPtyInjection(replyToText.slice(0, 500))}"]\n`
      : '';
  }

  /**
   * Wait for the agent to finish bootstrapping.
   */
  private async waitForBootstrap(timeoutMs: number = 30000): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (this.agent.isBootstrapped()) {
        return;
      }
      await sleep(2000);
    }
    this.log('Bootstrap timeout - proceeding anyway');
  }

  /**
   * Send typing indicator, rate-limited to once every 4 seconds.
   */
  private async sendTyping(api: TelegramAPI, chatId: string): Promise<void> {
    const now = Date.now();
    if (now - this.typingLastSent >= 4000) {
      try {
        await api.sendChatAction(chatId, 'typing');
      } catch {
        // Ignore typing indicator failures (matches bash: || true)
      }
      this.typingLastSent = now;
    }
  }

  /**
   * Read the last-sent message file for conversation context.
   * Returns the content (up to 500 chars) or null if not available.
   */
  static readLastSent(stateDir: string, chatId: string | number): string | null {
    const filePath = join(stateDir, `last-telegram-${chatId}.txt`);
    try {
      if (!existsSync(filePath)) return null;
      const content = readFileSync(filePath, 'utf-8');
      if (!content) return null;
      return content.slice(0, 500);
    } catch {
      return null;
    }
  }

  /**
   * Handle a callback from the org's activity-channel bot.
   *
   * Runs alongside the agent's primary bot callback handler when the agent
   * is the org's orchestrator (see agent-manager.ts for the wiring). Only
   * appr_(allow|deny)_<approvalId> prefixes are accepted here — the
   * activity-channel bot only ever posts approval buttons, so any other
   * callback is rejected. The responding API must be the activity-channel
   * API (not the agent's own bot) so answerCallbackQuery + editMessageText
   * target the right message on the right bot.
   */
  async handleActivityCallback(query: TelegramCallbackQuery, activityApi: TelegramAPI): Promise<void> {
    const data = stripControlChars(query.data || '');
    const callbackQueryId = query.id;

    // SECURITY: callbacks must come from the whitelisted user. Identical
    // check to handleCallback — approval clicks are as sensitive as
    // permission clicks and the same gate applies.
    if (!this.isAllowedTelegramUser(query.from?.id)) {
      this.log(`SECURITY: activity-channel callback from unauthorized user ${query.from?.id} - rejecting`);
      try { await activityApi.answerCallbackQuery(callbackQueryId, 'Not authorized'); } catch { /* ignore */ }
      return;
    }

    const apprMatch = data.match(/^appr_(allow|deny)_(approval_\d+_[a-zA-Z0-9]+)$/);
    if (!apprMatch) {
      this.log(`activity-channel callback ignored (unknown prefix): ${data.slice(0, 40)}`);
      try { await activityApi.answerCallbackQuery(callbackQueryId, 'Unknown button'); } catch { /* ignore */ }
      return;
    }

    await this.routeApprovalCallback(apprMatch[1] as 'allow' | 'deny', apprMatch[2], query, activityApi);
  }

  /**
   * Shared approval-callback resolution path. Called by both handleCallback
   * (agent's own bot) and handleActivityCallback (activity-channel bot).
   *
   * Resolves the approval via updateApproval (which moves the file from
   * pending/ to resolved/ and notifies the requesting agent via inbox),
   * answers the Telegram callback so the spinner stops, and edits the
   * original message to show who approved/denied for the audit trail.
   *
   * `api` is the TelegramAPI that owns the bot the callback came from —
   * answerCallbackQuery and editMessageText must target the same bot.
   */
  private async routeApprovalCallback(
    decision: 'allow' | 'deny',
    approvalId: string,
    query: TelegramCallbackQuery,
    api: TelegramAPI | undefined,
  ): Promise<void> {
    const chatId = query.message?.chat?.id;
    const messageId = query.message?.message_id;
    const callbackQueryId = query.id;
    const status = decision === 'allow' ? 'approved' : 'rejected';

    // Build a friendly audit-trail suffix: "by Alice (@alice)" or just
    // "by Alice" if no username. Falls back to the Telegram user id if
    // both are missing (shouldn't happen in practice but guards edge).
    const firstName = query.from?.first_name;
    const username = query.from?.username;
    const auditWho = firstName && username
      ? `${firstName} (@${username})`
      : firstName ?? (username ? `@${username}` : `user ${query.from?.id ?? 'unknown'}`);
    const auditNote = `via Telegram activity channel by ${auditWho}`;

    try {
      updateApproval(this.paths, approvalId, status, auditNote);
    } catch (err) {
      this.log(`Approval callback: updateApproval failed for ${approvalId}: ${err}`);
      if (api) {
        try { await api.answerCallbackQuery(callbackQueryId, 'Approval not found or already resolved'); } catch { /* ignore */ }
      }
      return;
    }

    if (api) {
      try { await api.answerCallbackQuery(callbackQueryId, decision === 'allow' ? 'Approved' : 'Denied'); } catch { /* ignore */ }
      if (chatId && messageId) {
        const label = decision === 'allow' ? `✅ Approved by ${auditWho}` : `❌ Denied by ${auditWho}`;
        try { await api.editMessageText(chatId, messageId, label); } catch { /* ignore */ }
      }
    }
    this.log(`Approval callback: ${decision} for ${approvalId} by ${auditWho}`);
  }

  /**
   * Handle a Telegram inline button callback query.
   * Routes to permission, restart, or AskUserQuestion handlers.
   */
  async handleCallback(query: TelegramCallbackQuery): Promise<void> {
    const data = stripControlChars(query.data || '');
    const chatId = query.message?.chat?.id;
    const messageId = query.message?.message_id;
    const callbackQueryId = query.id;

    // SECURITY: callbacks must come from the whitelisted user. Without this,
    // anyone who sees a button (forwarded message, group, etc.) could click it.
    if (!this.isAllowedTelegramUser(query.from?.id)) {
      this.log(`SECURITY: callback from unauthorized user ${query.from?.id} - rejecting`);
      return;
    }

    // Approval callbacks: appr_(allow|deny)_{approvalId}
    // These originate from the org's activity channel bot (see
    // handleActivityCallback) but may also arrive here if an operator
    // ever routes an approval button through the agent's own bot. The
    // prefix check is cheap and routing-agnostic.
    const apprMatch = data.match(/^appr_(allow|deny)_(approval_\d+_[a-zA-Z0-9]+)$/);
    if (apprMatch) {
      await this.routeApprovalCallback(apprMatch[1] as 'allow' | 'deny', apprMatch[2], query, this.telegramApi);
      return;
    }

    // Permission callbacks: perm_(allow|deny|continue)_{hexId}
    const permMatch = data.match(/^perm_(allow|deny|continue)_([a-f0-9]+)$/);
    if (permMatch) {
      const [, decision, hexId] = permMatch;
      const hookDecision = decision === 'continue' ? 'deny' : decision;
      const responseFile = join(this.paths.stateDir, `hook-response-${hexId}.json`);
      writeFileSync(responseFile, JSON.stringify({ decision: hookDecision }) + '\n', 'utf-8');

      if (this.telegramApi) {
        try { await this.telegramApi.answerCallbackQuery(callbackQueryId, 'Got it'); } catch { /* ignore */ }
        if (chatId && messageId) {
          const labelMap: Record<string, string> = { allow: 'Approved', deny: 'Denied', continue: 'Continue in Chat' };
          try { await this.telegramApi.editMessageText(chatId, messageId, labelMap[decision] || decision); } catch { /* ignore */ }
        }
      }
      this.log(`Permission callback: ${decision} for ${hexId}`);
      return;
    }

    // Restart callbacks: restart_(allow|deny)_{hexId}
    const restartMatch = data.match(/^restart_(allow|deny)_([a-f0-9]+)$/);
    if (restartMatch) {
      const [, decision, hexId] = restartMatch;
      const responseFile = join(this.paths.stateDir, `restart-response-${hexId}.json`);
      writeFileSync(responseFile, JSON.stringify({ decision }) + '\n', 'utf-8');

      if (this.telegramApi) {
        try { await this.telegramApi.answerCallbackQuery(callbackQueryId, 'Got it'); } catch { /* ignore */ }
        if (chatId && messageId) {
          const label = decision === 'allow' ? 'Restart Approved' : 'Restart Denied';
          try { await this.telegramApi.editMessageText(chatId, messageId, label); } catch { /* ignore */ }
        }
      }
      this.log(`Restart callback: ${decision} for ${hexId}`);
      return;
    }

    // AskUserQuestion single-select: askopt_{questionIdx}_{optionIdx}
    const askoptMatch = data.match(/^askopt_(\d+)_(\d+)$/);
    if (askoptMatch) {
      const qIdx = parseInt(askoptMatch[1], 10);
      const oIdx = parseInt(askoptMatch[2], 10);

      if (this.telegramApi) {
        try { await this.telegramApi.answerCallbackQuery(callbackQueryId, 'Got it'); } catch { /* ignore */ }
        if (chatId && messageId) {
          try { await this.telegramApi.editMessageText(chatId, messageId, 'Answered'); } catch { /* ignore */ }
        }
      }

      // Navigate TUI: Down * oIdx, then Enter
      for (let k = 0; k < oIdx; k++) {
        this.agent.write(KEYS.DOWN);
        await sleep(50);
      }
      await sleep(100);
      this.agent.write(KEYS.ENTER);

      this.log(`AskUserQuestion: Q${qIdx} selected option ${oIdx}`);

      // Check for more questions
      const askStatePath = join(this.paths.stateDir, 'ask-state.json');
      if (existsSync(askStatePath)) {
        try {
          const state = this.validateAskState(JSON.parse(readFileSync(askStatePath, 'utf-8')), askStatePath);
          if (!state) return;
          const totalQ = state.total_questions || 1;
          const nextQ = qIdx + 1;
          if (nextQ < totalQ) {
            state.current_question = nextQ;
            writeFileSync(askStatePath, JSON.stringify(state) + '\n', 'utf-8');
            await sleep(500);
            await this.sendNextQuestion(nextQ);
          } else {
            await sleep(500);
            this.agent.write(KEYS.ENTER);
            this.log('AskUserQuestion: submitted all answers');
            try { unlinkSync(askStatePath); } catch { /* ignore */ }
          }
        } catch { /* ignore parse errors */ }
      }
      return;
    }

    // AskUserQuestion multi-select toggle: asktoggle_{questionIdx}_{optionIdx}
    const toggleMatch = data.match(/^asktoggle_(\d+)_(\d+)$/);
    if (toggleMatch) {
      const qIdx = parseInt(toggleMatch[1], 10);
      const oIdx = parseInt(toggleMatch[2], 10);

      if (this.telegramApi) {
        try { await this.telegramApi.answerCallbackQuery(callbackQueryId, 'Toggled'); } catch { /* ignore */ }
      }

      const askStatePath = join(this.paths.stateDir, 'ask-state.json');
      if (existsSync(askStatePath)) {
        try {
          const state = this.validateAskState(JSON.parse(readFileSync(askStatePath, 'utf-8')), askStatePath);
          if (!state) {
            this.log(`AskUserQuestion: invalid ask-state, ignoring toggle for Q${qIdx}`);
            return;
          }
          if (!state.multi_select_chosen) state.multi_select_chosen = [];

          const idx = state.multi_select_chosen.indexOf(oIdx);
          if (idx === -1) {
            state.multi_select_chosen.push(oIdx);
          } else {
            state.multi_select_chosen.splice(idx, 1);
          }
          writeFileSync(askStatePath, JSON.stringify(state) + '\n', 'utf-8');

          // Update Telegram message with current selections
          if (this.telegramApi && chatId && messageId) {
            const chosen = [...state.multi_select_chosen].sort((a: number, b: number) => a - b);
            const chosenDisplay = chosen.map((i: number) => i + 1).join(', ');
            const question = state.questions?.[qIdx];
            const options: string[] = question?.options || [];

            // Build keyboard with toggle buttons + submit
            const keyboard: Array<Array<{ text: string; callback_data: string }>> = options.map((opt: string, i: number) => [{
              text: opt || `Option ${i + 1}`,
              callback_data: `asktoggle_${qIdx}_${i}`,
            }]);
            keyboard.push([{ text: 'Submit Selections', callback_data: `asksubmit_${qIdx}` }]);

            const text = chosenDisplay
              ? `Selected: ${chosenDisplay}\nTap more options or Submit`
              : 'Tap options to toggle, then tap Submit';

            try {
              await this.telegramApi.editMessageText(chatId, messageId, text, { inline_keyboard: keyboard });
            } catch { /* ignore */ }
          }
        } catch { /* ignore parse errors */ }
      }
      this.log(`AskUserQuestion: Q${qIdx} toggled option ${oIdx}`);
      return;
    }

    // AskUserQuestion multi-select submit: asksubmit_{questionIdx}
    const submitMatch = data.match(/^asksubmit_(\d+)$/);
    if (submitMatch) {
      const qIdx = parseInt(submitMatch[1], 10);

      if (this.telegramApi) {
        try { await this.telegramApi.answerCallbackQuery(callbackQueryId, 'Submitted'); } catch { /* ignore */ }
        if (chatId && messageId) {
          try { await this.telegramApi.editMessageText(chatId, messageId, 'Submitted'); } catch { /* ignore */ }
        }
      }

      const askStatePath = join(this.paths.stateDir, 'ask-state.json');
      if (existsSync(askStatePath)) {
        try {
          const state = this.validateAskState(JSON.parse(readFileSync(askStatePath, 'utf-8')), askStatePath);
          if (!state) return;
          const chosenIndices: number[] = [...(state.multi_select_chosen || [])].sort((a, b) => a - b);
          const question = state.questions?.[qIdx];
          const totalOpts = question?.options?.length || 4;

          // Navigate TUI: for each chosen index, move Down from current position, press Space
          let currentPos = 0;
          for (const idx of chosenIndices) {
            const moves = idx - currentPos;
            for (let k = 0; k < moves; k++) {
              this.agent.write(KEYS.DOWN);
              await sleep(50);
            }
            this.agent.write(KEYS.SPACE);
            await sleep(50);
            currentPos = idx;
          }

          // Navigate to Submit button (past all options + 1 for "Other")
          const submitPos = totalOpts + 1;
          const remaining = submitPos - currentPos;
          for (let k = 0; k < remaining; k++) {
            this.agent.write(KEYS.DOWN);
            await sleep(50);
          }
          await sleep(100);
          this.agent.write(KEYS.ENTER);

          this.log(`AskUserQuestion: Q${qIdx} submitted multi-select`);

          // Reset multi_select_chosen
          state.multi_select_chosen = [];
          writeFileSync(askStatePath, JSON.stringify(state) + '\n', 'utf-8');

          // Check for more questions
          const totalQ = state.total_questions || 1;
          const nextQ = qIdx + 1;
          if (nextQ < totalQ) {
            state.current_question = nextQ;
            writeFileSync(askStatePath, JSON.stringify(state) + '\n', 'utf-8');
            await sleep(500);
            await this.sendNextQuestion(nextQ);
          } else {
            await sleep(500);
            this.agent.write(KEYS.ENTER);
            this.log('AskUserQuestion: submitted all answers');
            try { unlinkSync(askStatePath); } catch { /* ignore */ }
          }
        } catch { /* ignore parse errors */ }
      }
      return;
    }

    // Inject unhandled callbacks as a Telegram message so the agent can process custom button flows.
    // senderName (Telegram first_name) and callback_data are untrusted: sanitize both against
    // PTY-injection before interpolating, matching the text path (sanitizeForPtyInjection at the
    // `=== TELEGRAM from [USER: ...]` header). This block predates #592; #592's hardening was never
    // retrofitted here, leaving forged `=== AGENT MESSAGE`/fence-breakout headers un-neutralized.
    if (chatId && this.agent) {
      const senderName = sanitizeForPtyInjection(query.from?.first_name || 'User');
      const safeData = sanitizeForPtyInjection(data);
      const msg = [
        `=== TELEGRAM from [USER: ${senderName}] (chat_id:${chatId}) ===`,
        `callback_data: ${safeData}`,
        `message_id: ${messageId}`,
        `Reply using: cortextos bus send-telegram ${chatId} '<your reply>'`,
      ].join('\n');
      const injected = this.agent.injectMessage(msg);
      if (injected && this.telegramApi) {
        try { await this.telegramApi.answerCallbackQuery(callbackQueryId, 'Got it'); } catch { /* ignore */ }
      }
      this.log(`Injected unhandled callback to agent: ${data.slice(0, 60)}`);
    } else {
      this.log(`Unhandled callback data (no agent/chatId): ${data}`);
    }
  }

  /**
   * Send the next AskUserQuestion to Telegram.
   * Reads ask-state.json and builds the question message and inline keyboard.
   */
  async sendNextQuestion(questionIdx: number): Promise<void> {
    if (!this.telegramApi || !this.chatId) {
      this.log('sendNextQuestion: no Telegram API or chatId configured');
      return;
    }

    const askStatePath = join(this.paths.stateDir, 'ask-state.json');
    if (!existsSync(askStatePath)) {
      this.log('sendNextQuestion: state file not found');
      return;
    }

    try {
      const state = this.validateAskState(JSON.parse(readFileSync(askStatePath, 'utf-8')), askStatePath);
      if (!state) return;
      const totalQ = state.total_questions || 1;
      const question = state.questions?.[questionIdx];
      if (!question) {
        this.log(`sendNextQuestion: question ${questionIdx} not found`);
        return;
      }

      const qText = question.question || 'Question';
      const qHeader = question.header || '';
      const qMulti = question.multiSelect === true;
      const qOptions: string[] = question.options || [];

      // Build message text
      let msg = `QUESTION (${questionIdx + 1}/${totalQ}) - ${this.agent.name}:`;
      if (qHeader) msg += `\n${qHeader}`;
      msg += `\n${qText}\n`;
      if (qMulti) {
        msg += '\n(Multi-select: tap options to toggle, then tap Submit)';
      }
      for (let i = 0; i < qOptions.length; i++) {
        msg += `\n${i + 1}. ${qOptions[i] || `Option ${i + 1}`}`;
      }

      // Build inline keyboard
      let keyboard: Array<Array<{ text: string; callback_data: string }>>;
      if (qMulti) {
        keyboard = qOptions.map((opt, i) => [{
          text: opt || `Option ${i + 1}`,
          callback_data: `asktoggle_${questionIdx}_${i}`,
        }]);
        keyboard.push([{ text: 'Submit Selections', callback_data: `asksubmit_${questionIdx}` }]);
      } else {
        keyboard = qOptions.map((opt, i) => [{
          text: opt || `Option ${i + 1}`,
          callback_data: `askopt_${questionIdx}_${i}`,
        }]);
      }

      await this.telegramApi.sendMessage(this.chatId, msg, { inline_keyboard: keyboard });
      this.log(`Sent question ${questionIdx + 1}/${totalQ} to Telegram`);
    } catch (err) {
      this.log(`sendNextQuestion error: ${err}`);
    }
  }

  /**
   * Sleep that can be interrupted by SIGUSR1.
   */
  private sleepInterruptible(ms: number): Promise<void> {
    return new Promise(resolve => {
      const timer = setTimeout(resolve, ms);
      this.wakeResolve = () => {
        clearTimeout(timer);
        resolve();
      };
    });
  }

  /**
   * Check for .urgent-signal file and process it.
   */
  private checkUrgentSignal(): void {
    const urgentPath = join(this.paths.stateDir, '.urgent-signal');
    if (existsSync(urgentPath)) {
      try {
        const content = readFileSync(urgentPath, 'utf-8').trim();
        this.log(`Urgent signal detected: ${content}`);
        unlinkSync(urgentPath);

        // Inject the urgent message — fence the body unescapably (#592 follow-up)
        // so a signal payload carrying its own fence can't break out and forge
        // daemon containment headers.
        if (content) {
          const urgentMsg = `=== URGENT SIGNAL ===\n${wrapFenceSafe(content)}\n\n`;
          this.agent.injectMessage(urgentMsg);
        }
      } catch (err) {
        this.log(`Error processing urgent signal: ${err}`);
      }
    }
  }

  /**
   * Read ctx thresholds from config.json with mtime-based caching (BUG-048 pattern).
   * Re-reads from disk only when the file has changed so dashboard updates take effect
   * within one poll cycle without a daemon restart.
   */
  private getCtxThresholds(): { warn: number; handoff: number } {
    try {
      const configPath = join(this.agent.getAgentDir(), 'config.json');
      const mtime = statSync(configPath).mtimeMs;
      if (mtime !== this.ctxConfigMtime) {
        const cfg = JSON.parse(readFileSync(configPath, 'utf-8'));
        const config = this.agent.getConfig();
        config.ctx_warning_threshold = cfg.ctx_warning_threshold;
        config.ctx_handoff_threshold = cfg.ctx_handoff_threshold;
        this.ctxConfigMtime = mtime;
      }
    } catch { /* keep stale values */ }
    const config = this.agent.getConfig();
    return {
      // Context-handoff is ON by default for every runtime/agent: an unset
      // threshold falls back to 30% warning / 60% handoff (a percentage of the
      // ACTIVE model's context window, so it adapts to window size). An explicit
      // ctx_handoff_threshold <= 0 is the deliberate opt-out (see checkContextStatus).
      warn: config.ctx_warning_threshold ?? 30,
      handoff: config.ctx_handoff_threshold ?? 60,
    };
  }

  /**
   * Context monitor — called on every poll cycle.
   * Reads context_status.json written by the statusLine bridge hook and takes
   * action when thresholds are crossed.
   */
  private async checkContextStatus(): Promise<void> {
    const now = Date.now();

    // Circuit breaker: check if we should pause auto-restarts
    if (this.ctxCircuitBrokenAt !== null) {
      if (now - this.ctxCircuitBrokenAt >= 30 * 60_000) {
        this.ctxCircuitBrokenAt = null;
        this.ctxCircuitRestarts = [];
        this.ctxHandoffFires = [];
        this.saveCtxCircuit();
        this.log('Context circuit breaker reset after 30min pause');
      } else {
        return; // still paused
      }
    }

    // Read the bridge file written by hook-context-status
    const statusPath = join(this.paths.stateDir, 'context_status.json');
    if (!existsSync(statusPath)) return;

    let pct: number | null = null;
    let exceeds200k = false;
    try {
      const raw = readFileSync(statusPath, 'utf-8');
      const data = this.validateContextStatus(JSON.parse(raw), statusPath);
      if (!data) return;
      const age = now - new Date(data.written_at || 0).getTime();
      if (age > 10 * 60_000) return; // stale file — skip
      pct = data.used_percentage;
      exceeds200k = data.exceeds_200k_tokens;

      // Detect new session: if session_id changed, clear stale per-session ctx state.
      // This handles the case where the agent self-restarts (voluntary handoff) and the
      // 5-min deadline timer would otherwise fire on the fresh low-context session.
      const incomingSessionId = data.session_id ?? null;
      if (incomingSessionId && incomingSessionId !== this.ctxLastSessionId) {
        // Release any context-handoff lease held by this agent on a fresh session.
        // This MUST be unconditional — released by agent name, not gated on
        // ctxLastSessionId or the in-memory ctxHandoffLeaseId. A handoff restart can
        // reset this monitor's per-agent state (both fields back to null), so gating
        // release on either leaks the lease until its 10-min TTL and starves the fleet
        // handoff queue: completed handoffs never free their slot, and queued agents
        // above threshold wait up to a full TTL for a slot. A fresh session never needs
        // a lease acquired by a prior session of the same agent; release-by-name is a
        // no-op when none is held and also clears any stale queue entry.
        releaseContextHandoffLease(this.paths.ctxRoot, this.agent.name);
        this.ctxHandoffLeaseId = null;
        if (this.ctxLastSessionId !== null) {
          this.ctxHandoffFiredAt = 0;
          this.ctxHandoffDeadlineAt = 0;
          this.ctxWarningFiredAt = 0;
          this.log(`New session detected (${incomingSessionId.slice(0, 8)}…) — per-session ctx state reset`);
        }
        this.ctxLastSessionId = incomingSessionId;
        // Anchor the handoff grace window. A freshly-started session begins at low
        // context, so context-handoff actions are suppressed for HANDOFF_GRACE_MS to
        // avoid acting on a transient/stale high reading (observed on fresh codex
        // app-server threads that briefly report prior prompt-cache tokens) that
        // would otherwise fire an immediate handoff → restart → fresh-session loop.
        this.ctxSessionStartedAt = now;
      }
    } catch { return; }

    // Check PTY output for hard API overflow errors (always act regardless of threshold config).
    // Guard: only treat the banner phrase as a *live* overflow when context usage actually
    // corroborates it (exceeds 200k, or pct genuinely high). The same phrase appears as benign
    // text in memory files, source, and chat that *document* this mechanism — without this guard
    // a fresh boot re-reading those at low context force-restarts on every boot, producing a loop.
    const ctxCorroboratesOverflow = exceeds200k || (pct !== null && pct >= 85);
    const recentOutput = this.agent.getOutputBuffer()?.getRecent(8000) ?? '';
    if (ctxCorroboratesOverflow && /extra usage.*?1[Mm] context|conversation too long.*?compaction/i.test(recentOutput)) {
      this.log('Context overflow error detected in PTY output at high context — force restarting');
      this.forceContextRestart('API overflow error in PTY output');
      return;
    }

    const { warn, handoff } = this.getCtxThresholds();

    // Default-ON: an UNSET ctx_handoff_threshold uses the 60% default from
    // getCtxThresholds (handoff on for every agent with no config). An explicit
    // ctx_handoff_threshold <= 0 is the deliberate opt-out (observe-only: log,
    // never act). This is the only disable path now that default is on.
    const configuredHandoff = this.agent.getConfig().ctx_handoff_threshold;
    if (configuredHandoff !== undefined && configuredHandoff <= 0) return;

    const effectivePct = pct ?? (exceeds200k ? 101 : null);
    if (effectivePct === null) return;

    // Session-id-independent leaked-lease release (the Claude null-session_id edge).
    // The new-session detection above only releases a leaked lease when the bridge
    // reports a non-null session_id. hook-context-status writes `session_id ?? null`,
    // so a fresh Claude session reports session_id:null, that block is skipped, and a
    // lease leaked by the agent's prior session sits in `active` until its 10-min TTL —
    // starving the fleet handoff queue on the majority (Claude) path. Release it by name
    // here, gated on the precise safety condition rather than the session_id proxy:
    //   (1) effectivePct < handoff — the agent is NOT mid-handoff, so it cannot
    //       legitimately need a handoff lease this tick; and
    //   (2) ctxHandoffLeaseId === null — this monitor did not itself acquire the live
    //       lease. A lease acquired by the CURRENT session always sets ctxHandoffLeaseId
    //       synchronously at the Tier 2 acquire below (and resets context_status to 0%,
    //       so the very next tick is below-threshold-but-lease-held). The only way to
    //       hold a lease with this field null is that a prior session acquired it and a
    //       full respawn recreated this monitor with null state — i.e. the leaked lease.
    //       This is exactly the guarantee the original non-null-session_id gate gave,
    //       without the proxy. A read-only existence check runs first so idle ticks
    //       never pay the lease-file write.
    if (
      effectivePct < handoff
      && this.ctxHandoffLeaseId === null
      && agentHoldsContextHandoffLease(this.paths.ctxRoot, this.agent.name, now)
    ) {
      releaseContextHandoffLease(this.paths.ctxRoot, this.agent.name);
      this.log('Released leaked context-handoff lease by name (fresh below-threshold session)');
    }

    // Grace window after a fresh session start: suppress soft context actions
    // (warning + handoff) while the session is younger than HANDOFF_GRACE_MS. A
    // just-started session cannot legitimately be at genuine overflow, so a high
    // reading inside this window is a transient/stale spike (e.g. a fresh codex
    // app-server thread briefly reporting prior prompt-cache tokens). Without this,
    // such a spike fired an immediate handoff → cooperative hard-restart → fresh
    // session, repeating every ~1-2min. The window is runtime-aware: codex-app-server
    // and opencode can emit that spurious spike ~6-8min after boot (observed
    // double-handoffs ~6-8min apart on a codex agent), so they get a 10min grace
    // while all other runtimes keep 2min — see handoffGraceMs(). Hard API-overflow
    // detection above is NOT gated by grace, so a genuine overflow is still caught
    // immediately.
    const HANDOFF_GRACE_MS = handoffGraceMs(this.agent.getConfig().runtime);
    const withinHandoffGrace =
      this.ctxSessionStartedAt > 0 && now - this.ctxSessionStartedAt < HANDOFF_GRACE_MS;

    // Tier 3: deadline exceeded — force restart if agent ignored handoff prompt
    if (this.ctxHandoffDeadlineAt > 0 && now > this.ctxHandoffDeadlineAt) {
      this.log(`Handoff deadline exceeded (${Math.round(effectivePct)}%) — force restarting`);
      this.ctxHandoffDeadlineAt = 0;
      this.forceContextRestart(`ctx ${Math.round(effectivePct)}% — handoff not completed within 5min`);
      return;
    }

    // Tier 1: warning — PTY injection only, no Telegram ping (context management is internal)
    if (effectivePct >= warn && !withinHandoffGrace && now - this.ctxWarningFiredAt > 15 * 60_000) {
      this.ctxWarningFiredAt = now;
      const pctRound = Math.round(effectivePct);
      const statusSuffix = effectivePct >= handoff ? 'Handoff in progress.' : `Handoff triggers at ${handoff}%.`;
      this.agent.injectMessage(`[CONTEXT] Window at ${pctRound}%. ${statusSuffix}`);
      this.log(`Context warning fired at ${pctRound}%`);
    }

    // Tier 2: handoff (fires once per session lifecycle)
    if (effectivePct >= handoff && this.ctxHandoffFiredAt === 0 && !withinHandoffGrace) {
      const lease = requestContextHandoffLease({
        ctxRoot: this.paths.ctxRoot,
        agentName: this.agent.name,
      });
      if (lease.status === 'queued') {
        if (now - this.ctxHandoffQueuedLogAt > 60_000) {
          this.ctxHandoffQueuedLogAt = now;
          this.log(
            `Context handoff queued at ${Math.round(effectivePct)}% `
            + `(position ${lease.position}, active ${lease.activeCount}, queued ${lease.queuedCount}, wait ~${Math.ceil(lease.waitMs / 1000)}s)`,
          );
        }
        return;
      }
      this.ctxHandoffLeaseId = lease.leaseId;
      this.ctxHandoffFiredAt = now;

      // Cooperative-restart loop backstop. A handoff normally fires ONCE per session and
      // the fresh session drops well below threshold, so legitimate usage never re-fires
      // soon. If a runtime fails to reset context on the handoff restart (e.g. a
      // thread-persistence regression), the fresh session immediately re-crosses the
      // threshold and re-fires every cycle — a self-sustaining treadmill the restart
      // circuit breaker misses because these are COOPERATIVE handoff restarts, not Tier-3
      // force-restarts. Count handoff fires in a persisted 15min window (survives the
      // restart); if they reach the cap, trip the circuit breaker (30min pause) instead of
      // handing off again, so any handoff loop self-limits regardless of cause. Cap 3 is
      // above the benign 1-2 fires a single very-large turn can produce before settling.
      this.ctxHandoffFires = this.ctxHandoffFires.filter(t => now - t < 15 * 60_000);
      this.ctxHandoffFires.push(now);
      this.saveCtxCircuit();
      if (this.ctxHandoffFires.length >= 3) {
        this.ctxCircuitBrokenAt = now;
        this.saveCtxCircuit();
        // Release the lease we just acquired — we are pausing, not handing off.
        releaseContextHandoffLease(this.paths.ctxRoot, this.agent.name);
        this.ctxHandoffLeaseId = null;
        this.ctxHandoffFiredAt = 0;
        const msg = `Context handoff loop detected for ${this.agent.name}: ${this.ctxHandoffFires.length} handoffs in 15min — a runtime may not be resetting context on restart. Auto-handoff paused 30min. Check logs/${this.agent.name}/restarts.log.`;
        this.log(msg);
        if (this.telegramApi && this.chatId) {
          this.telegramApi.sendMessage(this.chatId, msg).catch(() => {});
        }
        return;
      }

      this.ctxHandoffDeadlineAt = now + 5 * 60_000; // 5min grace for agent to cooperate
      // Reset context_status.json so the new session doesn't re-trigger immediately
      const statusPath = join(this.paths.stateDir, 'context_status.json');
      try {
        writeFileSync(statusPath, JSON.stringify({ used_percentage: 0, exceeds_200k_tokens: false, written_at: new Date().toISOString() }));
      } catch { /* non-fatal */ }
      const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19) + 'Z';
      const handoffPrompt = `[CONTEXT HANDOFF REQUIRED] Context is at ${Math.round(effectivePct)}%. Write a handoff document to memory/handoffs/handoff-${ts}.md with these sections: ## Current Tasks, ## Next Actions, ## Active Crons, ## Key Context, ## Files Modified This Session. Then run: cortextos bus hard-restart --reason "context handoff at ${Math.round(effectivePct)}%" --handoff-doc <absolute path to the handoff doc you just wrote>. Do this NOW before the context window is exhausted.`;
      this.agent.injectMessage(handoffPrompt);
      this.log(`Handoff prompt injected at ${Math.round(effectivePct)}%`);
      // Pre-arm .force-fresh so the next restart is always a clean fresh session.
      // If the agent cooperates and calls hard-restart, it also writes .force-fresh — no-op.
      // If context exhausts naturally before the agent acts, .force-fresh is already set,
      // preventing a --continue restart that would loop at the same high context level.
      try {
        writeFileSync(join(this.paths.stateDir, '.force-fresh'), 'tier2-prearm\n', 'utf-8');
      } catch { /* non-fatal */ }
    }
  }

  /**
   * Force a fresh hard restart for context exhaustion reasons.
   * Writes .force-fresh + .restart-planned, then triggers sessionRefresh().
   * The circuit breaker prevents runaway restart loops.
   */
  private forceContextRestart(reason: string): void {
    const now = Date.now();

    // Update and check circuit breaker window (persisted to disk — survives --continue restarts)
    this.ctxCircuitRestarts = this.ctxCircuitRestarts.filter(t => now - t < 15 * 60_000);
    if (this.ctxCircuitRestarts.length >= 3) {
      this.ctxCircuitBrokenAt = now;
      this.saveCtxCircuit();
      const msg = `Context circuit breaker TRIPPED for ${this.agent.name}: 3 restarts in 15min. Watchdog paused 30min. Check logs/${this.agent.name}/restarts.log for details.`;
      this.log(msg);
      if (this.telegramApi && this.chatId) {
        this.telegramApi.sendMessage(this.chatId, msg).catch(() => {});
      }
      return;
    }
    this.ctxCircuitRestarts.push(now);
    this.saveCtxCircuit();

    // Preserve a recent handoff doc the agent wrote but didn't get to pass via
    // hard-restart --handoff-doc, so the new session still receives it.
    this.preserveRecentHandoffDoc();

    // Reset per-session context state for the new session
    this.ctxHandoffFiredAt = 0;
    this.ctxHandoffDeadlineAt = 0;
    this.ctxWarningFiredAt = 0;

    // Release this dying session's context-handoff lease on teardown. This restart is
    // IN-PROCESS — sessionRefresh() below does stop()+start() on the same AgentProcess
    // and does NOT recreate this FastChecker, so ctxHandoffLeaseId survives into the
    // fresh session. The by-name cleanup in checkContextStatus is gated on
    // ctxHandoffLeaseId === null, so without this it would skip a lease this session
    // leaked when the fresh session reports session_id:null (the Tier-3 arm of the
    // Claude null-session_id leak — the agent ignored the 5-min handoff prompt and was
    // force-restarted). Release by name and clear the in-memory id HERE, before the
    // restart spawns the new session, so we free the dying session's own lease — never
    // a lease the fresh session might later acquire.
    releaseContextHandoffLease(this.paths.ctxRoot, this.agent.name);
    this.ctxHandoffLeaseId = null;

    // Write .force-fresh + .restart-planned (hardRestart from src/bus/system.ts)
    hardRestart(this.paths, this.agent.name, `CONTEXT-FORCE-RESTART: ${reason}`);

    // Reset context_status.json so the new session's FastChecker doesn't re-trigger
    // Tier 2 immediately by reading the stale high-% value from the previous session.
    const statusPath = join(this.paths.stateDir, 'context_status.json');
    try {
      writeFileSync(statusPath, JSON.stringify({ used_percentage: 0, exceeds_200k_tokens: false, written_at: new Date().toISOString() }));
    } catch { /* non-fatal */ }

    // sessionRefresh() does stop() + start(); shouldContinue() will return false
    // because .force-fresh was just written, giving us a clean fresh session.
    this.agent.sessionRefresh().catch(err => this.log(`Context restart failed: ${err}`));
  }

  /** @internal */
  resetWatchdogState(): void {
    const now = Date.now();
    this.sessionStartedAt = now;
    this.idleFlagSeenThisSession = false;
    this.idleFlagInactiveLogged = false;
    this.ctxHandoffFiredAt = 0;
    this.ctxHandoffDeadlineAt = 0;
    this.ctxWarningFiredAt = 0;
    this.stdoutLogSize = -1;
    this.watchdogTriggered = false;
    this.ctxThresholdTriggeredAt = 0;
    this.stdoutLastChangeAt = now;
    this.stdoutLastSize = 0;
    this.watchdogCircuitBroken = false;
    this.watchdogRestarts = [];
    this.watchdogCircuitBrokenAt = 0;
    this.turnHung = false;
    this.turnWatchdogTrackedInjectAt = this.getLastInjectedAt();
    this.turnWatchdogAlertedInjectAt = this.turnWatchdogTrackedInjectAt;
    this.lastMeaningfulOutputAt = this.turnWatchdogTrackedInjectAt > 0 ? now : 0;
    this.meaningfulOutputFingerprints.clear();
    try {
      const stdoutPath = join(this.paths.logDir, 'stdout.log');
      this.stdoutMeaningfulOffset = existsSync(stdoutPath) ? statSync(stdoutPath).size : -1;
    } catch {
      this.stdoutMeaningfulOffset = -1;
    }
    this.log('Watchdog state reset for new session');
  }

  /**
   * Compute a hash for message dedup. Uses SHA-256 to avoid collision attacks.
   */
  private hashMessage(text: string): string {
    return createHash('sha256').update(text).digest('hex');
  }

  /**
   * Check if message has been seen (dedup). Returns true if duplicate.
   */
  isDuplicate(text: string): boolean {
    const hash = this.hashMessage(text);
    if (this.seenHashes.has(hash)) return true;
    this.seenHashes.add(hash);
    this.saveDedupHashes();
    return false;
  }

  /**
   * Load dedup hashes from persistent file.
   */
  private loadDedupHashes(): void {
    try {
      if (existsSync(this.dedupFilePath)) {
        const content = readFileSync(this.dedupFilePath, 'utf-8');
        const hashes = content.trim().split('\n').filter(Boolean);
        // Keep only last 1000 hashes to prevent file bloat
        const recent = hashes.slice(-1000);
        this.seenHashes = new Set(recent);
      }
    } catch {
      // Start fresh on error
      this.seenHashes = new Set();
    }
  }

  /**
   * Save dedup hashes to persistent file.
   */
  private saveDedupHashes(): void {
    try {
      const hashes = Array.from(this.seenHashes).slice(-1000);
      writeFileSync(this.dedupFilePath, hashes.join('\n') + '\n', 'utf-8');
    } catch {
      // Non-critical - dedup will still work in memory
    }
  }

  /**
   * Load circuit breaker state from disk.
   * Persisting this across --continue restarts is critical: without it,
   * the in-memory ctxCircuitRestarts array resets on every restart, making
   * the circuit breaker unable to count restarts and stop a restart loop.
   */
  private loadCtxCircuit(): void {
    try {
      if (!existsSync(this.ctxCircuitFile)) return;
      const data = JSON.parse(readFileSync(this.ctxCircuitFile, 'utf-8'));
      this.ctxCircuitRestarts = Array.isArray(data.restarts) ? data.restarts : [];
      this.ctxHandoffFires = Array.isArray(data.handoffFires) ? data.handoffFires : [];
      this.ctxCircuitBrokenAt = typeof data.brokenAt === 'number' ? data.brokenAt : null;
    } catch {
      // Start fresh on error
    }
  }

  /**
   * Persist circuit breaker state to disk after every update.
   */
  private saveCtxCircuit(): void {
    try {
      writeFileSync(this.ctxCircuitFile, JSON.stringify({
        restarts: this.ctxCircuitRestarts,
        handoffFires: this.ctxHandoffFires,
        brokenAt: this.ctxCircuitBrokenAt,
      }), 'utf-8');
    } catch {
      // Non-critical
    }
  }

  /**
   * Check if the agent is actively working on a response (typing indicator).
   *
   * Hook-based approach:
   *   - fast-checker records when it injected a message (lastMessageInjectedAt)
   *   - Stop hook writes a Unix timestamp to state/<agent>/last_idle.flag
   *   - Typing = message was injected AND last_idle.flag is older than injection
   *     AND injection was within the last 10 minutes
   *
   * This is accurate: typing starts when user sends a message, clears the
   * moment Claude finishes its turn (Stop fires). No false positives from TUI.
   */
  isAgentActive(): boolean {
    // Hook-based approach only. Claude Code writes ANSI escape codes (spinner,
    // cursor movement) to stdout constantly even when idle, so stdout.log always
    // grows — using file size as an activity signal produces a permanent "typing"
    // indicator. Instead, rely solely on:
    //   - lastMessageInjectedAt: when fast-checker last pushed a message in
    //   - last_idle.flag: written by the Stop hook when Claude finishes a turn
    // This gives accurate per-turn typing with no false positives.

    if (this.lastMessageInjectedAt === 0) return false;

    const now = Date.now();
    const tenMinMs = 10 * 60 * 1000;
    if (now - this.lastMessageInjectedAt > tenMinMs) return false;

    // Clear typing immediately when the agent sends a reply.
    // outbound-messages.jsonl grows each time the agent calls send-telegram.
    const outboundPath = join(this.paths.logDir, 'outbound-messages.jsonl');
    try {
      if (existsSync(outboundPath)) {
        const { size } = require('fs').statSync(outboundPath);
        if (this.outboundLogSize === 0) {
          // First check: seed baseline, don't trigger yet
          this.outboundLogSize = size;
        } else if (size > this.outboundLogSize) {
          // New reply sent — clear typing state
          this.outboundLogSize = size;
          this.lastMessageInjectedAt = 0;
          return false;
        }
      }
    } catch { /* non-critical */ }

    // Read last_idle.flag written by the Stop hook
    const flagPath = join(this.paths.stateDir, 'last_idle.flag');
    try {
      if (!existsSync(flagPath)) {
        // No idle flag yet — hook hasn't fired, so still working
        return true;
      }
      const idleTs = parseInt(readFileSync(flagPath, 'utf-8').trim(), 10) * 1000;
      // Typing if injection happened AFTER the last idle signal
      return this.lastMessageInjectedAt > idleTs;
    } catch {
      return true; // Can't read flag — assume still active
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
