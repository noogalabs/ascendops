/**
 * I/O half of the Claude-side cron side-run path.
 *
 * cron-side-run.ts holds every decision and stays pure. This file does the
 * spawning, the slot files and the per-tick sweep, and delegates every judgment
 * back to classifySlot so there is exactly one place that decides what an
 * outcome means.
 *
 * WHY A TICK SWEEP RATHER THAN AWAITING INSIDE onFire (an agent, 2026-08-07):
 * blocking a fire slot for up to the deadline on a chore that exists to be cheap
 * inverts the point, and it couples a routine check to the scheduler heartbeat —
 * one slow side-run would delay unrelated fires. That is a new failure mode
 * rather than a solved one. The slot file is the state, and it already survives
 * ticks, which is what an admission record is for.
 */

import { spawn } from 'child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { createHash } from 'crypto';
import {
  SIDE_RUN_MODEL,
  buildSideRunPrompt,
  classifySlot,
  parseSideRunOutput,
  type SideRunPlan,
  type SideRunSlot,
  type SlotVerdict,
  type FallbackReason,
} from './cron-side-run.js';

export interface SideRunPending {
  admissionId: string;
  cronName: string;
  admittedAtMs: number;
  deadlineMs: number;
  /** Agent this fire belongs to, passed to the run as CTX_SIDE_RUN_AGENT. */
  agent?: string;
  /** Original cron text, so a fallback can inject exactly what would have fired. */
  cronPrompt: string;
  /**
   * What the side-run actually runs. Differs from cronPrompt when the cron's own
   * prompt is a pointer and a frozen substitute is used instead. The fallback
   * still injects cronPrompt, because the main session must receive exactly what
   * would have fired without routing.
   */
  sideRunPrompt?: string;
  /**
   * Directive injected ahead of the summary when this fire escalates. Captured
   * at admission for the same reason sideRunPrompt is: an in-flight fire must
   * escalate under the registry version that admitted it, not whatever the
   * registry says by the time the sweep gets to it.
   */
  continuationPrompt?: string;
}

/**
 * Slot filenames are a hash of the admission id. Admission ids are ISO strings
 * containing colons, which are legal on this platform but not everywhere, and a
 * hash also stops a crafted cron name from escaping the directory.
 */
export function slotFileName(admissionId: string): string {
  return `${createHash('sha256').update(admissionId, 'utf8').digest('hex').slice(0, 32)}.json`;
}

export function sideRunDir(stateDir: string): string {
  return join(stateDir, 'side-runs');
}

export function writePendingSlot(stateDir: string, pending: SideRunPending): void {
  const dir = sideRunDir(stateDir);
  mkdirSync(dir, { recursive: true });
  const slot: SideRunSlot & { pending: SideRunPending } = {
    admissionId: pending.admissionId,
    status: 'pending',
    pending,
  };
  writeFileSync(join(dir, slotFileName(pending.admissionId)), JSON.stringify(slot), 'utf8');
}

export function writeOutcomeSlot(stateDir: string, slot: SideRunSlot, pending: SideRunPending): void {
  const dir = sideRunDir(stateDir);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, slotFileName(slot.admissionId)), JSON.stringify({ ...slot, pending }), 'utf8');
}

/**
 * Read a slot. A file that exists but will not parse returns the RAW string, not
 * null: classifySlot must be able to tell "unreadable" from "missing" because
 * they are different failures and only one of them means the side-run never
 * started. Collapsing them would be the absence-is-not-evidence mistake again.
 */
export function readSlotRaw(stateDir: string, admissionId: string): unknown {
  const file = join(sideRunDir(stateDir), slotFileName(admissionId));
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return '<unparseable>';
  }
}

export function clearSlot(stateDir: string, admissionId: string): void {
  const file = join(sideRunDir(stateDir), slotFileName(admissionId));
  try {
    if (existsSync(file)) unlinkSync(file);
  } catch {
    /* a slot we cannot delete will be re-classified next tick and cleared then */
  }
}

/**
 * Clear the exact directory entry observed by the sweep.
 *
 * An unreadable slot has no trustworthy admission id, so hashing a synthetic
 * placeholder can never address the file that was actually read. The filename
 * comes from readdirSync, but the boundary stays fail-closed for direct callers.
 */
export function clearObservedSlot(stateDir: string, slotName: string): void {
  const dir = resolve(sideRunDir(stateDir));
  const file = resolve(dir, slotName);
  if (dirname(file) !== dir || !slotName.endsWith('.json')) return;
  try {
    if (existsSync(file)) unlinkSync(file);
  } catch {
    /* a slot we cannot delete will be re-classified next tick and cleared then */
  }
}

export function listPendingSlots(stateDir: string): Array<{
  slotName: string;
  slot: unknown;
  pending: SideRunPending | null;
}> {
  const dir = sideRunDir(stateDir);
  if (!existsSync(dir)) return [];
  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => n.endsWith('.json'));
  } catch {
    return [];
  }
  const out: Array<{ slotName: string; slot: unknown; pending: SideRunPending | null }> = [];
  for (const name of names) {
    try {
      const parsed = JSON.parse(readFileSync(join(dir, name), 'utf8'));
      out.push({ slotName: name, slot: parsed, pending: (parsed?.pending ?? null) as SideRunPending | null });
    } catch {
      out.push({ slotName: name, slot: '<unparseable>', pending: null });
    }
  }
  return out;
}

/* ── spawn ──────────────────────────────────────────────────────────────── */

export interface SpawnDeps {
  spawnFn?: typeof spawn;
  now?: () => number;
}

/**
 * Fire-and-forget headless run. Never throws and never blocks the caller: any
 * failure simply leaves the slot pending, which the sweep converts to a fallback
 * at the deadline. There is deliberately no error path that writes a verdict —
 * a crashed side-run must not be able to author "clean".
 */
export function startSideRun(
  stateDir: string,
  agentDir: string,
  plan: SideRunPlan,
  pending: SideRunPending,
  deps: SpawnDeps = {},
): void {
  const spawnFn = deps.spawnFn ?? spawn;
  const now = deps.now ?? Date.now;
  try {
    // Explicit environment. The first version passed none, so the headless run
    // inherited whatever the spawning process happened to carry — including
    // CTX_AGENT_NAME, which hook-crash-alert uses to decide WHICH agent an exit
    // belongs to. A side-run exiting normally therefore filed itself as a crash
    // against an unrelated agent (observed 2026-08-07: two rows in an agent's
    // crashes.log for an agent's voice-watch side-runs). Attribution was inherited by
    // accident rather than chosen, which is exactly the kind of thing that
    // misfiles quietly and forever.
    //
    // CTX_SIDE_RUN is a POSITIVE marker rather than relying on the absence of
    // CTX_AGENT_NAME: a consumer that keys on "no agent name" cannot tell a
    // side-run from a misconfigured spawn, and this codebase has been bitten
    // repeatedly by absence standing in for evidence.
    const env: NodeJS.ProcessEnv = { ...process.env, CTX_SIDE_RUN: '1' };
    delete env.CTX_AGENT_NAME;
    // The agent name still has to reach the run — a collection prompt filtering by
    // agent needs it — but it cannot travel as CTX_AGENT_NAME, because that is the
    // variable crash attribution keys on. Two of my own changes collided here: the
    // attribution fix removed the variable the collection prompt depended on, so a
    // live smoke returned every agent's tasks instead of this agent's. Carried
    // under a name nothing else reads.
    if (pending.agent) env.CTX_SIDE_RUN_AGENT = pending.agent;

    const child = spawnFn(
      'claude',
      ['-p', buildSideRunPrompt(pending.sideRunPrompt ?? pending.cronPrompt), '--model', SIDE_RUN_MODEL],
      { cwd: agentDir, stdio: ['ignore', 'pipe', 'pipe'], detached: false, env },
    );
    let stdout = '';
    child.stdout?.on('data', (d: Buffer | string) => { stdout += String(d); });
    child.on('error', () => { /* leave pending; the deadline decides */ });
    child.on('close', (code: number | null) => {
      if (code !== 0) return; // non-zero: leave pending, fall back at deadline
      try {
        writeOutcomeSlot(stateDir, parseSideRunOutput(plan.admissionId, stdout, now()), pending);
      } catch {
        /* leave pending */
      }
    });
  } catch {
    /* leave pending; the deadline decides */
  }
}

/* ── sweep ──────────────────────────────────────────────────────────────── */

export interface SweepAction {
  /** Exact directory entry observed by the sweep; cleanup never reconstructs it. */
  slotName: string;
  admissionId: string;
  cronName: string;
  /**
   * Never 'wait'. The sweep filters those out, so encoding it in the type means
   * a caller cannot forget the case and cannot be forced to handle one that
   * never arrives.
   */
  verdict: Exclude<SlotVerdict, { action: 'wait' }>;
  /** Frozen at admission, so fallback never consults mutable scheduler state. */
  cronPrompt?: string;
  /** From the slot, so the caller never has to consult the registry. */
  continuationPrompt?: string;
}

/**
 * Classify every outstanding slot. Pure over its inputs apart from the reads —
 * the caller performs the injections and the telemetry, so this stays testable.
 *
 * A slot whose `pending` block is missing or unreadable is reported as a
 * fallback rather than dropped. Dropping it would make a broken slot look like
 * a completed fire, which is the single outcome this design exists to prevent.
 */
export function sweepSideRuns(stateDir: string, nowMs: number): SweepAction[] {
  const actions: SweepAction[] = [];
  for (const { slotName, slot, pending } of listPendingSlots(stateDir)) {
    if (!pending || typeof pending.admissionId !== 'string') {
      actions.push({
        slotName,
        admissionId: (slot as { admissionId?: string })?.admissionId ?? '<unknown>',
        cronName: '<unknown>',
        verdict: { action: 'fallback', reason: 'slot_unreadable' as FallbackReason },
      });
      continue;
    }
    const verdict = classifySlot({
      slot,
      admissionId: pending.admissionId,
      nowMs,
      admittedAtMs: pending.admittedAtMs,
      deadlineMs: pending.deadlineMs,
    });
    if (verdict.action === 'wait') continue;
    actions.push({
      slotName,
      admissionId: pending.admissionId,
      cronName: pending.cronName,
      verdict,
      cronPrompt: pending.cronPrompt,
      continuationPrompt: pending.continuationPrompt,
    });
  }
  return actions;
}
