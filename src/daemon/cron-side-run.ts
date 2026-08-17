/**
 * Claude-side cheap-model side-runs for mechanical crons.
 *
 * v1 (cron-model-routing.ts) routes codex-app-server heartbeat crons by swapping
 * the model at spawn. The claude runtime cannot do that: `--model` is passed once
 * per session and `mode === "continue"` resumes it, so a chore firing into the
 * persistent session pays the frontier model AND the accumulated context every
 * time. The expensive part is the vehicle, not the chore.
 *
 * This module decides whether a cron fire may run as a short-lived headless
 * side-run instead, and owns the outcome contract that makes that safe.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * THE CENTRAL PROPERTY: SILENCE IS THE ALARM, NOT A PASS
 *
 * A side-run can die between producing a verdict and delivering it. If that
 * reads as success, the check silently stopped happening — which is the exact
 * failure this is supposed to avoid, relocated rather than removed.
 *
 * So the scheduler writes an EMPTY outcome slot at admission, the side-run's
 * only job is to fill it, and a slot still empty at the deadline IS the signal
 * to fall back to normal main-session injection. Absence triggers the fallback
 * rather than resembling a clean result.
 *
 * Everything unparseable, unknown, or late is treated as a fallback for the same
 * reason. There is no path where "I could not tell" reads as "nothing to do".
 * ────────────────────────────────────────────────────────────────────────────
 *
 * Eligibility is deliberately narrower than "chore-shaped". See ELIGIBLE.
 */

import { createHash } from 'crypto';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import type { CronDefinition } from '../types/index.js';
import {
  HEARTBEAT_COLLECTION_AUTHORITY_BASE64,
  HEARTBEAT_COLLECTION_AUTHORITY_SHA256,
} from './heartbeat-collection-authority.js';

/** Cheap model used for side-runs. Pinned here, never read from cron text. */
export const SIDE_RUN_MODEL = 'claude-haiku-4-5-20251001' as const;

/**
 * How long the scheduler waits for a side-run to fill its slot before falling
 * back to main-session injection. Generous: a slow chore that still answers is
 * cheaper than a duplicate main-session fire.
 */
export const SIDE_RUN_DEADLINE_MS = 120_000;

/**
 * Crons approved to run as side-runs, pinned by SHA-256 of the exact reviewed
 * prompt.
 *
 * Pinning by hash rather than by name is the whole safety story: editing a
 * cron's prompt silently changes what the cheap model is asked to do, and the
 * edit that makes a chore judgment-shaped looks identical to one that fixes a
 * typo. A changed prompt stops matching and the cron simply goes back to the
 * main session — fail-closed, no alarm needed.
 *
 * ELIGIBILITY RULE (worker 2026-08-07, adopted by coordinator):
 *   A cron whose prompt contains a warning about a past misjudgment is by
 *   definition NOT mechanical. The warning exists because judgment was required
 *   and got it wrong. coordinator's inbox-sweep is the worked example and is
 *   permanently ineligible: its prompt documents 2026-07-16, when a capped
 *   20-message window was treated as the whole inbox and 216 unread sat behind
 *   it while sweeps reported "all noise, nothing needs you". Routing that to a
 *   cheap model recreates the original defect structurally.
 */
export interface EligibleEntry {
  cronName: string;
  promptSha256: string;
  /** Why this one is mechanical, in the reviewer's words. */
  rationale: string;
  /**
   * Agent whose cron this is. Present when the pin is agent-specific, which it
   * must be for any cron whose instructions live in a per-agent file.
   */
  agent?: string;
  /**
   * Path, relative to the agent directory, of the file the prompt delegates to.
   *
   * A prompt like "Read and follow .claude/skills/heartbeat/SKILL.md" carries no
   * instructions of its own — hashing it pins the POINTER while the instructions
   * change freely. Routing such a cron requires pinning the referenced file too,
   * or the fail-closed story does not apply to it at all.
   */
  referencedFile?: string;
  /** sha256 of the reviewed contents of referencedFile. */
  fileSha256?: string;
  /**
   * Prompt the side-run actually runs, when the cron's own prompt is a pointer
   * and therefore cannot be handed to a cheap model directly. Frozen and pinned
   * like the codex authority: a substitute read from disk at fire time would be
   * the one unpinned instruction path in a design built to pin them.
   */
  substitutePrompt?: string;
  /**
   * True when this cron has no clean-and-done outcome and the escalation IS the
   * designed continuation rather than an anomaly signal.
   */
  alwaysEscalate?: boolean;
  /**
   * Directive delivered to the main session AHEAD of the collected summary.
   *
   * For an anomaly-shaped cron the summary is self-describing: it is an alarm,
   * and the main session's whole job is to judge it. For a handoff-shaped cron
   * it is not. The instructions saying what the main session still owes live in
   * the SIDE-RUN's prompt, which the main session never sees; all it receives is
   * a banner and some counts, and "you own the stamp" names an owner rather than
   * the remaining work. A session that files that as a status report has read it
   * reasonably.
   *
   * The codex path for this same cron already states the directive outright
   * (HEARTBEAT_SOL_CONTINUATION in cron-model-routing.ts). Leaving the claude
   * path to inference is an asymmetry, not a considered difference.
   *
   * Absent means today's behaviour exactly: banner plus summary, nothing else.
   */
  continuationPrompt?: string;
}

/**
 * Inverse of HEARTBEAT_SOL_CONTINUATION on the one point that matters. The codex
 * preflight STAMPS the heartbeat before handing off; this one deliberately does
 * not, so the same continuation text would be actively wrong here.
 *
 * The skill-file warning is load-bearing rather than advisory: editing that file
 * breaks its pin, which returns the cron to the main session. That is the design
 * working, but a session that edits the file while completing a heartbeat would
 * silently switch routing off for itself and never know it.
 */
const HEARTBEAT_CLAUDE_CONTINUATION = [
  'This is a mid-procedure handoff, not a status report.',
  'A cheap read-only preflight collected the state below. It performed NO writes and did NOT update the heartbeat.',
  'Read HEARTBEAT.md and complete every remaining heartbeat requirement, including stamping the heartbeat yourself.',
  'Own all interpretation, communication, memory updates, decisions, and priority task work in this turn.',
  'Do not assume the collected output is complete or sufficient, and rerun a collection command when verification requires it.',
  'Do NOT edit the pinned heartbeat skill file; editing it disables this routing for you silently.',
].join('\n');

export const ELIGIBLE: ReadonlyArray<EligibleEntry> = [
  {
    cronName: 'voice-watch',
    // Re-pinned 2026-08-07 after a reviewed prompt change (David policy: a missed
    // call with no voicemail and no text is clean and is never escalated or
    // answered). The previous pin was dc43d9ab…; it stopped matching the moment
    // the prompt changed, which is the mechanism working — an edited prompt
    // returns the cron to the main session until a reviewer re-pins it.
    promptSha256: 'ef4ed620d7dc03e4d348b1aa1919bb47e9bcc24f2dffda8120ad2067f08ab004',
    rationale:
      'runs a script and the entire judgment is "did it print clean"; 34 fires/day, binary by construction',
  },
  // Heartbeat collection, one entry per agent.
  //
  // The cron PROMPT is byte-identical across all three agents
  // ("Read and follow .claude/skills/heartbeat/SKILL.md"), so a prompt hash alone
  // distinguishes nothing and pins nothing that matters. Each entry pins its OWN
  // agent's instruction file: a fleet-wide skill edit breaks all three at once, a
  // single-agent edit breaks exactly that one, and either way the affected
  // heartbeat returns to its main session until re-reviewed.
  //
  // These carry a SUBSTITUTE prompt because the cron's own prompt is a pointer and
  // cannot be handed to a cheap model. The substitute is frozen and pinned.
  {
    cronName: 'heartbeat',
    agent: 'coordinator',
    promptSha256: 'd203e0a76705fac4b045e2af30384c758bedc55cddf417d9c7d55bf0df8bfa5e',
    referencedFile: '.claude/skills/heartbeat/SKILL.md',
    fileSha256: 'ee3f04d098618d165c2265ad331f9f0514ecdf38717d67fa09f6ffabf4730aa8',
    substitutePrompt: Buffer.from(HEARTBEAT_COLLECTION_AUTHORITY_BASE64, 'base64').toString('utf8'),
    alwaysEscalate: true,
    continuationPrompt: HEARTBEAT_CLAUDE_CONTINUATION,
    rationale:
      'collection only: reads inbox, tasks, approvals, goals and sizes; writes nothing and always escalates so the main session performs the stamp, the judgment and every write',
  },
  {
    cronName: 'heartbeat',
    agent: 'worker',
    promptSha256: 'd203e0a76705fac4b045e2af30384c758bedc55cddf417d9c7d55bf0df8bfa5e',
    referencedFile: '.claude/skills/heartbeat/SKILL.md',
    fileSha256: 'ee3f04d098618d165c2265ad331f9f0514ecdf38717d67fa09f6ffabf4730aa8',
    substitutePrompt: Buffer.from(HEARTBEAT_COLLECTION_AUTHORITY_BASE64, 'base64').toString('utf8'),
    alwaysEscalate: true,
    continuationPrompt: HEARTBEAT_CLAUDE_CONTINUATION,
    rationale:
      'collection only: reads inbox, tasks, approvals, goals and sizes; writes nothing and always escalates so the main session performs the stamp, the judgment and every write',
  },
  {
    cronName: 'heartbeat',
    agent: 'analyst',
    promptSha256: 'd203e0a76705fac4b045e2af30384c758bedc55cddf417d9c7d55bf0df8bfa5e',
    referencedFile: '.claude/skills/heartbeat/SKILL.md',
    fileSha256: 'ee3f04d098618d165c2265ad331f9f0514ecdf38717d67fa09f6ffabf4730aa8',
    substitutePrompt: Buffer.from(HEARTBEAT_COLLECTION_AUTHORITY_BASE64, 'base64').toString('utf8'),
    alwaysEscalate: true,
    continuationPrompt: HEARTBEAT_CLAUDE_CONTINUATION,
    rationale:
      'collection only: reads inbox, tasks, approvals, goals and sizes; writes nothing and always escalates so the main session performs the stamp, the judgment and every write',
  },
];

export interface SideRunRouting {
  model: typeof SIDE_RUN_MODEL;
  cronName: string;
  source: 'daemon-cron-side-run';
  reason: 'reviewed_mechanical_side_run';
  promptSha256: string;
}

export interface SideRunPlan {
  routing: SideRunRouting;
  /** Identity of the admission this side-run belongs to. Also the slot key. */
  admissionId: string;
  deadlineMs: number;
  /**
   * The instructions the side-run actually runs: the cron's own prompt, or the
   * frozen substitute when the cron prompt is a pointer.
   */
  prompt: string;
  /** No clean-and-done outcome; the escalation is the designed continuation. */
  alwaysEscalate: boolean;
  /**
   * Directive to deliver ahead of the collected summary, when this cron has one.
   *
   * Resolved at ADMISSION and carried in the slot rather than looked up when the
   * escalation is actioned. A registry edit between admission and sweep would
   * otherwise change what an in-flight fire says about itself — the same reason
   * the substitute prompt travels in the slot instead of being re-read.
   */
  continuationPrompt?: string;
}

export interface ResolveSideRunInput {
  cron: Pick<CronDefinition, 'name' | 'prompt'>;
  runtime: string | undefined;
  /** The scheduler's stable per-admission identity (attemptIso-derived). */
  admissionId: string;
  /** Set false to disable side-runs entirely without redeploying logic. */
  enabled?: boolean;
  /** Agent this fire belongs to. Required to match an agent-specific pin. */
  agent?: string;
  /** Agent directory, used to resolve and hash a referenced instruction file. */
  agentDir?: string;
  /**
   * Registry override. Defaults to ELIGIBLE.
   *
   * Exists so the accept path is testable against a known positive. Without it
   * every test would assert a rejection, and a gate that never opens would pass
   * all of them — the failure this repo keeps finding, where a check that cannot
   * succeed looks identical to one that correctly declines.
   */
  registry?: typeof ELIGIBLE;
}

export function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * Returns a plan only when every condition holds. Every rejection returns null,
 * meaning "use the normal main-session path" — the same fail-closed shape as
 * resolveCodexCronRouting, so a bug here degrades to today's behaviour rather
 * than to a skipped check.
 */
/**
 * Why a candidate cron was NOT routed.
 *
 * Exists because a rejection produced NO telemetry at all: a fallback is
 * counted, but a decline-at-admission was silent, so routing could switch
 * itself off fleet-wide (2026-08-09, shared-skill edit) and the only signal was
 * the SHAPE of the prompt a human happened to notice. Absence of routing has to
 * be as countable as absence of an answer.
 */
export type SideRunDeclineReason =
  | 'disabled'
  | 'runtime_not_claude'
  | 'no_admission_id'
  | 'empty_prompt'
  | 'not_in_registry'
  | 'prompt_hash_mismatch'
  | 'pin_incomplete'
  | 'referenced_file_missing'
  | 'referenced_file_unreadable'
  | 'referenced_file_hash_mismatch'
  | 'substitute_hash_mismatch';

export interface SideRunResolution {
  plan: SideRunPlan | null;
  /** Set whenever plan is null. */
  reason?: SideRunDeclineReason;
  /** True when this cron NAME is in the registry, i.e. it was a candidate.
   *  Lets the caller log declines for crons that SHOULD route and stay silent
   *  about the ordinary ones, so the event means something. */
  candidate: boolean;
}

/**
 * Full resolution with a decline reason. resolveSideRunRouting wraps this and
 * keeps the original null-or-plan shape for existing callers, so there is ONE
 * implementation of the checks and the reason cannot drift from the decision.
 */
export function resolveSideRunResolution(input: ResolveSideRunInput): SideRunResolution {
  const registry = input.registry ?? ELIGIBLE;
  const named = registry.some((e) => e.cronName === input.cron.name);
  const no = (reason: SideRunDeclineReason): SideRunResolution =>
    ({ plan: null, reason, candidate: named });

  if (input.enabled === false) return no('disabled');
  // Side-runs exist because the claude runtime cannot switch model per turn.
  // Other runtimes have their own path and must not be silently captured here.
  if (input.runtime !== 'claude-code') return no('runtime_not_claude');
  if (!input.admissionId) return no('no_admission_id');

  const prompt = input.cron.prompt;
  if (typeof prompt !== 'string' || prompt.length === 0) return no('empty_prompt');

  const entry = registry.find((e) =>
    e.cronName === input.cron.name && (e.agent === undefined || e.agent === input.agent));
  if (!entry) return no('not_in_registry');

  // Exact reviewed prompt or nothing. An edited prompt is an unreviewed prompt.
  if (sha256(prompt) !== entry.promptSha256) return no('prompt_hash_mismatch');

  // A delegating prompt carries no instructions, so the pin must cover the file
  // it points at. Without this the hash proves only that the POINTER is unchanged
  // while the instructions behind it move freely.
  if (entry.referencedFile) {
    if (!entry.fileSha256 || !input.agentDir) return no('pin_incomplete');
    const filePath = join(input.agentDir, entry.referencedFile);
    let contents: Buffer;
    try {
      if (!existsSync(filePath)) return no('referenced_file_missing');
      contents = readFileSync(filePath);
    } catch {
      // Unreadable is UNKNOWN, and unknown must not read as unchanged.
      return no('referenced_file_unreadable');
    }
    if (createHash('sha256').update(contents).digest('hex') !== entry.fileSha256) {
      return no('referenced_file_hash_mismatch');
    }
  }

  // A substitute must itself be pinned, or it becomes the one unpinned
  // instruction path in a design whose entire purpose is pinning them.
  if (entry.substitutePrompt) {
    if (sha256(entry.substitutePrompt) !== HEARTBEAT_COLLECTION_AUTHORITY_SHA256) {
      return no('substitute_hash_mismatch');
    }
  }

  return {
    candidate: true,
    plan: {
      routing: {
        model: SIDE_RUN_MODEL,
        cronName: input.cron.name,
        source: 'daemon-cron-side-run',
        reason: 'reviewed_mechanical_side_run',
        promptSha256: entry.promptSha256,
      },
      admissionId: input.admissionId,
      deadlineMs: SIDE_RUN_DEADLINE_MS,
      prompt: entry.substitutePrompt ?? prompt,
      alwaysEscalate: entry.alwaysEscalate === true,
      continuationPrompt: entry.continuationPrompt,
    },
  };
}

/** Unchanged contract for existing callers: a plan, or null to route home. */
export function resolveSideRunRouting(input: ResolveSideRunInput): SideRunPlan | null {
  return resolveSideRunResolution(input).plan;
}

/**
 * The exact text an escalation delivers to the main session.
 *
 * Lives here rather than at the injection site so it can be asserted directly:
 * the property that matters is what the session RECEIVES, and a test that only
 * checks an event fired proves nothing about that.
 *
 * With no continuation this returns byte-for-byte what the escalation path
 * produced before continuations existed, so a cron that does not declare one is
 * untouched by this mechanism.
 */
export function buildEscalationInjection(input: {
  cronName: string;
  summary: string;
  continuationPrompt?: string;
}): string {
  const banner = `[CRON ESCALATION] ${input.cronName}`;
  if (!input.continuationPrompt) return `${banner}\n${input.summary}`;
  // Directive first. A reader who stops early must hit the instruction, not the
  // counts; the counts are the evidence for work the directive is asking for.
  return `${banner}\n${input.continuationPrompt}\n\n[COLLECTED]\n${input.summary}`;
}

/* ── outcome slot ───────────────────────────────────────────────────────── */

/** What a side-run writes. Anything else is treated as no answer at all. */
export interface SideRunSlot {
  admissionId: string;
  status: 'pending' | 'clean' | 'escalate';
  /** Present only for 'escalate'. Injected into the main session verbatim. */
  summary?: string;
  writtenAtMs?: number;
}

export type SlotVerdict =
  /** Side-run still running and inside its deadline. Do nothing yet. */
  | { action: 'wait' }
  /** Chore ran, found nothing. Fire is complete. No main-session cost. */
  | { action: 'done'; reason: 'clean' }
  /** Chore found something needing judgment. Inject summary into main session. */
  | { action: 'escalate'; summary: string }
  /**
   * No usable answer. Fall back to normal main-session injection, exactly as if
   * side-runs did not exist. MUST be counted and logged by the caller: an
   * invisible fallback means routing looks successful while doing nothing.
   */
  | { action: 'fallback'; reason: FallbackReason };

export type FallbackReason =
  | 'deadline_expired'   // slot never filled — the silence case this exists for
  | 'slot_missing'       // slot vanished or was never written
  | 'slot_unreadable'    // present but not parseable as a slot
  | 'identity_mismatch'  // slot belongs to a different admission
  | 'unknown_status'     // a status this version does not understand
  | 'escalate_no_summary'; // escalation with nothing to escalate

/**
 * Pure decision over a slot. No I/O, no clock — the caller supplies both, so
 * every branch here is directly testable including the ones that only happen
 * when something has gone wrong.
 */
export function classifySlot(args: {
  slot: unknown;
  admissionId: string;
  nowMs: number;
  admittedAtMs: number;
  deadlineMs: number;
}): SlotVerdict {
  const { slot, admissionId, nowMs, admittedAtMs, deadlineMs } = args;
  const expired = nowMs - admittedAtMs >= deadlineMs;

  if (slot === null || slot === undefined) {
    // Missing before the deadline is still "running"; after it, it is silence.
    return expired ? { action: 'fallback', reason: 'slot_missing' } : { action: 'wait' };
  }
  if (typeof slot !== 'object' || Array.isArray(slot)) {
    return { action: 'fallback', reason: 'slot_unreadable' };
  }

  const s = slot as Partial<SideRunSlot>;
  if (s.admissionId !== admissionId) {
    // A slot from another fire must never satisfy this one. Without this check a
    // stale clean result could close a fire whose chore never ran.
    return { action: 'fallback', reason: 'identity_mismatch' };
  }

  switch (s.status) {
    case 'clean':
      return { action: 'done', reason: 'clean' };
    case 'escalate':
      if (typeof s.summary !== 'string' || s.summary.trim().length === 0) {
        // Escalating nothing would inject an empty prompt into the main session
        // and look like a handled fire. Fall back so a human-shaped path runs.
        return { action: 'fallback', reason: 'escalate_no_summary' };
      }
      return { action: 'escalate', summary: s.summary };
    case 'pending':
      return expired ? { action: 'fallback', reason: 'deadline_expired' } : { action: 'wait' };
    default:
      // Unknown status, including a future version's. Never guess.
      return { action: 'fallback', reason: 'unknown_status' };
  }
}

/**
 * Prompt handed to the headless side-run. It must answer in a shape
 * classifySlot understands, and must not attempt judgment: anything other than
 * a clean result escalates to the main session, which is where judgment lives.
 */
export function buildSideRunPrompt(cronPrompt: string): string {
  return [
    '[SIDE-RUN] You are a short-lived mechanical check. You have no session history and no memory.',
    'Run the check below exactly as written. Do NOT triage, interpret, or act on what you find.',
    '',
    'Answer with:',
    '  CLEAN                 if the check reports nothing needing attention',
    '  ESCALATE: <summary>   if it reports anything at all, including errors',
    '',
    'If you are unsure which applies, answer ESCALATE. Escalating a clean result costs one',
    'main-session fire. Reporting CLEAN for something real means nobody ever sees it.',
    '',
    // The summary may be structured — counts, ages, per-item lines. That drift
    // happened on its own because structure IS more useful than a sentence, so
    // it is legalised here rather than fought. What is constrained below are TWO
    // SEPARATE failure modes, observed on 2026-08-11, which need separate rules
    // because neither prevents the other:
    //
    //   MODE 1, cross-record drift. A side-run reported a task "24.3 days old"
    //   while naming a task ID created 16h earlier. The age was real — it
    //   belonged to a DIFFERENT task, the stale one that task was about.
    //
    //   MODE 2, estimation. A later block reported an approval "1h old" and
    //   goals "updated 16m ago" when both were 8h. Those values were bound to
    //   the CORRECT identifiers — Rule 1 would not have caught it. They were
    //   simply not read.
    //
    // AMENDED 2026-08-13 after a Codex review found the original Rule 3 made the
    // pinned heartbeat collection UNSATISFIABLE: that spec REQUIRES task and
    // approval ages, which can only come from arithmetic on timestamps, while the
    // rule forbade computing. Worse, the task command ran in default text mode,
    // which carries no created_at at all — so there was no readable input to
    // compute from even in principle. The side-run had to either violate a
    // mandatory rule or omit mandatory data, and the observed anomalies (a
    // timestamp derived from a task ID, two refusals, and one fabricated
    // timestamp) were all it resolving that impossible position. The collection
    // spec now requests --format json so the input exists; this rule now permits
    // the arithmetic while still forbidding invention.
    //
    // Evidence that Rule 2 is the load-bearing one: across four routed blocks
    // that day, the three that carried the raw source beside the derived value
    // were correct, and the one that omitted it was wrong twice. Writing the
    // source appears to force reading the record; omitting it permits recalling.
    'RULES FOR THE SUMMARY — all three mandatory, none substitutes for another:',
    '',
    '  RULE 1 (attribution). Attribute every value to the identifier you read it',
    '  FROM. Never pair an identifier with a value read from a different record,',
    '  even when one record references the other. Prevents cross-record drift.',
    '',
    '  RULE 2 (raw source beside derived). For any DERIVED value — an age, an',
    '  elapsed time, a countdown — carry the raw source value with it:',
    '      "task_X (created 2026-08-10T23:21:42Z, ~16h old)"',
    '  Not the identifier alone: the SOURCE TIMESTAMP ITSELF. Prevents estimation,',
    '  lets the reader re-derive, and makes a wrong value self-contradicting on',
    '  sight rather than merely plausible.',
    '',
    '  RULE 3 (calculation is allowed; estimation is not). Arithmetic ON A VALUE',
    '  YOU READ is fine and often required — an age is created_at subtracted from',
    '  now, and reporting it is calculation, not invention. What is forbidden is',
    '  producing a number when you did NOT read its input: no guessing from an',
    '  identifier, no recalling, no plausible-looking figure. If the input is not',
    '  in the output you were given, SAY SO instead of supplying a number, and say',
    '  which command would carry it.',
    '',
    '--- CHECK ---',
    cronPrompt,
  ].join('\n');
}

/** Parse a side-run's stdout into a slot. Anything unrecognised stays unusable. */
export function parseSideRunOutput(admissionId: string, stdout: string, nowMs: number): SideRunSlot {
  const text = (stdout ?? '').trim();
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);

  // Scan from the END for the last line that STARTS a verdict, then keep
  // everything from there onward as the summary.
  //
  // The first version read only the last non-empty line. That is correct for a
  // one-word CLEAN, and wrong for any multi-line escalation: the heartbeat
  // collection summary is inherently several lines (banner, then counts), so its
  // last line is a detail row, no verdict matched, and every heartbeat preflight
  // would have parsed as `pending` and fallen back forever — routing that looked
  // enabled while nothing was ever routed. Caught by the heartbeat integration
  // test, which is the reason it exists.
  let verdictIdx = -1;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (/^(clean\b|escalate\s*:?)/i.test(lines[i])) { verdictIdx = i; break; }
  }
  const last = verdictIdx >= 0 ? lines[verdictIdx] : (lines[lines.length - 1] ?? '');
  const tail = verdictIdx >= 0 ? lines.slice(verdictIdx).join('\n') : '';

  if (/^clean\b/i.test(last)) {
    return { admissionId, status: 'clean', writtenAtMs: nowMs };
  }
  const esc = tail.match(/^escalate\s*:?\s*([\s\S]*)$/i);
  if (esc) {
    const summary = esc[1]?.trim();
    return {
      admissionId,
      status: 'escalate',
      // An ESCALATE with no text still escalates; classifySlot falls back rather
      // than injecting nothing, and the raw tail is kept for the log.
      summary: summary && summary.length > 0 ? summary : '',
      writtenAtMs: nowMs,
    };
  }
  // Unrecognised output is NOT clean. Leave it pending so the deadline path
  // decides, which routes to fallback rather than to a fabricated verdict.
  return { admissionId, status: 'pending', writtenAtMs: nowMs };
}
