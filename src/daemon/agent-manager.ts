import { readdirSync, readFileSync, existsSync, mkdirSync, writeFileSync, unlinkSync } from 'fs';
import { join, relative } from 'path';
import type { AgentConfig, AgentStatus, CtxEnv, BusPaths, WorkerStatus, TelegramMessage, TeamMember } from '../types/index.js';
import { AgentProcess, type AgentInjectionOptions, type AgentInjectionResult } from './agent-process.js';
import { WorkerProcess } from './worker-process.js';
import { FastChecker } from './fast-checker.js';
import { SlackSocketListener } from './slack-socket-listener.js';
import { resolveSlackInboundMode } from './slack-inbound-mode.js';
import { CronScheduler, type CronFireContext } from './cron-scheduler.js';
import { syncCronsForAgent } from './cron-migration.js';
import { appendExecutionLog } from './cron-execution-log.js';
import { CronNoopDetector } from './cron-noop-detector.js';
import type { CronDefinition, CronFireKind } from '../types/index.js';
import { TelegramAPI } from '../telegram/api.js';
import { TelegramPoller } from '../telegram/poller.js';
import { resolvePaths } from '../utils/paths.js';
import { resolveEnv } from '../utils/env.js';
import { logEvent } from '../bus/event.js';
import { sendMessage } from '../bus/message.js';
import { recordInboundTelegram, cacheLastSent, logOutboundMessage, buildRecentHistory } from '../telegram/logging.js';
import { collectTelegramCommands, registerTelegramCommands } from '../bus/metrics.js';
import { stripControlChars } from '../utils/validate.js';
import { processMediaMessage } from '../telegram/media.js';
import { evaluateShift } from './shift.js';
import { stripBom } from '../utils/strip-bom.js';
import { normalizeAllowedUser } from './allowed-user.js';
import { confirmSupportAccessOnFirstContact } from '../cli/support-access-notify.js';
import {
  discoverSourceAgentCandidates,
  isAgentStartCandidate,
  loadSourceAgentConfig,
} from './agent-discovery.js';
import { resolveCodexCronRouting } from './cron-model-routing.js';
import { resolveSideRunRouting, resolveSideRunResolution, buildEscalationInjection, type ELIGIBLE } from './cron-side-run.js';
import {
  writePendingSlot,
  startSideRun,
  sweepSideRuns,
  clearObservedSlot,
  type SideRunPending,
} from './cron-side-run-runner.js';

type LogFn = (msg: string) => void;
type AgentStartOptions = { partOfFleetStart?: boolean };
type PendingRestartCause = 'post-crash' | 'in-flight-duplicate';
type PendingRestartEntry = {
  cause: PendingRestartCause;
  queuedAt: number;
};
type AgentRestartOptions = {
  partOfFleetStart?: boolean;
  fleetTotal?: number;
  fleetIndex?: number;
};
type FleetStartBatch = {
  expected: number;
  completed: Set<string>;
  online: Set<string>;
  notifyHandle: { api: TelegramAPI; chatId: string } | null;
  source: 'daemon-boot' | 'restart-all';
};

/**
 * Manages all agents in a cortextOS instance.
 */

/**
 * Does this cron declare an emergency class the agent has agreed to wake for?
 *
 * Exported so the no-reader-regression test can assert this function is what
 * consumes `off_shift_can_wake_for` — the field spent an unknown period declared
 * and unread, and the test exists so that can never silently recur.
 *
 * Matching is exact and case-insensitive on trimmed strings. Deliberately NOT
 * fuzzy: a near-miss must fail closed and suppress, because a cron that thinks
 * it is exempt and is not is worse than one that knows it is suppressed.
 */
export function cronWakesForEmergencyClass(
  cron: Pick<CronDefinition, 'emergency_class'>,
  agentConfig: Pick<AgentConfig, 'shift_schedule'>,
): boolean {
  const cls = cron.emergency_class;
  if (typeof cls !== 'string' || cls.trim() === '') return false;

  const allowed = agentConfig.shift_schedule?.emergency_override?.off_shift_can_wake_for;
  if (!Array.isArray(allowed) || allowed.length === 0) return false;

  const want = cls.trim().toLowerCase();
  return allowed.some((a) => typeof a === 'string' && a.trim().toLowerCase() === want);
}

export class AgentManager {
  private agents: Map<string, { process: AgentProcess; checker: FastChecker; poller?: TelegramPoller; activityPoller?: TelegramPoller; slackListener?: SlackSocketListener; telegramRejectCount?: number; telegramLastRejectAlertAt?: number }> = new Map();
  private workers: Map<string, WorkerProcess> = new Map();
  /** Daemon-level cron scheduler registry: one CronScheduler per enabled agent. */
  private cronSchedulers: Map<string, CronScheduler> = new Map();
  /** Post-fire verifier that confirms Claude cron prompts reached the REPL transcript. */
  private cronNoopDetector: CronNoopDetector;
  /**
   * Side-run eligibility registry. Undefined in production, where
   * resolveSideRunRouting falls back to the shipped ELIGIBLE list.
   *
   * Exists ONLY so the admission path can be driven by a test. The shipped
   * heartbeat rows pin the live agent skill file, which is symlinked runtime and
   * absent from the repo, so no CI-runnable test could reach the accept path
   * through here — which meant the copy of plan.continuationPrompt into the
   * pending slot had no coverage at all, and a mutation dropping it stayed green.
   *
   * Same seam, and the same reason, as ResolveSideRunInput.registry one layer
   * down: a gate whose accept path cannot be exercised is indistinguishable from
   * one that never opens.
   */
  private sideRunRegistry?: typeof ELIGIBLE;
  // Tracks agents that received a start request while still stopping.
  // stopAgent() honors these after cleanup completes so restart-all is race-free.
  private pendingRestarts: Map<string, PendingRestartEntry> = new Map();
  private inFlightRestarts: Set<string> = new Set();
  /** Names whose stale registry entries are being torn down before a fresh start. */
  private evictingAgents: Set<string> = new Set();
  private instanceId: string;
  private ctxRoot: string;
  private frameworkRoot: string;
  private org: string;
  private fleetStartBatch: FleetStartBatch | null = null;

  // Set true at construction time if any agent in state/ has a stale
  // .daemon-crashed marker, meaning the previous daemon process died
  // abruptly. Used by startAgent() to downgrade the BUG-011 regression
  // alarm to an info log in the post-crash overlap case (PR #11 only
  // closed the in-flight stop/start race; crash-restart can legitimately
  // see overlapping registry state). Cleared after discoverAndStart()
  // finishes so the next clean restart starts from a known-good baseline.
  private daemonJustCrashed: boolean = false;

  constructor(instanceId: string, ctxRoot: string, frameworkRoot: string, org: string) {
    this.instanceId = instanceId;
    this.ctxRoot = ctxRoot;
    this.frameworkRoot = frameworkRoot;
    this.org = org;
    this.daemonJustCrashed = this.detectDaemonCrashMarkers();
    if (this.daemonJustCrashed) {
      console.log('[agent-manager] Detected .daemon-crashed marker(s) — previous daemon exited abnormally. Will quiet BUG-011 alarm for this startup cycle.');
    }
    this.cronNoopDetector = new CronNoopDetector({
      appendExecutionLog,
      emitEvent: (agentName, event, severity, meta) => {
        try {
          const resolvedOrg = this.resolveAgentOrg(agentName);
          const paths = resolvePaths(agentName, this.instanceId, resolvedOrg);
          logEvent(paths, agentName, resolvedOrg || '', 'action', event, severity, meta);
        } catch (err) {
          console.log(`[cron-noop-detector] logEvent failed for ${agentName}/${event} (non-fatal): ${err}`);
        }
      },
      getStatus: (agentName) => this.getAgentStatus(agentName),
      inject: (agentName, text) => this.injectAgentDetailed(agentName, text),
      hasActivitySince: (agentName, firedAt) => this.hasPostCronActivity(agentName, firedAt),
      notifyOrchestrator: (agentName, text) => {
        try {
          const resolvedOrg = this.resolveAgentOrg(agentName);
          const orchestratorName = this.resolveOrgOrchestrator(resolvedOrg);
          if (!orchestratorName) {
            console.log(`[cron-noop-detector] no orchestrator configured for org ${resolvedOrg}; persistent no-op notice not sent`);
            return;
          }
          const paths = resolvePaths(agentName, this.instanceId, resolvedOrg);
          sendMessage(paths, 'daemon', orchestratorName, 'normal', text);
        } catch (err) {
          console.log(`[cron-noop-detector] orchestrator notify failed for ${agentName} (non-fatal): ${err}`);
        }
      },
      logger: (msg) => console.log(msg),
    });
  }

  private async handleAgentCronFire(
    agentName: string,
    cron: CronDefinition,
    context: CronFireContext,
  ): Promise<void> {
    const prompt = cron.prompt ?? `[cron] ${cron.name} fired`;

    // Shift gate (RFC your org internal docs §4).
    const suppression = this.evaluateCronShiftSuppression(agentName, cron);
    if (suppression) {
      console.log(`[daemon] cron suppressed off-shift for ${agentName}: ${cron.name} (mode=${suppression.mode})`);
      try {
        const resolvedOrg = this.resolveAgentOrg(agentName);
        const paths = resolvePaths(agentName, this.instanceId, resolvedOrg);
        logEvent(paths, agentName, resolvedOrg || '', 'action', 'cron_suppressed_off_shift', 'info', {
          agent: agentName,
          cron: cron.name,
          mode: suppression.mode,
          path: 'daemon_cron_fire',
        });
      } catch (err) {
        console.log(`[daemon] logEvent failed for cron-suppressed (non-fatal): ${err}`);
      }
      return;
    }

    const firedAt = context.firedAt;
    const injection = `[CRON FIRED ${firedAt}] ${cron.name}: ${prompt}`;
    const injected = this.injectCronAgent(agentName, cron, injection, firedAt);
    if (!injected) {
      throw new Error(`injectAgent returned false for agent "${agentName}" — agent may not be running`);
    }
    try {
      const entry = this.agents.get(agentName);
      const config = entry?.process.getConfig();
      if (entry && config) {
        this.cronNoopDetector.registerFire({
          agentName,
          agentDir: entry.process.getAgentDir(),
          config,
          cronName: cron.name,
          prompt,
          firedAt,
          fireKind: context.fireKind,
        });
      }
    } catch (err) {
      console.log(`[cron-noop-detector] register failed for ${agentName}/${cron.name} (non-fatal): ${err}`);
    }
  }

  /**
   * Scan state/<agent>/.daemon-crashed markers (written by daemon/index.ts:handleFatal).
   * Presence means the previous daemon process died via uncaughtException
   * or process.kill rather than a clean shutdown.
   */
  private detectDaemonCrashMarkers(): boolean {
    const stateBase = join(this.ctxRoot, 'state');
    if (!existsSync(stateBase)) return false;
    try {
      const dirs = readdirSync(stateBase, { withFileTypes: true })
        .filter(d => d.isDirectory())
        .map(d => d.name);
      return dirs.some(name => existsSync(join(stateBase, name, '.daemon-crashed')));
    } catch {
      return false;
    }
  }

  private pendingRestartCause(): PendingRestartCause {
    return this.daemonJustCrashed ? 'post-crash' : 'in-flight-duplicate';
  }

  private emitPendingRestartEvent(
    name: string,
    event: 'pending_restart_enqueued' | 'pending_restart_consumed' | 'pending_restart_cause_disagreement',
    phase: 'enqueue' | 'consume',
    entry: PendingRestartEntry,
    consumeDerivedCause: PendingRestartCause,
  ): void {
    const elapsedMs = Math.max(0, Date.now() - entry.queuedAt);
    try {
      const resolvedOrg = this.resolveAgentOrg(name);
      const paths = resolvePaths(name, this.instanceId, resolvedOrg);
      logEvent(
        paths,
        name,
        resolvedOrg || '',
        'action',
        event,
        event === 'pending_restart_cause_disagreement' ? 'warning' : 'info',
        {
          agent: name,
          phase,
          recorded_cause: entry.cause,
          consume_derived_cause: consumeDerivedCause,
          queued_at: entry.queuedAt,
          elapsed_ms: elapsedMs,
        },
      );
    } catch (err) {
      console.warn(`[agent-manager] Failed to emit ${event} for ${name} (non-fatal): ${err}`);
    }
  }

  /**
   * Delete .daemon-crashed markers after a successful discoverAndStart pass
   * AND clear the daemonJustCrashed flag. Once the initial post-crash
   * discovery has finished, any further startAgent calls — IPC-triggered
   * agent enables, dashboard restarts, manual restartAgent — represent
   * normal operation, not post-crash overlap. They should fire the real
   * BUG-011 alarm, not the quieted variant.
   *
   * Called once per daemon startup at the end of discoverAndStart().
   * Idempotent — if no markers exist, this is a no-op. Wrapped in
   * best-effort try/catch so a missing dir or permission error never
   * blocks daemon startup.
   */
  private clearDaemonCrashMarkers(): void {
    if (!this.daemonJustCrashed) return;
    const stateBase = join(this.ctxRoot, 'state');
    if (existsSync(stateBase)) {
      try {
        const dirs = readdirSync(stateBase, { withFileTypes: true })
          .filter(d => d.isDirectory())
          .map(d => d.name);
        for (const name of dirs) {
          try {
            const marker = join(stateBase, name, '.daemon-crashed');
            if (existsSync(marker)) unlinkSync(marker);
          } catch { /* per-agent best effort */ }
        }
      } catch { /* directory unreadable — leave markers, next clean startup will retry */ }
    }
    // Reset the flag so subsequent startAgent calls (IPC enable, dashboard
    // restart, manual restartAgent) get the real BUG-011 alarm, not the
    // quieted post-crash variant.
    this.daemonJustCrashed = false;
  }

  /**
   * Discover and start all enabled agents.
   */
  async discoverAndStart(): Promise<void> {
    const agentDirs = this.discoverAgents();
    const startCandidates: Array<{ name: string; dir: string; org: string; config: AgentConfig }> = [];

    // BUG-028: read instance-level enabled-agents.json so the daemon respects
    // the user's explicit enable/disable choices written by the CLI
    // (`cortextos enable`/`disable`) and the dashboard. Without this read, those
    // commands have no effect across daemon restarts — the daemon would
    // re-discover and re-start any agent dir on disk regardless of user intent.
    //
    // Zone C H4: re-read the registry per-iteration. Boot does serial spawns
    // and any IPC during boot can rewrite enabled-agents.json mid-pass. A
    // single up-front snapshot would let a just-disabled agent still start
    // (and a just-enabled agent stay dark) until the next daemon restart.
    for (const { name, dir, org, config } of agentDirs) {
      const instanceEnabled = this.readInstanceEnableList();
      const entry = instanceEnabled[name];
      if (!isAgentStartCandidate(config, entry)) {
        if (config.enabled === false) {
          console.log(`[agent-manager] Skipping disabled agent: ${name} (per-agent config.json)`);
        } else {
          console.log(`[agent-manager] Skipping disabled agent: ${name} (enabled-agents.json)`);
        }
        continue;
      }
      startCandidates.push({ name, dir, org, config });
    }

    this.beginFleetStartBatch(startCandidates.length, 'daemon-boot');
    for (const { name, dir, org, config } of startCandidates) {
      // BUG-043 fix: pass the per-agent org so startAgent can use it instead
      // of falling back to `this.org` (the daemon's startup org).
      // Catch per-agent failures so one broken agent doesn't abort the whole
      // boot. AgentProcess.start now re-throws on spawn failure (Zone C H2),
      // and startAgent re-throws after cleanup; we log + continue here so
      // the rest of the fleet still comes online.
      try {
        await this.startAgent(name, dir, config, org, { partOfFleetStart: true });
      } catch (err) {
        console.error(`[agent-manager] Failed to start ${name}: ${err}`);
      } finally {
        this.recordFleetStartAgent(name);
      }
    }
    this.finishFleetStartBatch(true);

    // Successful startup pass — clear .daemon-crashed markers from disk
    // AND clear the in-memory daemonJustCrashed flag. After this point,
    // any further startAgent() calls (IPC enable, dashboard restart, etc)
    // are normal operation and should fire the real BUG-011 alarm if a
    // race ever does leak through PR #11's protection.
    this.clearDaemonCrashMarkers();
  }

  private beginFleetStartBatch(expected: number, source: FleetStartBatch['source']): void {
    if (expected <= 0) return;
    if (this.fleetStartBatch) {
      console.warn(`[agent-manager] Fleet start batch already active (${this.fleetStartBatch.source}); keeping existing coordinator`);
      return;
    }
    this.fleetStartBatch = {
      expected,
      completed: new Set(),
      online: new Set(),
      notifyHandle: null,
      source,
    };
  }

  /**
   * Account for a fleet-restart member that the IPC gate REFUSED (e.g. DEDUPED because
   * a manual restart of that agent is already in flight).
   *
   * Without this, a refused member is never recorded: `restartAgent` is never called for
   * it, so `finishFleetStartBatch` strands at completed < expected and the stale
   * coordinator then suppresses the NEXT fleet batch via the already-active guard in
   * `beginFleetStartBatch`. Found in review of PR #183.
   *
   * Deliberately does NOT touch `inFlightRestarts` — the agent really is mid-restart and
   * its marker must survive — and does NOT dispatch, which is the whole point of the refusal.
   */
  recordFleetStartRejection(name: string, fleetTotal?: number): void {
    if (!this.fleetStartBatch) {
      // Without a real fleetTotal we cannot size a batch. Defaulting to 1 would create a
      // bogus single-member batch, immediately satisfy it, clear it, and then let the
      // FIRST GENUINE member open a second batch that strands one short — turning a
      // missing total into silent corruption. Refuse to guess; log instead.
      if (!fleetTotal || fleetTotal <= 0) {
        console.warn(`[agent-manager] refused fleet member ${name} not accounted: no active batch and no fleetTotal`);
        return;
      }
      this.beginFleetStartBatch(fleetTotal, 'restart-all');
    }
    this.recordFleetStartAgent(name);
    this.finishFleetStartBatch();
  }

  private captureFleetNotifyHandle(api: TelegramAPI, chatId: string): void {
    if (!this.fleetStartBatch || this.fleetStartBatch.notifyHandle) return;
    this.fleetStartBatch.notifyHandle = { api, chatId };
  }

  private recordFleetStartAgent(name: string): void {
    const batch = this.fleetStartBatch;
    if (!batch) return;
    batch.completed.add(name);
    if (this.getAgentStatus(name)?.status === 'running') {
      batch.online.add(name);
    } else {
      batch.online.delete(name);
    }
  }

  private finishFleetStartBatch(force = false): void {
    const batch = this.fleetStartBatch;
    if (!batch) return;
    if (!force && batch.completed.size < batch.expected) return;

    this.fleetStartBatch = null;
    const message = `Fleet back online (${batch.online.size}/${batch.expected} agents)`;
    if (!batch.notifyHandle) {
      console.warn(`[agent-manager] ${message}, but no Telegram handle was available for consolidated notification`);
      return;
    }

    try {
      batch.notifyHandle.api.sendMessage(batch.notifyHandle.chatId, message).then(() => {
        console.log(`[agent-manager] Telegram fleet back-online notification sent: ${message}`);
      }).catch((err: unknown) => {
        console.error(`[agent-manager] Fleet back-online notification failed: ${err instanceof Error ? err.message : String(err)}`);
      });
    } catch (err) {
      console.error(`[agent-manager] Fleet back-online notification failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Read the instance-level enabled-agents.json registry.
   * Returns an empty object if the file is missing or unreadable —
   * agents not present in the file default to enabled, matching the existing
   * default-on behavior of `discoverAndStart`.
   */
  private readInstanceEnableList(): Record<string, { enabled?: boolean; org?: string; status?: string }> {
    const enabledFile = join(this.ctxRoot, 'config', 'enabled-agents.json');
    if (!existsSync(enabledFile)) return {};
    try {
      const raw = JSON.parse(readFileSync(enabledFile, 'utf-8'));
      if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
        // Wrong-shaped JSON (e.g. an array, a number, null) is just as
        // dangerous as unparseable: every `instanceEnabled[name]` lookup
        // returns undefined and the registry effectively disappears. Treat
        // shape mismatch like a parse failure (Zone D H3).
        console.error(
          `[agent-manager] CRITICAL: enabled-agents.json parsed but not an object (${Array.isArray(raw) ? 'array' : typeof raw}). ` +
            `Falling back to default-enabled. Repair the file or restore a backup.`,
        );
        return {};
      }
      return raw as Record<string, { enabled?: boolean; org?: string; status?: string }>;
    } catch (err) {
      // Falling back to {} default-enables every on-disk agent dir, which
      // can resurrect explicitly-disabled agents after a partial / corrupt
      // write to enabled-agents.json. Surface this loudly so an operator
      // notices instead of silently re-spawning the fleet.
      console.error(
        `[agent-manager] CRITICAL: enabled-agents.json failed to parse (${err instanceof Error ? err.message : String(err)}). ` +
          `Falling back to default-enabled. Repair the file or restore a backup; otherwise explicitly disabled agents will start.`,
      );
      return {};
    }
  }

  /**
   * BUG-043 fix: resolve the canonical org for a given agent without
   * defaulting to the daemon's startup `this.org`.
   *
   * Resolution order:
   *   1. Explicit `org` argument (e.g. from `discoverAgents()` which knows
   *      which org a dir lives under)
   *   2. `enabled-agents.json[name].org` — set by `cortextos enable`/`add-agent`
   *   3. Filesystem scan: walk `frameworkRoot/orgs/*` looking for a dir
   *      named `name` — handles legacy enabled-agents.json entries that
   *      were written before the `org` field was added
   *   4. Legacy fallback: `this.org` (preserves single-org install behavior)
   *
   * Before this fix, all six `this.org` sites in `agent-manager.ts` would
   * short-circuit to the daemon's startup `CTX_ORG`, which silently broke
   * multi-org installs — agents in `lifeos` or `cointally` were invisible
   * to a daemon started with `CTX_ORG=testorg`.
   */
  private resolveAgentOrg(name: string, explicitOrg?: string): string {
    if (explicitOrg) return explicitOrg;

    const enabledAgents = this.readInstanceEnableList();
    const entry = enabledAgents[name];
    if (entry?.org) return entry.org;

    // Legacy fallback: scan all orgs on disk for a dir named `name`.
    // Handles enabled-agents.json entries missing the `org` field, or
    // agents that were created via raw filesystem operations.
    const orgsBase = join(this.frameworkRoot, 'orgs');
    if (existsSync(orgsBase)) {
      try {
        const orgs = readdirSync(orgsBase, { withFileTypes: true })
          .filter(d => d.isDirectory())
          .map(d => d.name);
        for (const org of orgs) {
          if (existsSync(join(orgsBase, org, 'agents', name))) {
            return org;
          }
        }
      } catch { /* ignore read errors */ }
    }

    // Ultimate fallback: daemon's startup org (single-org install behavior)
    return this.org;
  }

  private resolveOrgOrchestrator(org: string | undefined): string | null {
    if (!org) return null;
    try {
      const contextJson = readFileSync(join(this.frameworkRoot, 'orgs', org, 'context.json'), 'utf-8');
      const parsed = JSON.parse(contextJson);
      return typeof parsed.orchestrator === 'string' && parsed.orchestrator ? parsed.orchestrator : null;
    } catch {
      return null;
    }
  }

  private hasPostCronActivity(agentName: string, firedAt: string): boolean {
    const firedMs = Date.parse(firedAt);
    if (!Number.isFinite(firedMs)) return false;

    const resolvedOrg = this.resolveAgentOrg(agentName);
    const paths = resolvePaths(agentName, this.instanceId, resolvedOrg);
    return this.eventLogConfirmsActivity(paths.analyticsDir, agentName, firedMs);
  }

  private eventLogConfirmsActivity(analyticsDir: string, agentName: string, firedMs: number): boolean {
    const eventsDir = join(analyticsDir, 'events', agentName);
    if (!existsSync(eventsDir)) return false;

    const dates = new Set([
      new Date(firedMs).toISOString().slice(0, 10),
      new Date().toISOString().slice(0, 10),
    ]);

    for (const date of dates) {
      const eventPath = join(eventsDir, `${date}.jsonl`);
      if (!existsSync(eventPath)) continue;
      if (this.eventFileHasPostCronActivity(eventPath, firedMs)) return true;
    }
    return false;
  }

  private eventFileHasPostCronActivity(eventPath: string, firedMs: number): boolean {
    const detectorEvents = new Set([
      'cron_fire_unconfirmed',
      'cron_fire_reinjected',
      'cron_fire_noop_persistent',
      'cron_fire_confirmed_by_activity',
    ]);

    try {
      for (const line of readFileSync(eventPath, 'utf-8').split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        let event: any;
        try {
          event = JSON.parse(trimmed);
        } catch {
          continue;
        }

        if (detectorEvents.has(String(event.event || ''))) continue;
        const tsMs = Date.parse(String(event.timestamp || ''));
        if (!Number.isFinite(tsMs) || tsMs < firedMs) continue;

        if (event.category === 'heartbeat') {
          const status = String(event.metadata?.status || '');
          if (status.startsWith('[watchdog]')) continue;
        }

        return true;
      }
    } catch {
      return false;
    }

    return false;
  }

  /**
   * Start a specific agent.
   *
   * BUG-043 fix: accepts an optional `org` parameter and uses
   * `resolveAgentOrg()` to find the correct org for path/env lookups
   * instead of falling back to `this.org`. This makes the daemon
   * multi-org aware — an install with lifeos + cointally + testorg will
   * spawn each agent in its correct org dir regardless of what
   * `CTX_ORG` the daemon was started with.
   */
  /**
   * Synchronously classify a start/stop/restart request before dispatch.
   *
   * Lets the IPC handler distinguish DEDUPED (agent already in registry, so
   * a start is collapsing against an in-flight identical op — or a stop /
   * restart of an agent that was just removed) from NOT_FOUND (agent never
   * existed in the registry). The dedup logic in startAgent / stopAgent /
   * restartAgent is unchanged — this read-only check exists purely to give
   * the IPC layer enough info to set IPCResponse.code. See issue #346.
   */
  inspectAgentOp(op: 'start' | 'stop' | 'restart', name: string): { ok: true } | { ok: false; code: 'DEDUPED' | 'NOT_FOUND'; message: string } {
    const inRegistry = this.agents.has(name);
    if (op === 'start') {
      if (inRegistry && this.isAgentActuallyAlive(name)) {
        return { ok: false, code: 'DEDUPED', message: `start request for "${name}" deduped — agent already in registry (in-flight start or already running)` };
      }
      return { ok: true };
    }
    if (op === 'restart' && this.inFlightRestarts.has(name)) {
      return { ok: false, code: 'DEDUPED', message: `restart request for "${name}" deduped — restart already in flight` };
    }
    // stop / restart need the agent to be present
    if (!inRegistry) {
      return { ok: false, code: 'NOT_FOUND', message: `agent "${name}" not in registry — cannot ${op}` };
    }
    return { ok: true };
  }

  /** Registry membership is not liveness: AgentProcess reconciles its status with the OS pid. */
  private isAgentActuallyAlive(name: string): boolean {
    const entry = this.agents.get(name);
    if (!entry) return false;
    // Be conservative if a test double or future transitional entry cannot
    // report status: unknown custody must never be evicted as dead.
    if (typeof entry.process.getStatus !== 'function') return true;
    const { status } = entry.process.getStatus();
    return status === 'starting' || status === 'running';
  }

  async startAgent(name: string, agentDir: string, config?: AgentConfig, org?: string, options: AgentStartOptions = {}): Promise<void> {
    if (this.agents.has(name)) {
      const mapped = this.agents.get(name)!;
      const mappedStatus = typeof mapped.process.getStatus === 'function'
        ? mapped.process.getStatus().status
        : undefined;
      // A delayed start is already the canonical registered admission. A
      // duplicate start must collapse completely, not leave a latent queued
      // restart that can fire during a later lifecycle operation.
      if (mappedStatus === 'starting') {
        console.log(`[agent-manager] ${name} start already in flight — deduping without queued restart.`);
        return;
      }

      // BUG-031: this branch was the workaround for the BUG-011 PTY race
      // (restart-all could send stop+start simultaneously, and the new
      // start would arrive while the old stop's PTY exit was still in
      // flight). PR #11 closed BUG-011 by making `AgentProcess.stop()`
      // await the actual PTY exit before resolving — which means this
      // branch should NEVER fire under normal restart paths.
      //
      // We log a regression warning here instead of deleting the branch
      // entirely, so we'll know IMMEDIATELY if BUG-011 ever regresses
      // (a future change accidentally breaks the exit-await). Phase 4 of
      // the core stability test plan + cycle 2 of PR #13 both confirmed
      // this branch is dormant. Once we have weeks of zero-warning
      // production data, we can delete the queue mechanism entirely.
      if (this.isAgentActuallyAlive(name)) {
        if (this.daemonJustCrashed) {
          console.log(`[agent-manager] ${name} already in registry (post-crash discovery overlap, expected). Queueing restart.`);
        } else {
          console.warn(`[agent-manager] BUG-011 REGRESSION CHECK: ${name} still in registry during startAgent — pendingRestarts queueing engaged. This should not happen with PR #11 in place.`);
        }
        const consumeDerivedCause = this.pendingRestartCause();
        const entry = this.pendingRestarts.get(name) ?? {
          cause: consumeDerivedCause,
          queuedAt: Date.now(),
        };
        this.pendingRestarts.set(name, entry);
        this.emitPendingRestartEvent(
          name,
          'pending_restart_enqueued',
          'enqueue',
          entry,
          consumeDerivedCause,
        );
        if (entry.cause !== consumeDerivedCause) {
          this.emitPendingRestartEvent(
            name,
            'pending_restart_cause_disagreement',
            'enqueue',
            entry,
            consumeDerivedCause,
          );
        }
        return;
      }

      if (this.evictingAgents.has(name)) {
        console.log(`[agent-manager] ${name} stale-entry eviction already in flight — skipping duplicate start.`);
        return;
      }

      this.evictingAgents.add(name);
      try {
        const stale = this.agents.get(name)!;
        console.log(`[agent-manager] ${name} is mapped but not alive — evicting stale entry before restart.`);
        try { stale.poller?.stop(); } catch { /* best effort */ }
        try { stale.activityPoller?.stop(); } catch { /* best effort */ }
        try { stale.slackListener?.stop(); } catch { /* best effort */ }
        this.cronNoopDetector.cancelAgentVerifications(name);
        try { stale.checker.stop(); } catch { /* best effort */ }
        try { await stale.process.stop(); } catch { /* best effort */ }
        if (this.agents.get(name) === stale) this.agents.delete(name);
        this.pendingRestarts.delete(name);
        const scheduler = this.cronSchedulers.get(name);
        if (scheduler) {
          scheduler.stop();
          this.cronSchedulers.delete(name);
        }
      } finally {
        this.evictingAgents.delete(name);
      }
    }

    // BUG-043 fix: resolve the agent's true org instead of using `this.org`.
    const resolvedOrg = this.resolveAgentOrg(name, org);

    // Auto-discover agent directory if not provided (e.g. when started via IPC)
    if (!agentDir || !existsSync(agentDir)) {
      const discovered = join(this.frameworkRoot, 'orgs', resolvedOrg, 'agents', name);
      if (existsSync(discovered)) {
        agentDir = discovered;
      } else {
        console.error(`[agent-manager] Agent directory not found for ${name}: tried ${discovered}`);
        return;
      }
    }

    if (!config) {
      config = loadSourceAgentConfig(agentDir);
    }

    const env: CtxEnv = {
      instanceId: this.instanceId,
      ctxRoot: this.ctxRoot,
      frameworkRoot: this.frameworkRoot,
      agentName: name,
      agentDir,
      org: resolvedOrg,
      projectRoot: this.frameworkRoot,
    };

    const paths = resolvePaths(name, this.instanceId, resolvedOrg);

    const log = (msg: string) => {
      console.log(`[${name}] ${msg}`);
    };

    // Read agent .env for Telegram credentials
    const agentEnvFile = join(agentDir, '.env');
    let telegramApi: TelegramAPI | undefined;
    let chatId: string | undefined;
    let allowedUserId: string | undefined;
    let botToken: string | undefined;

    if (existsSync(agentEnvFile)) {
      // stripBom: Windows tooling writes .env with a UTF-8 BOM that breaks
      // /^BOT_TOKEN=/m when BOT_TOKEN is on line 1 (2026-05-16 silent
      // smith-not-receiving-Telegram incident). See src/utils/strip-bom.ts.
      const envContent = stripBom(readFileSync(agentEnvFile, 'utf-8'));
      const botTokenMatch = envContent.match(/^BOT_TOKEN=(.+)$/m);
      const chatIdMatch = envContent.match(/^CHAT_ID=(.+)$/m);
      const allowedUserMatch = envContent.match(/^ALLOWED_USER=(.+)$/m);
      botToken = botTokenMatch?.[1]?.trim();
      chatId = chatIdMatch?.[1]?.trim();
      allowedUserId = allowedUserMatch?.[1]?.trim() || undefined;

      // Validate BOT_TOKEN format: must be numeric_id:alphanumeric_secret
      if (botToken && !/^\d+:[A-Za-z0-9_-]+$/.test(botToken)) {
        log(`WARNING: BOT_TOKEN format invalid (expected: 123456:ABC...). Telegram will not start.`);
        botToken = undefined;
      }

      // ALLOWED_USER must be one or more numeric Telegram user IDs.
      // Comma-separated for multi-user (e.g. group chats with Sam + a collaborator).
      // Whitespace tolerated; any non-numeric token rejects the whole list.
      if (allowedUserId) {
        const normalizedAllowedUser = normalizeAllowedUser(allowedUserId);
        if (!normalizedAllowedUser) {
          log(`SECURITY: ALLOWED_USER must be a comma-separated list of numeric Telegram user IDs (e.g. 123456789,987654321). Refusing to enable Telegram. Fix the .env file.`);
          allowedUserId = undefined;
        } else {
          // Normalize to comma-joined form so downstream gate splits on it
          allowedUserId = normalizedAllowedUser;
        }
      }

      // Security: ALLOWED_USER is REQUIRED when BOT_TOKEN is set. Without it,
      // ANY Telegram user who finds the bot @handle could control the agent.
      // Fail closed: refuse to start Telegram unless the operator explicitly
      // whitelists their numeric user ID.
      if (botToken && !allowedUserId) {
        log(`SECURITY: BOT_TOKEN is set but ALLOWED_USER is missing. Refusing to enable Telegram. Set ALLOWED_USER to your numeric Telegram user ID in .env, or remove BOT_TOKEN to start the agent without Telegram.`);
        if (chatId) {
          const alertApi = new TelegramAPI(botToken);
          alertApi.sendMessage(chatId,
            `⚠️ WATCHDOG: ${name} has BOT_TOKEN but ALLOWED_USER is missing or malformed in .env. Telegram is DISABLED for this agent. Fix ALLOWED_USER and restart.`,
          ).catch(() => {});
        }
        botToken = undefined;
      }

      if (botToken && chatId) {
        telegramApi = new TelegramAPI(botToken);
        // Don't log sensitive user IDs — just indicate the gate is enabled
        log(`Telegram configured (chat_id: ****${String(chatId).slice(-4)}, allowed_user: enabled)`);
      }
    }

    const agentProcess = new AgentProcess(name, env, config, log);

    // Issue #330: pass the Telegram handle into AgentProcess so CodexAppServerPTY
    // can emit sendChatAction directly from the JSONL stream. Has no effect for
    // claude-code / hermes runtimes — those still use fast-checker.
    if (telegramApi && chatId) {
      agentProcess.setTelegramHandle(telegramApi, chatId);
      if (options.partOfFleetStart) {
        this.captureFleetNotifyHandle(telegramApi, chatId);
      }
    }

    // Build gmail_watch option if configured
    const gmailWatchOption = config.gmail_watch?.query
      ? {
          query: config.gmail_watch.query,
          intervalMs: config.gmail_watch.interval_ms ?? 15 * 60 * 1000,
          processedLabelId: config.gmail_watch.processed_label_id,
        }
      : undefined;

    // Slack inbound: prefer Socket Mode (real-time WSS) when an app-level token
    // (xapp-) is present; otherwise fall back to the legacy 60s poll. Tokens are
    // secrets and live in .env (parity with SLACK_BOT_TOKEN), not in config.json.
    let slackWatchOption:
      | {
          channel: string;
          intervalMs: number;
          token: string;
          trustedSlackUsers?: string[];
          teamMembers?: TeamMember[];
        }
      | undefined;
    let slackSocketConfig: { channel: string; botToken: string; appToken: string } | undefined;
    if (config.slack_watch?.channel) {
      let slackBotToken = '';
      let slackAppToken = '';
      const agentEnvPath = join(env.agentDir, '.env');
      if (existsSync(agentEnvPath)) {
        const envContent = readFileSync(agentEnvPath, 'utf-8');
        const botMatch = envContent.match(/^SLACK_BOT_TOKEN=(.+)$/m);
        if (botMatch?.[1]?.trim()) slackBotToken = botMatch[1].trim();
        const appMatch = envContent.match(/^SLACK_APP_TOKEN=(.+)$/m);
        if (appMatch?.[1]?.trim()) slackAppToken = appMatch[1].trim();
      }
      if (!slackBotToken) slackBotToken = process.env.SLACK_BOT_TOKEN ?? '';
      if (!slackAppToken) slackAppToken = process.env.SLACK_APP_TOKEN ?? '';

      // Socket Mode is primary ONLY when native WebSocket is available (Node 22+);
      // otherwise the poll stays live as the fallback so there is never a silent
      // no-inbound gap (Socket can't run on Node 20/21 even with both tokens).
      const decision = resolveSlackInboundMode({
        botToken: slackBotToken,
        appToken: slackAppToken,
        channel: config.slack_watch.channel,
        intervalMs: config.slack_watch.interval_ms ?? 60_000,
        webSocketAvailable: typeof WebSocket !== 'undefined',
      });
      if (decision.mode === 'socket') {
        // Poll stays dormant (slackWatchOption unset -> checkSlackWatch early-returns).
        slackSocketConfig = {
          channel: decision.channel,
          botToken: decision.botToken,
          appToken: decision.appToken,
        };
      } else if (decision.mode === 'poll') {
        if (decision.reason) log(`Slack inbound: ${decision.reason}`);
        slackWatchOption = {
          channel: decision.channel,
          intervalMs: decision.intervalMs,
          token: decision.botToken,
          trustedSlackUsers: config.trusted_slack_users,
          teamMembers: config.team_members,
        };
      } else {
        log(`Slack watch configured but ${decision.reason} in .env — skipping`);
      }
    }

    const checker = new FastChecker(agentProcess, paths, this.frameworkRoot, {
      log,
      telegramApi,
      chatId,
      // FastChecker only needs the first ID for its single-recipient typing
      // indicator / quick-checks. Callback authorization needs the full
      // normalized list because callbacks route through FastChecker.
      allowedUserId: allowedUserId ? parseInt(allowedUserId.split(',')[0].trim(), 10) : undefined,
      allowedUserIds: allowedUserId ? allowedUserId.split(',').map((s) => parseInt(s.trim(), 10)) : undefined,
      gmailWatch: gmailWatchOption,
      slackWatch: slackWatchOption,
      ctxRestartThreshold: config.ctx_restart_threshold,
      turnWatchdogThresholdMinutes: config.turn_watchdog_threshold_minutes,
    });

    // Reset watchdog session state on actual transitions back to running.
    let prevStatusForReset: string | null = null;
    agentProcess.onStatusChanged((status) => {
      // Cancel any in-flight cron no-op verifications when the agent leaves running.
      if (status.status !== 'running') {
        this.cronNoopDetector.cancelAgentVerifications(name);
      }
      if (status.status === 'running' && prevStatusForReset !== 'running') {
        checker.resetWatchdogState();
      }
      if (telegramApi && chatId) {
        const tgApi = telegramApi;
        const tgChatId = chatId;
        // Log Telegram delivery failures instead of silently swallowing them
        // — these alerts are the operator's only out-of-band signal during a
        // crash loop, so a dropped send must at least leave a daemon-log
        // trace (Zone D M1).
        const logSendFail = (kind: string) => (err: unknown) => {
          log(`Telegram ${kind} alert for ${name} failed: ${err instanceof Error ? err.message : String(err)}`);
        };
        if (status.status === 'crashed') {
          const crashNum = status.crashCount ?? '?';
          tgApi.sendMessage(tgChatId, `Agent ${name} crashed (crash #${crashNum}) — auto-restarting`).catch(logSendFail('crash'));
        } else if (status.status === 'halted') {
          tgApi.sendMessage(tgChatId, `Agent ${name} HALTED — exceeded crash limit. Restart manually with: cortextos start ${name}`).catch(logSendFail('halt'));
        } else if (status.status === 'running' && prevStatusForReset === 'crashed') {
          tgApi.sendMessage(tgChatId, `Agent ${name} recovered and is back online`).then(() => {
            log(`Telegram recovery back-online alert for ${name} sent successfully`);
          }).catch(logSendFail('recovery'));
        }
      }
      prevStatusForReset = status.status;
    });

    const entry = { process: agentProcess, checker };
    this.agents.set(name, entry);

    // Start agent. If start() throws, AgentProcess has already flipped status
    // to 'crashed' (it now re-throws so callers can react). Tear down the
    // map entry before re-throwing so we don't leave a half-registered
    // zombie that blocks future startAgent() retries.
    try {
      await agentProcess.start({ partOfFleetStart: options.partOfFleetStart });
    } catch (err) {
      // Only delete if we are still the canonical entry — a concurrent
      // stop+start could have replaced the map entry while we were awaiting.
      if (this.agents.get(name) === entry) {
        this.agents.delete(name);
      }
      throw err;
    }

    // H3 (Zone C): stop-during-start race. If `cortextos stop X` lands while
    // we were awaiting `start()`, the entry was replaced or removed; do not
    // wire secondary resources against a process the operator already asked
    // to kill. Identity check on the map entry is the cheapest generation
    // token — sufficient because each startAgent call mints a fresh entry.
    if (this.agents.get(name) !== entry) {
      log(`agent ${name} entry was replaced/removed mid-start — aborting secondary wiring`);
      return;
    }

    // Belt-and-suspenders: if start() resolved but status didn't reach
    // 'running' (e.g. an exit fired during spawn — see codex exec-per-turn
    // race in agent-process.ts), abort secondary wiring. The crashed
    // process will be auto-recovered through handleExit; we just don't
    // want to wire crons/fast-checker/Telegram against it in this turn.
    const startedStatus = agentProcess.getStatus().status;
    if (startedStatus !== 'running') {
      log(`agent ${name} did not reach running (status=${startedStatus}) — skipping cron+checker+telegram wiring this cycle`);
      return;
    }

    // Sync crons from config.json → crons.json before starting the scheduler,
    // so the scheduler always has a populated, up-to-date crons.json to read.
    // First boot: one-shot migration (marker-gated, unchanged semantics).
    // Every later boot: merge-aware reconcile so crons added to config.json
    // AFTER the first migration reach the live scheduler (cron-sync gap fix).
    // Runtime metadata (fire_count, last_fired_at) and live-only orphan crons
    // are preserved; missing/corrupt config.json is a logged no-op.
    const configJsonPath = join(agentDir, 'config.json');
    try {
      syncCronsForAgent(name, configJsonPath, this.ctxRoot, {
        log: (msg) => log(`[migration] ${msg}`),
      });
    } catch (err) {
      // Never let a cron-sync failure abort agent startup — the scheduler
      // below still starts from whatever crons.json currently holds.
      log(`[migration] cron sync failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
    }

    // If a scheduler was lazy-wired during the start-window gap (see
    // reloadCrons), make it re-read the just-reconciled crons.json. In the
    // normal path no scheduler exists yet and startAgentCronScheduler below
    // reads the merged file fresh.
    this.cronSchedulers.get(name)?.reload();

    // Wire daemon-level CronScheduler for this agent.
    // The scheduler reads crons.json, fires crons, and injects prompts into
    // the agent PTY via injectAgent().  This is the Phase 2 daemon-managed
    // external cron system — agents no longer need to call CronCreate on boot.
    this.startAgentCronScheduler(name);

    // Start fast checker in background
    checker.start().catch(err => {
      console.error(`[${name}] Fast checker error:`, err);
    });

    // Start Slack Socket Mode listener (real-time inbound) if an app token is
    // configured. Stored on the registry entry so stopAgent() closes the WSS
    // cleanly. When active, the legacy poll is dormant (slackWatchOption unset).
    if (slackSocketConfig) {
      const slackListener = new SlackSocketListener({
        appToken: slackSocketConfig.appToken,
        botToken: slackSocketConfig.botToken,
        channel: slackSocketConfig.channel,
        agentName: name,
        paths,
        log,
        trustedSlackUsers: config.trusted_slack_users,
        teamMembers: config.team_members,
        // PERMANENT auth failure (invalid/revoked app token): the socket client
        // has STOPPED reconnecting — this never self-heals, so alert the
        // operator directly over Telegram (same mechanism as the ALLOWED_USER
        // reject watchdog above) instead of letting a dead Slack token hide in
        // scrolling logs. The listener also writes an urgent agent-inbox
        // message; this is the daemon-level belt-and-suspenders surface.
        onFatalAuthError: (errorCode) => {
          const alertText = `⚠️ SLACK AUTH DEAD: ${name}'s Slack connection hit a permanent auth failure (${errorCode}). Reconnection stopped — real-time Slack inbound is DOWN and will NOT recover on its own. Fix the Slack app token in the agent's .env and restart the agent.`;
          log(alertText);
          if (telegramApi && chatId) {
            telegramApi.sendMessage(chatId, alertText).catch(() => {
              /* alert is best-effort; the urgent inbox message + log remain */
            });
          }
        },
      });
      slackListener.start().catch(err => {
        log(`Slack Socket Mode listener failed to start: ${err}`);
      });
      const slackEntry = this.agents.get(name);
      if (slackEntry) slackEntry.slackListener = slackListener;
    }

    // Register Telegram slash commands at startup (fix for issue #1)
    if (telegramApi && botToken) {
      const scanDirs = [agentDir, this.frameworkRoot].filter(Boolean);
      const commands = collectTelegramCommands(scanDirs);
      registerTelegramCommands(botToken, commands).then((result) => {
        if (result.status === 'ok') {
          log(`Telegram commands registered (${result.count} commands)`);
        } else if (result.status !== 'empty') {
          // Surface failures instead of swallowing them silently: a failed
          // registration means the agent's slash menu is missing until the next
          // restart, so operators need to see it (non-fatal to agent startup).
          log(`Telegram command registration failed after retries: ${result.error}`);
        }
      }).catch((err) => {
        log(`Telegram command registration error: ${String(err)}`);
      });
    }

    // Start Telegram poller if credentials are available and not explicitly disabled.
    // Set telegram_polling: false in config.json to prevent a specialist agent from
    // running its own poller (only the designated orchestrator agent should poll).
    if (telegramApi && chatId && config.telegram_polling !== false) {
      const stateDir = join(this.ctxRoot, 'state', name);
      const poller = new TelegramPoller(telegramApi, stateDir);

      const REJECT_ALERT_THRESHOLD = 3;
      const REJECT_ALERT_COOLDOWN_MS = 30 * 60 * 1000;

      poller.onMessage((msg) => {
        // ALLOWED_USER gate: comma-separated list of numeric user IDs.
        // If configured, ignore messages from other users. Always log the
        // rejected user_id + name so operators can discover IDs to whitelist.
        if (allowedUserId) {
          const allowedIds = allowedUserId.split(',').map((s) => parseInt(s.trim(), 10));
          const fromId = msg.from?.id;
          if (typeof fromId !== 'number' || !allowedIds.includes(fromId)) {
            const rejectedFrom = msg.from?.first_name || msg.from?.username || 'unknown';
            log(`Ignoring message from unauthorized user (allowed_user gate): from=${fromId} (${rejectedFrom})`);
            // #459 reject-count watchdog: alert after N consecutive rejects (multi-user gate from #467 preserved).
            const entry = this.agents.get(name);
            if (entry) {
              entry.telegramRejectCount = (entry.telegramRejectCount ?? 0) + 1;
              if (entry.telegramRejectCount >= REJECT_ALERT_THRESHOLD) {
                const now = Date.now();
                const lastAlert = entry.telegramLastRejectAlertAt ?? 0;
                if (now - lastAlert > REJECT_ALERT_COOLDOWN_MS) {
                  entry.telegramLastRejectAlertAt = now;
                  const alertText = `⚠️ WATCHDOG: ${name} rejected ${entry.telegramRejectCount} consecutive Telegram messages (ALLOWED_USER gate). Last from_id: ${fromId ?? 'unknown'}. Verify ALLOWED_USER in .env matches expected users, or this may be unsolicited contact.`;
                  log(alertText);
                  if (telegramApi && chatId) {
                    telegramApi.sendMessage(chatId, alertText).catch(() => {});
                  }
                }
              }
            }
            return;
          }
        }

        // Message passed ALLOWED_USER gate — reset rejection counter.
        const agentEntry = this.agents.get(name);
        if (agentEntry) agentEntry.telegramRejectCount = 0;

        confirmSupportAccessOnFirstContact({
          agentEnvPath: agentEnvFile,
          ctxRoot: this.ctxRoot,
          api: telegramApi,
          fromId: msg.from?.id,
          log,
        }).catch((err) => {
          log(`Support access live-confirmation failed: ${err instanceof Error ? err.message : String(err)}`);
        });

        const from = stripControlChars(msg.from?.first_name || msg.from?.username || 'Unknown');
        const msgChatId = msg.chat?.id;
        const effectiveChatId = msgChatId ?? chatId ?? '';
        const stateDir = join(this.ctxRoot, 'state', name);

        // Persist the inbound message to JSONL AND emit a
        // `message/telegram_received` bus event in one helper so
        // experiment cycles and dashboards can count inbound traffic.
        // Without the event, Rubi's v3 fleet measurement found 0
        // inbound messages on a window where Eros replied to multiple
        // agents — the JSONL had the data but it never reached the
        // event log.
        recordInboundTelegram(paths, this.ctxRoot, name, resolvedOrg, from, msg, log);

        // Check for media messages (photo, document, voice, audio, video, video_note)
        const isMedia = !!(msg.photo || msg.document || msg.voice || msg.audio || msg.video || msg.video_note);
        const replyToText = buildReplyContext(msg.reply_to_message);

        if (isMedia && telegramApi) {
          const downloadDir = join(agentDir, 'telegram-images');
          processMediaMessage(msg, telegramApi, downloadDir).then((media) => {
            if (!media) {
              log('Media processing returned null - falling back to text format');
              const text = stripControlChars(msg.caption || '');
              const formatted = FastChecker.formatTelegramTextMessage(from, effectiveChatId, text, this.frameworkRoot, replyToText);
              if (!checker.isDuplicate(formatted)) checker.queueTelegramMessage(formatted);
              return;
            }

            // BUG-046: Convert absolute paths to relative (from agent working dir).
            // Claude Code strips absolute paths from pasted user input, so the
            // agent never sees them. Relative paths survive injection.
            // BUG-049: Use the agent's actual launch cwd (config.working_directory
            // if set, else agentDir) so the path resolves when Read() is invoked.
            const launchDir = config?.working_directory || agentDir;
            const toRel = (p: string | undefined) => p ? relative(launchDir, p) : '';
            const relImagePath = toRel(media.image_path);
            const relFilePath = toRel(media.file_path);

            log(`[DEBUG] media.type=${media.type} image_path=${JSON.stringify(relImagePath)} file_path=${JSON.stringify(relFilePath)}`);
            let formatted: string;
            if (media.type === 'photo') {
              formatted = FastChecker.formatTelegramPhotoMessage(from, effectiveChatId, media.text, relImagePath, replyToText);
            } else if (media.type === 'document') {
              formatted = FastChecker.formatTelegramDocumentMessage(from, effectiveChatId, media.text, relFilePath, media.file_name!, replyToText);
            } else if (media.type === 'voice' || media.type === 'audio') {
              formatted = FastChecker.formatTelegramVoiceMessage(from, effectiveChatId, relFilePath, media.duration, media.transcript, replyToText);
            } else {
              // video or video_note
              formatted = FastChecker.formatTelegramVideoMessage(from, effectiveChatId, media.text, relFilePath, media.file_name || '', media.duration, replyToText);
            }

            if (checker.isDuplicate(formatted)) {
              log('Duplicate Telegram media message suppressed');
              return;
            }
            log(`Media message received: type=${media.type}, path=${media.image_path || media.file_path}`);
            checker.queueTelegramMessage(formatted);
          }).catch((err) => {
            log(`Media processing error: ${err} - falling back to text format`);
            const text = stripControlChars(msg.caption || '');
            const formatted = FastChecker.formatTelegramTextMessage(from, effectiveChatId, text, this.frameworkRoot, replyToText);
            if (!checker.isDuplicate(formatted)) checker.queueTelegramMessage(formatted);
          });
          return;
        }

        // Text message (non-media)
        const text = stripControlChars(msg.text || '');
        const lastSent = FastChecker.readLastSent(stateDir, effectiveChatId);

        const recentHistory = buildRecentHistory(this.ctxRoot, name, effectiveChatId, 6) ?? undefined;
        const formatted = FastChecker.formatTelegramTextMessage(
          from,
          effectiveChatId,
          text,
          this.frameworkRoot,
          replyToText,
          lastSent ?? undefined,
          recentHistory,
        );

        if (checker.isDuplicate(formatted)) {
          log('Duplicate Telegram message suppressed');
          return;
        }
        checker.queueTelegramMessage(formatted);
      });

      poller.onCallback((query) => {
        // Route to fast-checker for hook response handling (perm_allow/deny, askopt, etc.)
        // handleCallback writes hook-response files and edits Telegram messages
        checker.handleCallback(query).catch(err => {
          log(`Callback handling error: ${err}`);
        });
      });

      poller.onReaction((reaction) => {
        // ALLOWED_USER gate: same multi-user rule as message handler.
        if (allowedUserId) {
          const allowedIds = allowedUserId.split(',').map((s) => parseInt(s.trim(), 10));
          const fromId = reaction.user?.id;
          if (typeof fromId !== 'number' || !allowedIds.includes(fromId)) {
            log(`Ignoring reaction from unauthorized user (allowed_user gate): from=${fromId}`);
            // #459 reject-count watchdog (multi-user gate from #467 preserved).
            const entry = this.agents.get(name);
            if (entry) {
              entry.telegramRejectCount = (entry.telegramRejectCount ?? 0) + 1;
              if (entry.telegramRejectCount >= REJECT_ALERT_THRESHOLD) {
                const now = Date.now();
                const lastAlert = entry.telegramLastRejectAlertAt ?? 0;
                if (now - lastAlert > REJECT_ALERT_COOLDOWN_MS) {
                  entry.telegramLastRejectAlertAt = now;
                  const alertText = `⚠️ WATCHDOG: ${name} rejected ${entry.telegramRejectCount} consecutive Telegram interactions (ALLOWED_USER gate). Verify ALLOWED_USER in .env matches expected users, or this may be unsolicited contact.`;
                  log(alertText);
                  if (telegramApi && chatId) {
                    telegramApi.sendMessage(chatId, alertText).catch(() => {});
                  }
                }
              }
            }
            return;
          }
        }

        const agentEntry = this.agents.get(name);
        if (agentEntry) agentEntry.telegramRejectCount = 0;

        const from = stripControlChars(reaction.user?.first_name || reaction.user?.username || 'Unknown');
        const reactionChatId = reaction.chat?.id ?? chatId ?? '';
        const formatted = FastChecker.formatTelegramReaction(
          from,
          reactionChatId,
          reaction.message_id,
          reaction.old_reaction ?? [],
          reaction.new_reaction ?? [],
        );
        if (checker.isDuplicate(formatted)) {
          log('Duplicate Telegram reaction suppressed');
          return;
        }
        checker.queueTelegramMessage(formatted);
      });

      // Wrap poller.start() in a restart-on-Conflict loop. The poller's
      // internal Conflict-self-die (see TelegramPoller.start) yields the
      // Telegram getUpdates lock when a duplicate poller is detected — but
      // without a restart layer above, the agent loses Telegram input
      // permanently. After a daemon crash, the old getUpdates connections
      // can hold the lock for ~60s in Telegram's cloud, so this loop
      // sleeps and retries on 'conflict-self-die' until the lock clears.
      // Intentional stops (stopAgent → poller.stop()) set
      // lastExitReason='stopped-externally' and exit the loop cleanly.
      const startPrimaryPollerWithRestart = async () => {
        // 5min hard cap measured against CONSECUTIVE Conflict failures,
        // not total wrapper lifetime. A long-running successful poll
        // (>1min) resets the counter — without this reset, a poller that
        // runs cleanly for hours and then hits a single Conflict would
        // give up immediately because total runtime already exceeds 5min.
        const MAX_CONSECUTIVE_CONFLICT_MS = 5 * 60 * 1000;
        const LONG_RUN_RESET_MS = 60_000;
        let consecutiveConflictStart: number | null = null;
        while (true) {
          // Pre-check: agent may have been deleted from registry during
          // a previous sleep window. Skip the start() call entirely.
          if (!this.agents.has(name)) return;
          const runStart = Date.now();
          try {
            await poller.start();
          } catch (err) {
            log(`Telegram poller threw (will not restart): ${err}`);
            return;
          }
          const runDuration = Date.now() - runStart;
          if (poller.lastExitReason === 'stopped-externally') return;
          if (!this.agents.has(name)) return;
          // A poll session that ran for >LONG_RUN_RESET_MS proves the
          // Conflict lock is no longer chronic — reset the retry budget.
          if (runDuration > LONG_RUN_RESET_MS) consecutiveConflictStart = null;
          if (consecutiveConflictStart === null) consecutiveConflictStart = Date.now();
          if (Date.now() - consecutiveConflictStart > MAX_CONSECUTIVE_CONFLICT_MS) {
            log(`Telegram poller for ${name} could not clear Conflict within 5min of consecutive failures — giving up. Inspect for duplicate bot instance.`);
            return;
          }
          log(`Telegram poller for ${name} exited (${poller.lastExitReason}). Sleeping 30s then restarting to retake getUpdates lock.`);
          await new Promise(r => setTimeout(r, 30_000));
        }
      };
      startPrimaryPollerWithRestart().catch(err => {
        log(`Telegram poller wrapper crashed: ${err}`);
        // Best-effort operator alert via the agent's own bot. The wrapper
        // crashing is rare (the only catchable path is a throw from
        // poller.start() before its own try/catch), but when it happens the
        // agent silently loses Telegram input — exactly the failure class
        // the 2026-05-16 audit flagged. Surface it to the operator chat so
        // they see "X poller crashed" instead of mysterious silence.
        if (telegramApi && chatId) {
          telegramApi.sendMessage(
            String(chatId),
            `${name}: Telegram poller wrapper crashed. Inbound messages may be dropped until restart. Check daemon log.`,
          ).catch(() => { /* swallow alert failure; original log already captured */ });
        }
      });

      // Store poller reference so stopAgent() can clean it up
      const entry = this.agents.get(name);
      if (entry) entry.poller = poller;

      log('Telegram poller started (with Conflict-restart wrapper)');

      // Orchestrator-only: start a second poller for the org's activity
      // channel bot so Telegram inline-button callbacks (currently just
      // appr_allow_*/appr_deny_* from createApproval posts) route to
      // fast-checker's approval resolver. Polling coupled to orchestrator
      // lifecycle is a known trade-off accepted in task_1776053707166_292
      // — follow-up task_1776054009969_099 tracks migrating to a dedicated
      // singleton or Telegram webhook if the coupling ever causes real
      // operator pain. Non-orchestrator agents skip this entirely.
      //
      // F3 fix: pass resolvedOrg, not the raw `org` parameter. Restart
      // paths (restartAgent / queued pendingRestarts) call
      // startAgent(name, '') with no org, so the raw value is empty and
      // the poller early-returned — Approve/Deny activity-channel buttons
      // silently died after every orchestrator restart until full daemon
      // reboot. resolvedOrg is computed via resolveAgentOrg() above and
      // is always non-empty.
      await this.maybeStartActivityChannelPoller(name, resolvedOrg, agentDir, log);
    }
  }

  /**
   * If this agent is the org's orchestrator AND the org has an
   * activity-channel.env configured, start a second TelegramPoller bound
   * to ACTIVITY_BOT_TOKEN. Callbacks route to fast-checker's
   * handleActivityCallback. Safe no-op in every other case — if the
   * context.json is missing/corrupt, the orchestrator field is empty,
   * this agent is not the orchestrator, or the activity-channel.env
   * is absent/unreadable/missing credentials, this method returns
   * without starting anything.
   */
  private async maybeStartActivityChannelPoller(
    name: string,
    org: string | undefined,
    agentDir: string,
    log: LogFn,
  ): Promise<void> {
    if (!org) return;
    const orgDir = join(this.frameworkRoot, 'orgs', org);

    // Only the org's orchestrator runs the activity-channel poller.
    let orchestratorName: string | undefined;
    try {
      // stripBom: see src/utils/strip-bom.ts for incident context.
      const contextJson = stripBom(readFileSync(join(orgDir, 'context.json'), 'utf-8'));
      orchestratorName = JSON.parse(contextJson).orchestrator;
    } catch {
      return; // No context.json or unreadable — skip
    }
    if (!orchestratorName || orchestratorName !== name) return;

    // Parse activity-channel.env for the separate bot token + chat id.
    const activityEnvPath = join(orgDir, 'activity-channel.env');
    let activityBotToken: string | undefined;
    let activityChatId: string | undefined;
    try {
      // stripBom + CRLF-aware split: Windows tooling writes activity-channel.env
      // with BOM + CRLF. Without these, ACTIVITY_BOT_TOKEN never resolves
      // and the activity-channel poller silently never starts.
      const content = stripBom(readFileSync(activityEnvPath, 'utf-8'));
      for (const line of content.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eqIdx = trimmed.indexOf('=');
        if (eqIdx <= 0) continue;
        const key = trimmed.slice(0, eqIdx).trim();
        const value = trimmed.slice(eqIdx + 1).trim();
        if (key === 'ACTIVITY_BOT_TOKEN') activityBotToken = value;
        if (key === 'ACTIVITY_CHAT_ID') activityChatId = value;
      }
    } catch {
      return; // activity-channel.env absent — silent no-op
    }

    if (!activityBotToken || !activityChatId) {
      log('Activity-channel env present but missing BOT_TOKEN or CHAT_ID — skipping poller');
      return;
    }

    const activityApi = new TelegramAPI(activityBotToken);
    const stateDir = join(this.ctxRoot, 'state', name);
    // offsetFileSuffix keeps the activity poller's offset file distinct
    // from the primary bot's .telegram-offset — without this they would
    // clobber each other in the same stateDir.
    const activityPoller = new TelegramPoller(activityApi, stateDir, 1000, 'activity');

    activityPoller.onCallback((query) => {
      const entry = this.agents.get(name);
      if (!entry) return;
      entry.checker.handleActivityCallback(query, activityApi).catch((err) => {
        log(`Activity-channel callback error: ${err}`);
      });
    });

    // Best-effort message logger — activity channel is primarily outbound
    // but any inbound chatter (broadcasts, user DMs, etc.) gets logged
    // so operators can see what is flowing. No PTY injection.
    activityPoller.onMessage((msg) => {
      const from = stripControlChars(msg.from?.first_name || msg.from?.username || 'Unknown');
      const text = stripControlChars(msg.text || msg.caption || '');
      log(`[activity-channel inbound] from ${from}: ${text.slice(0, 120)}`);
    });

    // Same Conflict-restart wrapper as the primary poller — activity
    // channel can lose its getUpdates lock after a daemon crash too.
    // 5min retry budget measured against CONSECUTIVE failures; resets
    // after a >1min successful run. See primary poller wrapper for rationale.
    const startActivityPollerWithRestart = async () => {
      const MAX_CONSECUTIVE_CONFLICT_MS = 5 * 60 * 1000;
      const LONG_RUN_RESET_MS = 60_000;
      let consecutiveConflictStart: number | null = null;
      while (true) {
        if (!this.agents.has(name)) return;
        const runStart = Date.now();
        try {
          await activityPoller.start();
        } catch (err) {
          log(`Activity-channel poller threw (will not restart): ${err}`);
          return;
        }
        const runDuration = Date.now() - runStart;
        if (activityPoller.lastExitReason === 'stopped-externally') return;
        if (!this.agents.has(name)) return;
        if (runDuration > LONG_RUN_RESET_MS) consecutiveConflictStart = null;
        if (consecutiveConflictStart === null) consecutiveConflictStart = Date.now();
        if (Date.now() - consecutiveConflictStart > MAX_CONSECUTIVE_CONFLICT_MS) {
          log(`Activity-channel poller for ${name} could not clear Conflict within 5min of consecutive failures — giving up.`);
          return;
        }
        log(`Activity-channel poller for ${name} exited (${activityPoller.lastExitReason}). Sleeping 30s then restarting.`);
        await new Promise(r => setTimeout(r, 30_000));
      }
    };
    startActivityPollerWithRestart().catch((err) => {
      log(`Activity-channel poller wrapper crashed: ${err}`);
    });

    const entry = this.agents.get(name);
    if (entry) entry.activityPoller = activityPoller;

    log(`Activity-channel poller started (chat ${activityChatId}, with Conflict-restart wrapper)`);
  }

  /**
   * Stop a specific agent.
   */
  async stopAgent(name: string, userInitiated = false): Promise<void> {
    const entry = this.agents.get(name);
    if (!entry) {
      console.log(`[agent-manager] Agent ${name} not found`);
      return;
    }

    if (entry.poller) entry.poller.stop();
    if (entry.activityPoller) entry.activityPoller.stop();
    if (entry.slackListener) entry.slackListener.stop();
    this.cronNoopDetector.cancelAgentVerifications(name);
    entry.checker.stop();
    await entry.process.stop();
    this.agents.delete(name);

    // Stop and remove the agent's cron scheduler (if one was wired)
    const scheduler = this.cronSchedulers.get(name);
    if (scheduler) {
      scheduler.stop();
      this.cronSchedulers.delete(name);
    }

    if (userInitiated) {
      if (this.pendingRestarts.delete(name)) {
        console.log(`[agent-manager] Dropped queued restart for ${name} — explicit user stop/disable wins.`);
      }
      return;
    }

    // BUG-031: honor any restart that was queued while we were stopping.
    // After PR #11 (BUG-011 fix) this branch should never fire — see the
    // matching warning comment in startAgent(). The honor logic is preserved
    // as a safety net in case BUG-011 regresses; the warn line tells us
    // immediately if it ever does.
    const pendingRestart = this.pendingRestarts.get(name);
    if (pendingRestart) {
      const consumeDerivedCause = this.pendingRestartCause();
      this.emitPendingRestartEvent(
        name,
        'pending_restart_consumed',
        'consume',
        pendingRestart,
        consumeDerivedCause,
      );
      if (pendingRestart.cause !== consumeDerivedCause) {
        this.emitPendingRestartEvent(
          name,
          'pending_restart_cause_disagreement',
          'consume',
          pendingRestart,
          consumeDerivedCause,
        );
      }
      if (this.daemonJustCrashed) {
        console.log(`[agent-manager] pendingRestarts fired for ${name} (post-crash safety net, expected). Honoring queued restart.`);
      } else {
        console.warn(`[agent-manager] BUG-011 REGRESSION CHECK: pendingRestarts fired for ${name} — race condition leaked through. Honoring queued restart as safety net.`);
      }
      this.pendingRestarts.delete(name);
      console.log(`[agent-manager] Honoring queued restart for ${name}`);
      this.startAgent(name, '').catch(err =>
        console.error(`[agent-manager] Queued restart failed for ${name}:`, err),
      );
    }
  }

  /**
   * Restart a specific agent.
   *
   * Delegates to stopAgent + startAgent to guarantee a full teardown and
   * rebuild of every per-agent resource: AgentProcess, FastChecker, TelegramAPI,
   * TelegramPoller, crash callback, and slash-command registration. Fresh
   * credentials are re-read from {agentDir}/.env on each restart.
   *
   * agentDir is auto-discovered by startAgent() from frameworkRoot/orgs/{org}/agents/{name}.
   * Participates in the pendingRestarts race protection used by restart-all.
   */
  async restartAgent(name: string, options: AgentRestartOptions = {}): Promise<void> {
    this.inFlightRestarts.add(name);
    try {
      if (options.partOfFleetStart && !this.fleetStartBatch) {
        // `soft-restart-all` restarts child agent sessions only. The daemon and
        // this AgentManager instance are not part of that restart set, so this
        // in-memory coordinator persists until every requested child settles.
        this.beginFleetStartBatch(options.fleetTotal ?? 1, 'restart-all');
      }
      if (!this.agents.has(name)) {
        console.log(`[agent-manager] Agent ${name} not found — cannot restart`);
        if (options.partOfFleetStart) {
          this.recordFleetStartAgent(name);
          this.finishFleetStartBatch();
        }
        return;
      }
      console.log(`[agent-manager] Restarting ${name}`);
      try {
        await this.stopAgent(name);
        await this.startAgent(name, '', undefined, undefined, { partOfFleetStart: options.partOfFleetStart });
        console.log(`[agent-manager] Restart complete for ${name}`);
      } finally {
        if (options.partOfFleetStart) {
          this.recordFleetStartAgent(name);
          this.finishFleetStartBatch();
        }
      }
    } finally {
      this.inFlightRestarts.delete(name);
    }
  }

  /**
   * Stop all agents.
   *
   * BUG-034 partial fix: writes a `.daemon-stop` marker file in each agent's
   * state dir BEFORE stopping it. The SessionEnd crash-alert hook
   * (src/hooks/hook-crash-alert.ts) reads this marker and reports a clean
   * `🛑 daemon shutdown` notification instead of a false `🚨 CRASH` alarm.
   * Without this, every `pm2 restart cortextos-daemon` (or `pm2 stop`)
   * generates a false crash alarm per agent — trust-destroying.
   *
   * Pattern matches src/cli/bus.ts:1283-1289 and PR #12 (BUG-036). Markers
   * are written synchronously before the async stop loop starts, so by the
   * time `pty.kill()` runs, every agent already has its marker on disk.
   */
  async stopAll(): Promise<void> {
    const names = [...this.agents.keys()];

    for (const name of names) {
      try {
        const stateDir = join(this.ctxRoot, 'state', name);
        mkdirSync(stateDir, { recursive: true });
        writeFileSync(join(stateDir, '.daemon-stop'), 'daemon shutdown (SIGTERM)');
      } catch (err) {
        // Don't block shutdown on marker-write failure — worst case the user
        // gets a false crash alarm (the bug we're fixing), best case they get
        // the correct daemon-stop notification.
        console.error(`[agent-manager] Failed to write .daemon-stop marker for ${name}: ${err}`);
      }
    }

    for (const name of names) {
      try {
        await this.stopAgent(name);
      } catch (err) {
        console.error(`[agent-manager] Error stopping ${name}:`, err);
      }
    }
  }

  /**
   * Get status of all agents.
   */
  getAllStatuses(): AgentStatus[] {
    const statuses: AgentStatus[] = [];
    for (const [, entry] of this.agents) {
      statuses.push(entry.process.getStatus());
    }
    return statuses;
  }

  /**
   * Get status of a specific agent.
   */
  getAgentStatus(name: string): AgentStatus | null {
    const entry = this.agents.get(name);
    return entry ? entry.process.getStatus() : null;
  }

  /**
   * Get the FastChecker for an agent (for Telegram message routing).
   */
  getFastChecker(name: string): FastChecker | null {
    return this.agents.get(name)?.checker || null;
  }

  /**
   * Get all agent names.
   */
  getAgentNames(): string[] {
    return [...this.agents.keys()];
  }

  /**
   * Return the CronScheduler for a given agent (for testing / introspection).
   * Returns undefined if no scheduler is running for that agent.
   */
  getCronScheduler(agentName: string): CronScheduler | undefined {
    return this.cronSchedulers.get(agentName);
  }

  // --- Worker management ---

  /**
   * Spawn an ephemeral worker session for a parallelized task.
   */
  async spawnWorker(name: string, dir: string, prompt: string, parent?: string, model?: string): Promise<void> {
    if (this.workers.has(name)) {
      throw new Error(`Worker "${name}" is already running`);
    }
    if (this.agents.has(name)) {
      throw new Error(`"${name}" is already a registered agent name`);
    }

    const log = (msg: string) => console.log(`[worker:${name}] ${msg}`);
    const worker = new WorkerProcess(name, dir, parent, log);

    const env: CtxEnv = {
      instanceId: this.instanceId,
      ctxRoot: this.ctxRoot,
      frameworkRoot: this.frameworkRoot,
      agentName: name,
      agentDir: dir,
      // F4 fix (BUG-043 class): resolve the org through resolveAgentOrg()
      // instead of the daemon's startup org. Workers are ephemeral and never
      // exist under orgs/*/agents/, so resolve via the spawning parent agent
      // when one is given (the common path — bus spawn-worker always passes
      // the caller). Falls back to the worker's own name, whose resolution
      // chain ends at this.org — identical to the old behavior for
      // parentless workers on single-org installs.
      org: this.resolveAgentOrg(parent ?? name),
      projectRoot: this.frameworkRoot,
    };

    const config = model ? { model } : {};

    this.workers.set(name, worker);

    worker.onDone((workerName) => {
      // Auto-remove finished workers after a short delay so list-workers
      // can still show the final status briefly before cleanup
      setTimeout(() => {
        if (this.workers.get(workerName)?.isFinished()) {
          this.workers.delete(workerName);
        }
      }, 30_000); // keep for 30s after exit
    });

    await worker.spawn(env, prompt, config);
  }

  /**
   * Terminate a running worker session.
   */
  async terminateWorker(name: string): Promise<void> {
    const worker = this.workers.get(name);
    if (!worker) {
      throw new Error(`Worker "${name}" not found`);
    }
    await worker.terminate();
    this.workers.delete(name);
  }

  /**
   * Inject text into a running worker's PTY (nudge / stuck-state recovery).
   */
  injectWorker(name: string, text: string): boolean {
    const worker = this.workers.get(name);
    if (!worker) return false;
    return worker.inject(text);
  }

  /**
   * Inject text directly into a running agent's PTY.
   * Used by `cortextos bus test-cron-fire` to fire a cron immediately for testing.
   * Returns true if the agent is running and the inject succeeded; false otherwise.
   */
  injectAgent(agentName: string, text: string): boolean {
    return this.injectAgentDetailed(agentName, text).ok;
  }

  /**
   * Inject text into an agent's PTY with structured outcome — issue #346.
   *
   * Returns NOT_FOUND if the agent isn't in the registry, NOT_RUNNING if
   * registered but the PTY is gone, DEDUPED on a MessageDedup hash hit, and
   * ADMISSION_FAILED if the runtime could not durably take custody. The
   * boolean-returning `injectAgent()` is preserved for callers (cron
   * scheduler, fast-checker, fire-cron) that only need pass/fail.
   */
  injectAgentDetailed(
    agentName: string,
    text: string,
    options?: AgentInjectionOptions,
  ): AgentInjectionResult | { ok: false; code: 'NOT_FOUND'; message: string } {
    const entry = this.agents.get(agentName);
    if (!entry) {
      return { ok: false, code: 'NOT_FOUND', message: `agent "${agentName}" not in registry` };
    }
    return entry.process.injectMessageDetailed(text, options);
  }

  /**
   * Telemetry for the side-run path. Every event carries the cron and the fire
   * it belongs to; fallback events additionally carry a REASON.
   *
   * Six distinct fallback reasons are only worth having if they reach a log
   * someone can count — an invisible fallback means routing looks successful
   * while quietly doing nothing, which is the failure this path must not create.
   */
  private logSideRunEvent(agentName: string, event: string, meta: Record<string, unknown>): void {
    try {
      const org = this.resolveAgentOrg(agentName);
      const paths = resolvePaths(agentName, this.instanceId, org);
      logEvent(paths, agentName, org || '', 'action', event, 'info', { agent: agentName, ...meta });
    } catch (err) {
      console.log(`[daemon] side-run telemetry failed for ${agentName} (non-fatal): ${err}`);
    }
  }

  /**
   * Re-check outstanding side-run outcome slots. Called from the cron
   * scheduler's existing tick, never awaited inside a fire.
   *
   * Every terminal verdict clears its slot, so a slot can only produce one
   * action: the escalation path is idempotent because a redelivery finds
   * nothing left to act on.
   */
  private sweepSideRunsForAgent(agentName: string, nowMs: number): void {
    let stateDir: string;
    try {
      const org = this.resolveAgentOrg(agentName);
      stateDir = resolvePaths(agentName, this.instanceId, org).stateDir;
    } catch {
      return;
    }

    for (const action of sweepSideRuns(stateDir, nowMs)) {
      const { slotName, admissionId, cronName, verdict, cronPrompt, continuationPrompt } = action;
      try {
        if (verdict.action === 'done') {
          this.logSideRunEvent(agentName, 'cron_side_run_clean', {
            cron: cronName, fired_at: admissionId,
          });
        } else if (verdict.action === 'escalate') {
          // Judgment belongs to the main session. The side-run only decided
          // that judgment is required.
          //
          // For a handoff-shaped cron the summary alone is not enough: it says
          // what was collected, never what the session still owes. The directive
          // travels in the slot from admission, so it is delivered here rather
          // than reconstructed.
          this.injectAgent(agentName, buildEscalationInjection({
            cronName, summary: verdict.summary, continuationPrompt,
          }));
          this.logSideRunEvent(agentName, 'cron_side_run_escalated', {
            cron: cronName, fired_at: admissionId,
          });
        } else {
          // Fall back to exactly what would have happened without side-runs.
          // The prompt was frozen in the admission slot. Looking up the current
          // scheduler definition here lets an edit or delete rewrite an already
          // admitted fire during its deadline.
          const injected = typeof cronPrompt === 'string'
            && cronPrompt.length > 0
            && this.injectAgent(agentName, cronPrompt);
          this.logSideRunEvent(agentName, 'cron_side_run_fallback', {
            cron: cronName,
            fired_at: admissionId,
            reason: verdict.reason,
            injected,
          });
        }
      } finally {
        // Cleared even if the injection threw: a slot left behind would be
        // re-actioned on the next tick, turning one missed fire into a loop.
        clearObservedSlot(stateDir, slotName);
      }
    }
  }

  /**
   * Inject a daemon-owned cron fire with structured Codex routing metadata.
   * Prompt text is never parsed by the PTY as routing authority.
   */
  injectCronAgent(
    agentName: string,
    cron: Pick<CronDefinition, 'name' | 'prompt'>,
    text: string,
    firedAt = new Date().toISOString(),
  ): boolean {
    const entry = this.agents.get(agentName);
    if (!entry) return false;
    const config = entry.process.getConfig();

    // Claude-side cheap-model side-run. Mutually exclusive with the codex route
    // below (that requires runtime codex-app-server, this requires claude-code).
    //
    // Returning true here means ADMITTED, not COMPLETE: the chore runs headless
    // and the scheduler's tick sweep decides what its outcome means. A side-run
    // that never answers falls back to normal injection at its deadline, so this
    // branch cannot silently skip a check.
    // Resolve the agent directory defensively. This whole branch sits IN FRONT OF
    // the ordinary cron path, so anything it can throw becomes a cron fire that
    // never happens — the exact failure the side-run design exists to prevent,
    // relocated into its own entry check. An unavailable agent dir means "cannot
    // verify the pinned instruction file", which means do not route.
    let sideAgentDir: string | undefined;
    try {
      const getDir = (entry.process as { getAgentDir?: () => string }).getAgentDir;
      sideAgentDir = typeof getDir === 'function' ? getDir.call(entry.process) : undefined;
    } catch {
      sideAgentDir = undefined;
    }

    let sidePlan: ReturnType<typeof resolveSideRunRouting> = null;
    try {
      const resolution = resolveSideRunResolution({
        cron,
        runtime: config.runtime,
        admissionId: firedAt,
        agent: agentName,
        agentDir: sideAgentDir,
        registry: this.sideRunRegistry,
      });
      sidePlan = resolution.plan;
      // A decline used to be SILENT. Routing could switch itself off fleet-wide
      // and the only evidence was the shape of the prompt someone noticed
      // (2026-08-09). Counted only for CANDIDATES — crons whose name is in the
      // registry and therefore SHOULD route — so the event means "something that
      // should have routed did not", never "an ordinary cron ran normally".
      if (!resolution.plan && resolution.candidate && resolution.reason) {
        this.logSideRunEvent(agentName, 'cron_side_run_declined', {
          cron: cron.name,
          fired_at: firedAt,
          reason: resolution.reason,
        });
      }
    } catch (err) {
      console.log(`[daemon] side-run routing check failed for ${agentName}/${cron.name}, using main session: ${err}`);
      sidePlan = null;
    }
    if (sidePlan) {
      try {
        const org = this.resolveAgentOrg(agentName);
        const stateDir = resolvePaths(agentName, this.instanceId, org).stateDir;
        const pending: SideRunPending = {
          admissionId: sidePlan.admissionId,
          cronName: cron.name,
          agent: agentName,
          admittedAtMs: Date.parse(firedAt) || Date.now(),
          deadlineMs: sidePlan.deadlineMs,
          cronPrompt: cron.prompt ?? text,
          sideRunPrompt: sidePlan.prompt,
          continuationPrompt: sidePlan.continuationPrompt,
        };
        // Slot first, then spawn. If the spawn dies instantly the slot still
        // exists and the sweep converts it to a fallback; spawning first would
        // leave a fire with no record that it was ever admitted.
        writePendingSlot(stateDir, pending);
        startSideRun(stateDir, sideAgentDir ?? this.frameworkRoot, sidePlan, pending);
        this.logSideRunEvent(agentName, 'cron_side_run_started', {
          cron: cron.name,
          fired_at: firedAt,
          model: sidePlan.routing.model,
          prompt_sha256: sidePlan.routing.promptSha256,
        });
        // `true` here means ADMITTED, not COMPLETE. The scheduler reads it as
        // fired, which is correct ONLY because the tick sweep guarantees either a
        // later injection or a counted fallback for this admission id. If that
        // guarantee ever breaks, this fire is silently lost.
        return true;
      } catch (err) {
        // Any failure here falls through to normal injection below. The chore
        // still runs; it just costs what it costs today.
        console.log(`[daemon] side-run admission failed for ${agentName}/${cron.name}, using main session: ${err}`);
      }
    }

    const plan = resolveCodexCronRouting({
      cron,
      frameworkRoot: this.frameworkRoot,
      runtime: config.runtime,
      configuredModel: config.model,
    });
    const dedupIdentity = `daemon-cron:${cron.name}:${firedAt}`;
    const result = this.injectAgentDetailed(
      agentName,
      plan?.preflightPrompt ?? text,
      plan ? {
        codexRouting: plan.routing,
        codexContinuation: plan.continuationPrompt,
        codexFallback: plan.fallbackPrompt,
        dedupIdentity,
      } : undefined,
    );
    if (!result.ok) {
      // A scheduler retry for the same admitted fire is idempotent success:
      // MessageDedup proves the sequence already crossed admission. Do not
      // emit a second route-planned event, but let the scheduler close fired.
      if (result.code === 'DEDUPED' && plan && result.dedupIdentity === dedupIdentity) return true;
      return false;
    }

    if (plan) {
      const { routing } = plan;
      try {
        const resolvedOrg = this.resolveAgentOrg(agentName);
        const paths = resolvePaths(agentName, this.instanceId, resolvedOrg);
        logEvent(paths, agentName, resolvedOrg || '', 'action', 'cron_model_route_planned', 'info', {
          agent: agentName,
          cron: cron.name,
          fired_at: firedAt,
          model: routing.model,
          reason: routing.reason,
          skill_name: routing.skillName ?? null,
          requested_model: routing.requestedModel ?? null,
          requested_effort: routing.effort ?? null,
        });
      } catch (err) {
        console.log(`[daemon] cron model route telemetry failed for ${agentName}/${cron.name} (non-fatal): ${err}`);
      }
    }
    return true;
  }

  /**
   * Signal the CronScheduler for an agent to re-read crons.json.
   *
   * Called by the IPC server after a `bus add-cron` / `bus remove-cron` write so
   * the daemon-level scheduler picks up the new definition without waiting for
   * the next 30 s tick.  Returns true on a successful reload (or no-op for
   * Hermes agents, which manage their own crons natively); false if the agent
   * is not running at all.
   *
   * Iter 7 fix: previously this returned `true` for any registered agent even
   * when no scheduler existed in `cronSchedulers`, silently dropping reload
   * requests during the start-window gap between `this.agents.set(name, ...)`
   * and `startAgentCronScheduler(name)` (across the `await agentProcess.start()`
   * yield in `startAgent`). Now: for non-Hermes agents that lack a scheduler we
   * lazy-wire one so the just-written crons.json is read immediately.
   */
  reloadCrons(agentName: string): boolean {
    const scheduler = this.cronSchedulers.get(agentName);
    if (scheduler) {
      scheduler.reload();
      console.log(`[agent-manager] Cron scheduler reloaded for ${agentName}`);
      return true;
    }

    const entry = this.agents.get(agentName);
    if (!entry) return false;

    // Hermes manages its own crons natively — no daemon scheduler exists by
    // design. The reload IS a no-op; report success so the caller does not
    // retry forever.
    if (entry.process['config']?.runtime === 'hermes') {
      return true;
    }

    // Non-Hermes agent registered but no scheduler: this is the start-window
    // gap. Lazy-wire the scheduler now; its start() reads crons.json which
    // already contains the new entry the caller just wrote.
    this.startAgentCronScheduler(agentName);
    console.log(`[agent-manager] Cron scheduler lazy-created for ${agentName} (start-window reload)`);
    return this.cronSchedulers.has(agentName);
  }

  /**
   * Wire a daemon-level CronScheduler for the named agent.
   *
   * The scheduler reads `crons.json` (via `readCrons()`), computes fire times,
   * and on each tick injects the cron's prompt text directly into the agent PTY
   * via `injectAgent()`.  The fire callback builds the same injected text that
   * a Claude-Code `CronCreate` callback would emit so the agent's session sees
   * a normal-looking cron-fire message and handles it with existing skill code.
   *
   * Hermes agents manage their own cron system natively — skip them here.
   * If crons.json is absent or empty the scheduler starts but has nothing to do;
   * it will pick up new entries on the next `reloadCrons()` call.
   */
  private startAgentCronScheduler(agentName: string): void {
    // Skip if already running (idempotent — e.g. called twice on fast restart)
    if (this.cronSchedulers.has(agentName)) {
      console.log(`[agent-manager] Cron scheduler already running for ${agentName} — skipped`);
      return;
    }

    const entry = this.agents.get(agentName);
    if (!entry) return;

    // Hermes manages its own cron scheduling — don't double-schedule
    if (entry.process['config']?.runtime === 'hermes') {
      console.log(`[daemon] Skipping external cron scheduler for Hermes agent "${agentName}"`);
      return;
    }

    const onFire = (cron: CronDefinition, context: CronFireContext) =>
      this.handleAgentCronFire(agentName, cron, context);

    const scheduler = new CronScheduler({
      agentName,
      onFire,
      // Rides the existing 30s tick so side-run outcomes are re-checked without
      // a new timer and without blocking a fire slot.
      onTick: (nowMs) => this.sweepSideRunsForAgent(agentName, nowMs),
      logger: (msg) => console.log(`[daemon] ${msg}`),
    });

    scheduler.start();
    this.cronSchedulers.set(agentName, scheduler);

    const count = scheduler.getNextFireTimes().length;
    console.log(`[daemon] Loaded ${count} external cron(s) for agent "${agentName}" from crons.json`);
  }

  /**
   * Evaluate whether a cron fire should be suppressed by the agent's shift gate.
   *
   * Returns `null` to allow the fire, or an object describing the suppression
   * mode to drop it. Crons with `wake_on_fire: true` always return `null` —
   * they bypass the shift gate entirely. Agents without a `shift_schedule`
   * configured evaluate as in-shift always (returns `null`).
   *
   * Visible on the instance (not exported) so unit tests can drive it directly
   * without spinning up a real CronScheduler.
   */
  private evaluateCronShiftSuppression(
    agentName: string,
    cron: CronDefinition
  ): { mode: 'no_wake' | 'emergency_only_no_tag' } | null {
    // Tier 1 — unconditional pierce. Blunt on purpose: fires through every
    // suppression window, emits no suppression telemetry.
    if (cron.wake_on_fire) return null;

    const agentEntry = this.agents.get(agentName);
    const agentConfig = agentEntry?.process['config'] as AgentConfig | undefined;
    if (!agentConfig) return null;

    // Tier 2 — conditional wake by declared emergency CLASS.
    //
    // Added 2026-08-10 after the Greenwood/TDL50WP post-mortem. The agent's
    // `off_shift_can_wake_for` list had been written by a human, read correctly
    // to a human, and was consulted by NOTHING: an emergency check-back fired at
    // 02:00:29Z, was suppressed off-shift, and never reached the agent. A flood
    // would have been suppressed identically.
    //
    // A boolean could not express "flood wakes this agent, a routine sweep does
    // not" — hence a class matched against the agent's own list, which makes the
    // configuration the author already wrote actually govern behaviour.
    if (cronWakesForEmergencyClass(cron, agentConfig)) return null;

    const tz = agentConfig.timezone || 'America/New_York';
    const ev = evaluateShift(new Date(), agentConfig.shift_schedule, tz);
    if (ev.off_shift_no_wake) return { mode: 'no_wake' };
    if (ev.off_shift_emergency_only) return { mode: 'emergency_only_no_tag' };
    return null;
  }

  /**
   * Get status of all workers (running + recently completed).
   */
  listWorkers(): WorkerStatus[] {
    return [...this.workers.values()].map(w => w.getStatus());
  }

  /**
   * Get status of a specific worker.
   */
  getWorkerStatus(name: string): WorkerStatus | null {
    return this.workers.get(name)?.getStatus() ?? null;
  }

  /**
   * Discover agents from the organization directory structure.
   *
   * BUG-043 fix: iterate over EVERY org under `frameworkRoot/orgs/*`,
   * not just `this.org`. Before this fix, a daemon started with
   * `CTX_ORG=testorg` would only discover agents in `orgs/testorg/agents/`
   * — agents in `orgs/lifeos/agents/` and `orgs/cointally/agents/` were
   * effectively invisible to the daemon and could never be auto-spawned
   * from a cold start. Multi-org installs silently half-worked.
   *
   * The returned tuple now includes an `org` field so `discoverAndStart()`
   * can pass the correct org to `startAgent()` and downstream path
   * lookups via `resolveAgentOrg()`.
   */
  private discoverAgents(): Array<{ name: string; dir: string; org: string; config: AgentConfig }> {
    return discoverSourceAgentCandidates(this.frameworkRoot);
  }
}

/**
 * Derive a human-readable reply context string from a Telegram replied-to message.
 *
 * Priority: text > caption > media type label.
 * This is exported for unit testing; call sites use it via the message handler.
 *
 * Before this fix (BUG: reply context lost for media messages): only `.text` was
 * checked, so replies to videos/photos/voice arrived as bare text with no
 * indication of what was being replied to (e.g. "This one" with zero context).
 */
export function buildReplyContext(
  replyMsg: TelegramMessage | undefined,
): string | undefined {
  if (!replyMsg) return undefined;
  const parts: string[] = [];
  if (replyMsg.text) {
    parts.push(stripControlChars(replyMsg.text));
  } else if (replyMsg.caption) {
    parts.push(stripControlChars(replyMsg.caption));
  }

  if (replyMsg.document) parts.push(`[document: ${replyMsg.document.file_name ?? 'file'}]`);
  if (replyMsg.photo) parts.push('[photo]');
  if (replyMsg.video) parts.push('[video]');
  if (replyMsg.video_note) parts.push('[video note]');
  if (replyMsg.voice) parts.push('[voice message]');
  if (replyMsg.audio) parts.push('[audio]');

  if (parts.length > 0) return parts.join('\n');
  return undefined;
}
