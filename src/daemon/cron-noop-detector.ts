import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { homedir } from 'os';
import { join, sep } from 'path';
import type { AgentConfig, AgentStatus, CronExecutionLogEntry, CronFireKind } from '../types/index.js';
import { resolveClaudeProjectDir } from '../utils/claude-project-dir.js';

export const CRON_NOOP_VERIFY_DELAY_MS = 75_000;
export interface CronTranscriptLookup {
  found: boolean;
  path?: string;
}

interface CronSaltCandidate {
  salt: string;
  firedAt: string;
}

export function cronFireSalt(firedAt: string, cronName: string): string {
  return `[CRON FIRED ${firedAt}] ${cronName}:`;
}

export function resolveClaudeTranscriptPath(
  config: Pick<AgentConfig, 'working_directory'>,
  agentDir: string,
  homeDir: string = homedir(),
): string | null {
  const launchDir = config.working_directory || agentDir;
  if (!launchDir) return null;

  const convDir = join(
    homeDir,
    '.claude',
    'projects',
    launchDir.split(sep).join('-'),
  );

  try {
    const jsonlFiles = readdirSync(convDir)
      .filter((f) => f.endsWith('.jsonl'))
      .map((file) => {
        const path = join(convDir, file);
        return { path, mtimeMs: statSync(path).mtimeMs };
      })
      .sort((a, b) => b.mtimeMs - a.mtimeMs);
    return jsonlFiles[0]?.path ?? null;
  } catch {
    return null;
  }
}

function contentContainsSalt(content: unknown, salt: string): boolean {
  if (typeof content === 'string') return content.includes(salt);
  try {
    return JSON.stringify(content).includes(salt);
  } catch {
    return false;
  }
}

export function transcriptContainsCronTurn(
  transcriptPath: string | null,
  salt: string,
  firedAt: string,
): CronTranscriptLookup {
  return transcriptContainsAnyCronTurn(transcriptPath, [{ salt, firedAt }]);
}

function transcriptContainsAnyCronTurn(
  transcriptPath: string | null,
  candidates: CronSaltCandidate[],
): CronTranscriptLookup {
  if (!transcriptPath || !existsSync(transcriptPath)) return { found: false };

  const parsedCandidates = candidates
    .map((candidate) => ({
      ...candidate,
      firedMs: Date.parse(candidate.firedAt),
    }))
    .filter((candidate) => Number.isFinite(candidate.firedMs));
  if (parsedCandidates.length === 0) return { found: false, path: transcriptPath };

  try {
    const transcript = readFileSync(transcriptPath, 'utf-8');
    for (const line of transcript.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let row: any;
      try {
        row = JSON.parse(trimmed);
      } catch {
        continue;
      }
      if (row?.type !== 'user') continue;
      const tsMs = Date.parse(String(row.timestamp || ''));
      if (!Number.isFinite(tsMs)) continue;
      const matched = parsedCandidates.some((candidate) =>
        tsMs >= candidate.firedMs && contentContainsSalt(row?.message?.content, candidate.salt),
      );
      if (matched) {
        return { found: true, path: transcriptPath };
      }
    }
  } catch {
    return { found: false, path: transcriptPath };
  }

  return { found: false, path: transcriptPath };
}

type InjectResult =
  | { ok: true }
  | { ok: false; code: 'NOT_FOUND' | 'NOT_RUNNING' | 'DEDUPED' | 'ADMISSION_FAILED'; message: string };

interface PendingCronVerification {
  agentName: string;
  agentDir: string;
  config: AgentConfig;
  cronName: string;
  prompt: string;
  firedAt: string;
  fireKind: CronFireKind;
  salt: string;
  acceptedSalts: CronSaltCandidate[];
  window: 1 | 2;
  reinjects: number;
  timer?: NodeJS.Timeout;
}

export interface CronNoopDetectorOptions {
  verifyDelayMs?: number;
  appendExecutionLog: (agentName: string, entry: CronExecutionLogEntry) => void;
  emitEvent: (agentName: string, event: string, severity: 'info' | 'warning' | 'error', meta: Record<string, unknown>) => void;
  getStatus: (agentName: string) => AgentStatus | null;
  inject: (agentName: string, text: string) => InjectResult;
  notifyOrchestrator: (agentName: string, text: string) => void;
  hasActivitySince?: (agentName: string, firedAt: string) => boolean;
  logger?: (msg: string) => void;
  now?: () => Date;
  transcriptPathFor?: (agentDir: string, config: AgentConfig) => string | null;
}

export class CronNoopDetector {
  private readonly verifyDelayMs: number;
  private readonly pending = new Map<string, PendingCronVerification>();
  private readonly appendExecutionLog: CronNoopDetectorOptions['appendExecutionLog'];
  private readonly emitEvent: CronNoopDetectorOptions['emitEvent'];
  private readonly getStatus: CronNoopDetectorOptions['getStatus'];
  private readonly inject: CronNoopDetectorOptions['inject'];
  private readonly notifyOrchestrator: CronNoopDetectorOptions['notifyOrchestrator'];
  private readonly hasActivitySince: (agentName: string, firedAt: string) => boolean;
  private readonly logger: (msg: string) => void;
  private readonly now: () => Date;
  private readonly transcriptPathFor: (agentDir: string, config: AgentConfig) => string | null;

  constructor(options: CronNoopDetectorOptions) {
    this.verifyDelayMs = options.verifyDelayMs ?? CRON_NOOP_VERIFY_DELAY_MS;
    this.appendExecutionLog = options.appendExecutionLog;
    this.emitEvent = options.emitEvent;
    this.getStatus = options.getStatus;
    this.inject = options.inject;
    this.notifyOrchestrator = options.notifyOrchestrator;
    this.hasActivitySince = options.hasActivitySince ?? (() => false);
    this.logger = options.logger ?? (() => {});
    this.now = options.now ?? (() => new Date());
    this.transcriptPathFor = options.transcriptPathFor ?? ((agentDir, config) => resolveClaudeTranscriptPath(config, agentDir));
  }

  registerFire(input: {
    agentName: string;
    agentDir: string;
    config: AgentConfig;
    cronName: string;
    prompt: string;
    firedAt: string;
    fireKind?: CronFireKind;
  }): void {
    if (input.config.runtime === 'codex-app-server' || input.config.runtime === 'hermes') {
      return;
    }
    const salt = cronFireSalt(input.firedAt, input.cronName);
    this.schedule({
      agentName: input.agentName,
      agentDir: input.agentDir,
      config: input.config,
      cronName: input.cronName,
      prompt: input.prompt,
      firedAt: input.firedAt,
      fireKind: input.fireKind ?? 'scheduled',
      salt,
      acceptedSalts: [{ salt, firedAt: input.firedAt }],
      window: 1,
      reinjects: 0,
    });
  }

  private keyFor(pending: Pick<PendingCronVerification, 'agentName' | 'cronName' | 'firedAt' | 'reinjects'>): string {
    return `${pending.agentName}:${pending.cronName}:${pending.firedAt}:${pending.reinjects}`;
  }

  private schedule(pending: PendingCronVerification): void {
    const key = this.keyFor(pending);
    pending.timer = setTimeout(() => this.verify(key), this.verifyDelayMs);
    this.pending.set(key, pending);
  }

  cancelAgentVerifications(agentName: string): number {
    let cancelled = 0;
    for (const [key, pending] of this.pending.entries()) {
      if (pending.agentName !== agentName) continue;
      if (pending.timer) clearTimeout(pending.timer);
      this.pending.delete(key);
      cancelled += 1;
    }
    if (cancelled > 0) {
      this.logger(`[cron-noop-detector] cancelled ${cancelled} pending verification(s) for ${agentName}`);
    }
    return cancelled;
  }

  private verify(key: string): void {
    const pending = this.pending.get(key);
    if (!pending) return;

    try {
      const transcriptPath = this.transcriptPathFor(pending.agentDir, pending.config);
      const lookup = transcriptContainsAnyCronTurn(transcriptPath, pending.acceptedSalts);
      if (lookup.found) {
        this.appendExecutionLog(pending.agentName, {
          ts: this.now().toISOString(),
          cron: pending.cronName,
          status: 'confirmed',
          fire_kind: pending.fireKind,
          attempt: pending.window,
          duration_ms: 0,
          error: null,
        });
        this.pending.delete(key);
        return;
      }

      if (this.activityConfirmsCronFire(pending)) {
        this.appendExecutionLog(pending.agentName, {
          ts: this.now().toISOString(),
          cron: pending.cronName,
          status: 'confirmed',
          fire_kind: pending.fireKind,
          attempt: pending.window,
          duration_ms: 0,
          error: null,
        });
        this.emitEvent(pending.agentName, 'cron_fire_confirmed_by_activity', 'info', {
          agent: pending.agentName,
          cron: pending.cronName,
          fired_at: pending.firedAt,
          salt: pending.salt,
          transcript_path: lookup.path ?? transcriptPath ?? null,
          reinjects: pending.reinjects,
        });
        this.pending.delete(key);
        return;
      }

      if (pending.window === 1) {
        this.appendExecutionLog(pending.agentName, {
          ts: this.now().toISOString(),
          cron: pending.cronName,
          status: 'noop_unconfirmed',
          fire_kind: pending.fireKind,
          attempt: 1,
          duration_ms: 0,
          error: null,
        });
        this.emitEvent(pending.agentName, 'cron_fire_unconfirmed', 'info', {
          agent: pending.agentName,
          cron: pending.cronName,
          fired_at: pending.firedAt,
          salt: pending.salt,
          transcript_path: lookup.path ?? transcriptPath ?? null,
          reinjects: pending.reinjects,
        });
        this.pending.delete(key);
        this.schedule({ ...pending, window: 2, timer: undefined });
        return;
      }

      this.pending.delete(key);
      if (pending.reinjects === 0) {
        this.reinject(pending);
      } else {
        this.escalatePersistent(pending, lookup.path ?? transcriptPath ?? null);
      }
    } catch (err) {
      this.pending.delete(key);
      this.logger(`[cron-noop-detector] verification failed for ${pending.agentName}/${pending.cronName}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private activityConfirmsCronFire(pending: PendingCronVerification): boolean {
    try {
      return this.hasActivitySince(pending.agentName, pending.firedAt);
    } catch (err) {
      this.logger(`[cron-noop-detector] activity evidence check failed for ${pending.agentName}/${pending.cronName}: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  private reinject(pending: PendingCronVerification): void {
    const status = this.getStatus(pending.agentName)?.status;
    if (status !== 'running') {
      this.escalatePersistent(pending, null, `agent status ${status ?? 'unknown'}; re-inject skipped`);
      return;
    }

    const firedAt = this.now().toISOString();
    const salt = cronFireSalt(firedAt, pending.cronName);
    const injection = `[CRON FIRED ${firedAt}] ${pending.cronName}: ${pending.prompt}`;
    const result = this.inject(pending.agentName, injection);
    if (!result.ok) {
      this.escalatePersistent(pending, null, result.message);
      return;
    }

    const next: PendingCronVerification = {
      ...pending,
      firedAt,
      salt,
      acceptedSalts: [
        ...pending.acceptedSalts,
        { salt, firedAt },
      ],
      window: 1,
      reinjects: 1,
      timer: undefined,
    };
    this.appendExecutionLog(pending.agentName, {
      ts: this.now().toISOString(),
      cron: pending.cronName,
      status: 'noop_reinjected',
      fire_kind: pending.fireKind,
      attempt: 2,
      duration_ms: 0,
      error: null,
    });
    this.emitEvent(pending.agentName, 'cron_fire_reinjected', 'warning', {
      agent: pending.agentName,
      cron: pending.cronName,
      original_fired_at: pending.firedAt,
      reinjected_fired_at: firedAt,
      original_salt: pending.salt,
      reinjected_salt: next.salt,
    });
    this.schedule(next);
  }

  private escalatePersistent(pending: PendingCronVerification, transcriptPath: string | null, reason?: string): void {
    this.appendExecutionLog(pending.agentName, {
      ts: this.now().toISOString(),
      cron: pending.cronName,
      status: 'noop_persistent',
      fire_kind: pending.fireKind,
      attempt: pending.window,
      duration_ms: 0,
      error: reason ?? 'salted user turn absent after re-inject verification windows',
    });
    const meta = {
      agent: pending.agentName,
      cron: pending.cronName,
      fired_at: pending.firedAt,
      salt: pending.salt,
      transcript_path: transcriptPath,
      reason: reason ?? 'salted user turn absent after re-inject verification windows',
    };
    this.emitEvent(pending.agentName, 'cron_fire_noop_persistent', 'error', meta);
    this.notifyOrchestrator(
      pending.agentName,
      `Persistent cron fire no-op detected for ${pending.agentName}/${pending.cronName}. Salt was not found in the Claude transcript after detector verification and one safe re-inject. Reason: ${meta.reason}`,
    );
  }
}
