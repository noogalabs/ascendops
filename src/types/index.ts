// cortextOS Node.js - Core Type Definitions
// These types match the bash version's JSON formats exactly for backward compatibility

import type { ShiftSchedule } from '../daemon/shift.js';

export type { ShiftSchedule };

export type Priority = 'urgent' | 'high' | 'normal' | 'low';

export const PRIORITY_MAP: Record<Priority, number> = {
  urgent: 0,
  high: 1,
  normal: 2,
  low: 3,
};

export const VALID_PRIORITIES: Priority[] = ['urgent', 'high', 'normal', 'low'];

// Message Bus Types

export interface InboxMessage {
  id: string;
  from: string;
  to: string;
  priority: Priority;
  timestamp: string; // ISO 8601
  text: string;
  reply_to: string | null;
  sig?: string; // Security (H10): HMAC-SHA256 signature — optional for backwards compat
}

// Task Types

export type TaskStatus = 'pending' | 'in_progress' | 'completed' | 'blocked' | 'cancelled';

export interface TaskOutput {
  /** Output kind. "file" links to a saved deliverable; other shapes reserved. */
  type: 'file';
  /** For type:"file", the path to the file relative to CTX_ROOT (forward-slash separated). */
  value: string;
  /** Optional human-readable label shown in dashboard task detail. */
  label?: string;
}

export interface Task {
  id: string;
  title: string;
  description: string;
  type: 'agent' | 'human';
  needs_approval: boolean;
  status: TaskStatus;
  assigned_to: string;
  created_by: string;
  org: string;
  priority: Priority;
  project: string;
  kpi_key: string | null;
  created_at: string; // ISO 8601
  updated_at: string; // ISO 8601
  completed_at: string | null;
  due_date: string | null;
  archived: boolean;
  result?: string;
  /** Linked deliverables (files saved via `cortextos bus save-output`). */
  outputs?: TaskOutput[];
  /**
   * Dependency DAG edges (beads-inspired). Optional so existing task
   * files remain valid with these fields absent. `blocked_by` lists
   * task IDs that must reach `completed` before this task can
   * progress; `blocks` is the reverse view, maintained symmetrically
   * at create-time so queries in either direction are cheap.
   */
  blocks?: string[];
  blocked_by?: string[];
}

// Event Types

export type EventCategory =
  | 'action'
  | 'error'
  | 'metric'
  | 'milestone'
  | 'heartbeat'
  | 'message'
  | 'task'
  | 'approval'
  | 'agent_activity';

export type EventSeverity = 'info' | 'warning' | 'error' | 'critical';

export interface Event {
  id: string;
  agent: string;
  org: string;
  timestamp: string; // ISO 8601
  category: EventCategory;
  event: string;
  severity: EventSeverity;
  metadata: Record<string, unknown>;
}

// Heartbeat Types

export interface Heartbeat {
  agent: string;
  org: string;
  display_name?: string; // user-configured name from IDENTITY.md (e.g. "Alpha", "Beta")
  status: string;
  current_task: string;
  mode: 'day' | 'night';
  last_heartbeat: string; // ISO 8601
  loop_interval: string;
  // Legacy field — sync.ts falls back to this if last_heartbeat absent
  timestamp?: string;
}

// Approval Types

export type ApprovalCategory =
  | 'external-comms'
  | 'financial'
  | 'deployment'
  | 'data-deletion'
  | 'other';

export type ApprovalStatus = 'pending' | 'approved' | 'rejected';

export interface Approval {
  id: string;
  title: string;
  requesting_agent: string;
  org: string;
  category: ApprovalCategory;
  status: ApprovalStatus;
  description: string;
  created_at: string;
  updated_at: string;
  resolved_at: string | null;
  resolved_by: string | null;
}

// Agent Config Types (config.json)

export interface EcosystemFeatureConfig {
  enabled?: boolean;
}

export interface LocalVersionControlFeatureConfig extends EcosystemFeatureConfig {
  /** Persistent single-writer lease duration: 5-60 minutes, default 10. */
  lease_ttl_ms?: number;
}

export interface EcosystemConfig {
  /** Daily git snapshots of agent workspace. Agent stages safe files, reviews diff, commits. */
  local_version_control?: LocalVersionControlFeatureConfig;
  /** 24h cron to check canonical repo for framework updates. Requires upstream git remote. */
  upstream_sync?: EcosystemFeatureConfig;
  /** Weekly cron to browse community catalog and surface new skills/templates to user. */
  catalog_browse?: EcosystemFeatureConfig;
  /** On-demand workflow to publish custom skills/templates to the community catalog. */
  community_publish?: EcosystemFeatureConfig;
}

// Comms-Lint Configuration Types (per-org context.json + per-agent config.json)

/**
 * A single configurable comms-lint rule expressed in JSON. Because JSON cannot
 * hold a native RegExp, the pattern is carried as a source string plus optional
 * flags. The loader (`src/bus/comms-lint-config.ts`) compiles these safely and
 * fails open — any rule that is malformed (bad id, bad flags, over-length, or an
 * uncompilable pattern) is silently dropped without affecting the others.
 */
export interface CommsLintRuleSpec {
  /** Stable identifier used for allowlist removal. Must match /^[a-z0-9:_-]+$/. */
  id: string;
  /**
   * Regex source as a string (compiled by the loader). Max length 1000.
   *
   * SECURITY: this is operator-authored and compiled with `new RegExp`, then run
   * against every outbound message on the synchronous send path. Config authors
   * are trusted; the 1000-char cap bounds memory/pattern size, NOT catastrophic
   * backtracking. A pathological pattern can cause ReDoS and hang sends, so avoid
   * nested quantifiers like `(a+)+`. Keep patterns simple.
   */
  pattern: string;
  /** Regex flags; subset of "gimsuy". Defaults to "i" (case-insensitive) to match the hardcoded defaults. */
  flags?: string;
  /** Human-readable explanation of why the phrase is blocked. */
  reason: string;
  /** Optional rewrite hint surfaced by --suggest dry-run mode. */
  suggest?: string;
}

/**
 * Per-group configuration. The three keys are deliberately distinct operations so
 * intent is never ambiguous:
 *   - `replace`: discard ALL hardcoded defaults for this group and use only these rules.
 *   - `add`: append new rules to the resolved set for this group.
 *   - `allow`: remove rules (defaults or added) whose id matches exactly (allowlist).
 * Intra-group resolution order is fixed: replace -> add -> allow.
 */
export interface CommsLintGroupConfig {
  /** Discard defaults for this group, use only these rules. */
  replace?: CommsLintRuleSpec[];
  /** Append these rules to the group. */
  add?: CommsLintRuleSpec[];
  /** Remove rules by exact id (allowlist). Runs last, so it can strip an added/replaced rule too. */
  allow?: string[];
}

/**
 * The `comms_lint` config block, valid on both OrgContext and AgentConfig.
 *
 * Precedence is total and unambiguous: agent config overrides org config overrides
 * hardcoded defaults. Within each layer, per-group operations apply in the order
 * replace -> add -> allow. Missing or malformed config fails open to defaults.
 *
 * `add_active_context` / `add_next_signal_context` only EXTEND the passive-group
 * context allowers (OR-ed onto the default regex). There is intentionally no
 * `replace` for them — to permit a passive phrase, allowlist the specific passive
 * rule instead of weakening the context allower wholesale.
 */
export interface CommsLintConfig {
  /** Hard-fail base posture patterns (was BANNED_POSTURE_PATTERNS). */
  banned?: CommsLintGroupConfig;
  /** Soft posture patterns gated by active/next-signal context (was PASSIVE_POSTURE_PATTERNS). */
  passive?: CommsLintGroupConfig;
  /** Telegram-only banned patterns (was TELEGRAM_BANNED_PATTERNS). */
  telegram?: CommsLintGroupConfig;
  /** Agent-name gate. `allow:["agent-name:default"]` disables it. */
  agentName?: CommsLintGroupConfig;
  /** Extra regex sources OR-ed onto the active-work context allower. */
  add_active_context?: string[];
  /** Extra regex sources OR-ed onto the next-signal context allower. */
  add_next_signal_context?: string[];
}

export interface AgentConfig {
  startup_delay?: number;
  max_session_seconds?: number;
  max_crashes_per_day?: number;
  /**
   * Sliding-window crash-loop detector. When N crashes occur within the window,
   * the agent auto-pauses (status: 'halted') instead of retrying. Absent = legacy
   * daily counter only.
   */
  crash_window?: { seconds: number; max_crashes?: number };
  model?: string;
  /**
   * Whether to launch Claude Code with `--dangerously-skip-permissions`.
   * Defaults to true (back-compat: agents run unattended). Set to false to keep
   * Claude Code's permission system engaged so the PermissionRequest hook
   * (hook-permission-telegram) gates tool use instead of everything auto-running.
   * An explicitly present config field wins over the install-level consent
   * record in both directions. The record supplies this value only when the
   * field is omitted.
   * Only applies to the claude-code runtime (Hermes never passes the flag).
   */
  dangerously_skip_permissions?: boolean;
  /**
   * Cost tier for model routing: 'haiku' | 'sonnet' | 'opus'.
   * Ignored when `model` is set (explicit model takes precedence).
   * Resolved to a concrete model ID via model_tiers (or DEFAULT_MODEL_TIERS).
   */
  tier?: 'haiku' | 'sonnet' | 'opus';
  /**
   * Per-agent overrides for the tier→model ID mapping.
   * Merges on top of DEFAULT_MODEL_TIERS — only specify the tiers you want to override.
   */
  model_tiers?: { haiku?: string; sonnet?: string; opus?: string };
  /**
   * How long to pause (seconds) when an Anthropic rate-limit exit is detected,
   * before restarting the agent. Defaults to 18000 (5 hours) — the standard
   * Anthropic rolling rate-limit window. Rate-limit pauses do NOT count toward
   * max_crashes_per_day and do NOT trigger the git watchdog.
   */
  rate_limit_pause_seconds?: number;
  working_directory?: string;
  enabled?: boolean;
  crons?: CronEntry[];
  timezone?: string;
  day_mode_start?: string;
  day_mode_end?: string;
  /** Per-agent shift schedule per RFC rfc-shift-schedule.md §3. When absent, agent is always in_shift (24/7). */
  shift_schedule?: ShiftSchedule;
  communication_style?: string;
  /**
   * Display name for the business or team operating this agent.
   * When set, the dashboard sidebar and title show this name instead of "cortextOS".
   * Typically set by the onboarding wizard from the user's company name.
   */
  brand_name?: string;
  approval_rules?: {
    always_ask: string[];
    never_ask: string[];
  };
  ecosystem?: EcosystemConfig;
  gmail_watch?: {
    query: string;
    interval_ms?: number;
    processed_label_id?: string;
  };
  slack_watch?: {
    channel: string;
    interval_ms?: number;
  };
  trusted_slack_users?: string[];
  slack_channels?: Record<string, string>;
  /**
   * Human team members for Slack identity/trust resolution (P2). Per-agent
   * override; the canonical roster may also live on OrgContext.team_members.
   * Used to resolve a Slack handle -> trust_level when enriching inbound.
   */
  team_members?: TeamMember[];
  /** Context window % at which to warn agent + user. Default: 70. Absent = observe-only. */
  ctx_warning_threshold?: number;
  /** Context window % at which to inject handoff prompt and hard-restart. Default: 80. */
  ctx_handoff_threshold?: number;
  /** Context window % at which to trigger graceful restart (Signal 3). Default: 70. */
  ctx_restart_threshold?: number;
  /** Open-turn inactivity threshold in minutes. Default: 30. */
  turn_watchdog_threshold_minutes?: number;
  /**
   * Fallback context window cap (tokens) for codex-app-server agents when the
   * server's `thread/tokenUsage/updated` event reports `modelContextWindow=null`.
   * Defaults to 256000 when unset. Only applied to the codex-app-server runtime.
   */
  codex_context_cap?: number;
  /**
   * Fallback context window cap (tokens) for opencode agents when the OpenCode
   * model cache does not expose a context limit. Only applies to runtime:
   * 'opencode'.
   */
  opencode_context_cap?: number;
  /**
   * Agent runtime. Defaults to 'claude-code' when absent.
   * 'hermes' selects the HermesPTY spawn path (Python persistent REPL,
   * NousResearch/hermes-agent) with Hermes-specific bootstrap, session
   * continuity, and exit handling.
   * 'opencode' selects the OpencodePTY spawn path, a native PTY terminal
   * runtime for opencode.ai's OpenCode CLI.
   */
  runtime?: 'claude-code' | 'hermes' | 'codex-app-server' | 'opencode';
  /**
   * Optional OpenCode agent name to pass as `opencode --agent <name>`.
   * Only applies to runtime: 'opencode'.
   */
  opencode_agent?: string;
  /**
   * Vendor adapter for the underlying CLI binary. Defaults to 'anthropic'
   * when absent (which spawns the `claude` CLI). MVP supports anthropic only;
   * 'openai' and 'google' adapters land in subsequent migration steps.
   * Only meaningful when `runtime` is unset or 'claude-code' — Hermes runtime
   * uses its own override path in HermesPTY.
   */
  vendor?: 'anthropic' | 'openai' | 'google';
  /**
   * Whether this agent runs a Telegram poller. Defaults to true when absent
   * (preserves existing behaviour). Set to false on specialist agents that
   * should not own a Telegram bot — only the designated orchestrator agent
   * should poll. Requires BOT_TOKEN + CHAT_ID to already be unset or the
   * poller will be skipped regardless.
   */
  telegram_polling?: boolean;
  /** Per-agent comms-lint config. Overrides org-level and hardcoded defaults. */
  comms_lint?: CommsLintConfig;
}

export interface CronEntry {
  name: string;
  /**
   * Operator switch. `false` means DO NOT ARM THIS CRON, whatever `type` says.
   *
   * Undeclared until 2026-08-12, which is the whole defect: operators wrote
   * `enabled: false` into config.json, TypeScript could not see the field, and
   * `convertEntry` hardcoded `enabled: true` on the way to crons.json. Since
   * config.json is reconciled into crons.json on EVERY AGENT BOOT (#125), every
   * boot silently re-armed every cron an operator had switched off.
   *
   * It surfaced when an agent hardened cash's config with `enabled: false` on five
   * proactive crons specifically so a fleet restart could not re-arm them; the
   * restart re-armed all five. Zero prohibited fires only because cash noticed
   * and re-disabled them ~25 minutes before the next window.
   *
   * `type: "disabled"` was the only disable signal the reader honoured. Both are
   * legitimate ways to express intent, so both are honoured now.
   */
  enabled?: boolean;
  /** Human-readable purpose. Written by operators; previously dropped in migration. */
  description?: string;
  /** Why this cron was switched off. Written alongside `enabled: false`; previously dropped. */
  disabled_reason?: string;
  /** For recurring crons: how often to fire (e.g. "4h", "1d"). */
  interval?: string;
  /** For time-anchored crons: a cron expression (e.g. "0 8 * * *"). Takes precedence over interval. */
  cron?: string;
  /** For one-shot crons: ISO 8601 datetime when the cron should fire. */
  fire_at?: string;
  prompt: string;
  /** "recurring" (default) restores on every session start.
   *  "once" restores only if fire_at is still in the future; deleted after firing. */
  type?: 'recurring' | 'once' | 'disabled';
  /** @deprecated Never had a reader. Use `emergency_class` instead — a boolean
   *  cannot express "flood wakes this agent but a routine sweep does not", which
   *  is what the agent's `off_shift_can_wake_for` list is for. Declared 2026-xx,
   *  found unread and deprecated 2026-08-10 (Greenwood post-mortem). */
  emergency_allowed?: boolean;
  /** Emergency class for off-shift wake decisions, e.g. "flood", "no_heat_freezing".
   *  Wakes the agent when this value appears in its
   *  shift_schedule.emergency_override.off_shift_can_wake_for list. */
  emergency_class?: string;
  /** When true, this cron bypasses the daemon's off-shift suppression gate entirely
   *  (see CronDefinition.wake_on_fire). Propagated to crons.json by bus reload-crons. */
  wake_on_fire?: boolean;
}

// ---------------------------------------------------------------------------
// External Persistent Cron System — Subtask 1.1
// ---------------------------------------------------------------------------
//
// CronDefinition is the canonical record stored in per-agent crons.json files:
//   .cortextOS/state/agents/{agent_name}/crons.json
//
// The file is an array of CronDefinition objects.  The daemon reads it, schedules
// each enabled cron, and injects the prompt into the agent's PTY on schedule.
//
// Operators may edit crons.json by hand (it is intentionally human-readable).
// Keep all field names lowercase-snake-case and all times as ISO 8601 UTC.
//
// Example records
// ---------------
//
// Heartbeat — every 6 hours (interval shorthand):
// {
//   "name": "heartbeat",
//   "schedule": "6h",
//   "prompt": "Read HEARTBEAT.md and execute the heartbeat workflow.",
//   "enabled": true,
//   "created_at": "2026-04-01T00:00:00.000Z",
//   "description": "Periodic health check and status update."
// }
//
// Daily morning briefing — fixed local time via cron expression:
// {
//   "name": "morning-briefing",
//   "schedule": "0 13 * * *",
//   "prompt": "Prepare and send the morning briefing to James.",
//   "enabled": true,
//   "created_at": "2026-04-01T00:00:00.000Z",
//   "description": "Daily 09:00 ET briefing (UTC offset applied in schedule).",
//   "last_fired_at": "2026-04-28T13:00:01.042Z",
//   "fire_count": 14
// }
//
// Weekly report — cron expression with day-of-week restriction:
// {
//   "name": "weekly-report",
//   "schedule": "0 16 * * 1",
//   "prompt": "Compile and send the weekly performance report.",
//   "enabled": true,
//   "created_at": "2026-04-01T00:00:00.000Z",
//   "description": "Every Monday at 12:00 ET (16:00 UTC).",
//   "fire_count": 3
// }

/**
 * A single persistent cron definition stored in an agent's crons.json.
 *
 * Stored at: `.cortextOS/state/agents/{agent_name}/crons.json`
 *
 * The `schedule` field accepts two formats:
 *   - Interval shorthand: `"6h"`, `"30m"`, `"1d"`, `"2w"`
 *     Parsed by `parseDurationMs()` from `src/bus/cron-state.ts`.
 *   - Standard 5-field cron expression: `"0 8 * * *"`, `"0 0,6,12,18 * * *"` (every 6h)
 *     Evaluated by the daemon scheduler (Subtask 1.3).
 *
 * The daemon fires the cron by injecting `[CRON: {name}] {prompt}` into
 * the agent's PTY session.
 */
export interface CronDefinition {
  // ------------------------------------------------------------------
  // Required fields — must be present for the daemon to schedule this cron.
  // ------------------------------------------------------------------

  /**
   * Unique identifier for this cron within the agent.
   * Used as the key for lookups, updates, and deletions.
   * Must be unique per agent; slugs like "heartbeat" or "morning-briefing" are recommended.
   *
   * @example "heartbeat"
   * @example "morning-briefing"
   */
  name: string;

  /**
   * The prompt text injected into the agent PTY when the cron fires.
   * The daemon prepends `[CRON: {name}] ` automatically for traceability.
   *
   * @example "Read HEARTBEAT.md and execute the heartbeat workflow."
   */
  prompt: string;

  /**
   * When and how often this cron fires.
   *
   * Accepted formats:
   *   - Interval shorthand: `"6h"`, `"30m"`, `"1d"`, `"2w"`
   *     The cron fires every N units after its previous fire (or after daemon start
   *     if it has never fired).
   *   - 5-field cron expression: `"0 8 * * *"`, `"0 0,6,12,18 * * *"`, `"0 16 * * 1"`
   *     Evaluated against the daemon's wall clock (daemon timezone = server timezone).
   *
   * @example "6h"         — every six hours
   * @example "0 13 * * *" — daily at 13:00 UTC
   * @example "0 16 * * 1" — every Monday at 16:00 UTC
   */
  schedule: string;

  /**
   * Whether the daemon should fire this cron.
   * Set to `false` to pause a cron without deleting it.
   *
   * @default true
   */
  enabled: boolean;

  /**
   * ISO 8601 UTC timestamp of when this cron definition was created.
   * Set automatically by `cortextos bus add-cron`; operators should not modify this.
   *
   * @example "2026-04-01T00:00:00.000Z"
   */
  created_at: string;

  // ------------------------------------------------------------------
  // Optional fields — populated at runtime or by operators.
  // ------------------------------------------------------------------

  /**
   * ISO 8601 UTC timestamp of the most recent successful fire.
   * Updated by the daemon scheduler (Subtask 1.3) after each fire.
   * Absent when the cron has never fired.
   *
   * @example "2026-04-28T13:00:01.042Z"
   */
  last_fired_at?: string;

  /**
   * ISO 8601 UTC timestamp set by the scheduler IMMEDIATELY before it awaits
   * the onFire dispatch — i.e. before the agent has acked. On daemon crash
   * mid-fire, this lets `loadCrons` recompute `referenceMs` from the attempt
   * timestamp instead of the stale `last_fired_at`, preventing a double-fire
   * via the catch-up gate. Tradeoff: a fire whose dispatch genuinely failed
   * pre-crash will be skipped one window — preferable to guaranteed re-fire.
   */
  last_fire_attempted_at?: string;

  /**
   * Total number of times this cron has successfully fired.
   * Incremented by the daemon on each successful PTY injection.
   * Absent (or 0) when the cron has never fired.
   */
  fire_count?: number;

  /**
   * ISO 8601 UTC timestamp for one-shot crons — when the cron should fire once
   * and then be deleted. Mutually exclusive with recurring `schedule` semantics:
   * if `fire_at` is set, the daemon treats this as a one-shot regardless of
   * `schedule`. Used by `cron-health.ts` to flag never-fired one-shots that
   * are still inside their grace window as healthy rather than stale.
   *
   * @example "2026-05-15T14:00:00.000Z"
   */
  fire_at?: string;

  /**
   * Human-readable description of what this cron does.
   * Optional — for operator documentation and dashboard display.
   *
   * @example "Periodic health check and status update."
   */
  description?: string;
  /**
   * Why this cron is switched off. Mirrors `CronEntry.disabled_reason` so the
   * operator's stated reason survives the config -> crons.json reconcile.
   *
   * Added 2026-08-13: the field was declared on CronEntry but had no
   * counterpart here, so it was unrepresentable and every boot discarded it.
   * Declaring a field is not the same as preserving it.
   */
  disabled_reason?: string;

  /**
   * Arbitrary key-value pairs for agent-specific context.
   * Not interpreted by the daemon; surfaced in dashboard + execution logs.
   *
   * @example { "priority": "high", "source": "/loop" }
   */
  metadata?: Record<string, unknown>;

  /**
   * When true, the Test Fire button in the dashboard is disabled and the
   * IPC fire-cron handler refuses manual-trigger requests.
   *
   * Use this for crons that must only run on their schedule (e.g. crons
   * that do destructive operations or have strict rate-limit contracts).
   *
   * @default false (manual fire is allowed by default — opt-out model)
   */
  manualFireDisabled?: boolean;

  /**
   * When true, this cron bypasses the daemon's off-shift suppression gate
   * and fires even when the agent's shift_schedule evaluates to no_wake
   * or emergency_only. Use sparingly — for crons that must run on a fixed
   * wall-clock schedule regardless of agent shift state (e.g. detectors
   * whose downstream consumers expect a same-time output file every day).
   *
   * The suppression telemetry event `cron_suppressed_off_shift` is NOT
   * emitted when this flag is set — the fire proceeds normally.
   *
   * @default false (off-shift suppression applies — opt-out model)
   */
  wake_on_fire?: boolean;
  /**
   * Emergency class for CONDITIONAL off-shift wake, e.g. "flood", "fire",
   * "safety", "no_heat_freezing".
   *
   * SUPPRESSION HIERARCHY — exactly three outcomes, in this order:
   *   1. wake_on_fire        -> unconditional pierce of ALL suppression windows
   *   2. emergency_class     -> wakes IF the value is in the agent's
   *                             shift_schedule.emergency_override.off_shift_can_wake_for
   *   3. neither             -> suppressed off-shift
   *
   * Added 2026-08-10. Before it, `off_shift_can_wake_for` was a list a human had
   * written and no code had ever read: an emergency check-back was suppressed
   * off-shift and never delivered, and a flood-class fire would have been
   * suppressed the same way. Matching is exact and case-insensitive; a near-miss
   * fails closed, because a cron that believes it is exempt and is not is worse
   * than one that knows it is suppressed.
   */
  emergency_class?: string;
}

// ---------------------------------------------------------------------------
// Cron Execution Log — Subtask 1.5
// ---------------------------------------------------------------------------

/**
 * A single entry in the per-agent cron execution log
 * (`$CTX_ROOT/.cortextOS/state/agents/{agent}/cron-execution.log`).
 *
 * The file is JSONL (one JSON object per line, newline-separated).
 * It is append-only; log rotation prunes to the last 1 000 lines.
 *
 * Status semantics:
 *   "fired"              — paste/write injection succeeded; this does NOT prove the REPL executed it.
 *   "confirmed"          — transcript contains the salted user turn, proving the REPL consumed it.
 *   "noop_unconfirmed"   — detector did not find the salted turn after one verification window.
 *   "noop_reinjected"    — detector still did not find it after two windows and performed one safe re-inject.
 *   "noop_persistent"    — detector did not find the re-injected turn after both verification windows.
 *   "retried"            — this attempt failed but more retries remain (see `error`).
 *   "failed"             — final failure after exhausting all retries (see `error`).
 */
export type CronFireKind = 'scheduled' | 'catch_up';

export interface CronExecutionLogEntry {
  /** ISO 8601 UTC timestamp of the fire attempt. */
  ts: string;
  /** Cron name (matches CronDefinition.name). */
  cron: string;
  /** Outcome of this attempt. */
  status: 'fired' | 'confirmed' | 'noop_unconfirmed' | 'noop_reinjected' | 'noop_persistent' | 'retried' | 'failed';
  /**
   * Why this fire occurred. Optional only for backward compatibility with
   * execution-log rows written before the field existed.
   */
  fire_kind?: CronFireKind;
  /** Attempt index (1-based). */
  attempt: number;
  /** Wall-clock duration of the fire attempt in milliseconds. */
  duration_ms: number;
  /** Error message if status is "retried" or "failed"; null otherwise. */
  error: string | null;
}

export interface OrgContext {
  name?: string;
  description?: string;
  industry?: string;
  icp?: string;
  value_prop?: string;
  timezone?: string;
  orchestrator?: string;
  day_mode_start?: string;
  day_mode_end?: string;
  default_approval_categories?: string[];
  communication_style?: string;
  dashboard_url?: string;
  /** Display name shown on dashboard (title bar, login page, sidebar header).
   *  If unset, falls back to `name` with smart-casing, then to "cortextOS". */
  brand_name?: string;
  /** Short brand name for compact UI slots (favicon caption, mobile nav).
   *  If unset, falls back to `brand_name` or `name`. */
  brand_short_name?: string;
  /** When true, agents are instructed at startup that every task submitted
   *  for review must have at least one file deliverable attached via
   *  save-output. The instruction is injected into the boot prompt
   *  dynamically — no agent markdown files are modified. */
  require_deliverables?: boolean;
  /**
   * Human team members accessible to agents in this org via Slack.
   * Agents reference this to resolve slack_handles and trust levels.
   */
  team_members?: TeamMember[];
  /** Org-level comms-lint config. Overrides hardcoded defaults; overridden by per-agent config. */
  comms_lint?: CommsLintConfig;
}

// Telegram Types

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
  message_reaction?: TelegramMessageReaction;
}

/**
 * One item in a Telegram message's reaction list. Telegram supports
 * `type: 'emoji'` (standard emoji, the only shape we handle today) and
 * `type: 'custom_emoji'` (premium custom emoji, carrying a `custom_emoji_id`
 * instead of an `emoji` character). Shaped as a tagged union so call sites
 * can narrow safely.
 */
export type TelegramReactionType =
  | { type: 'emoji'; emoji: string }
  | { type: 'custom_emoji'; custom_emoji_id: string };

/**
 * A `message_reaction` update fires when a user adds or removes an
 * emoji reaction on a chat message the bot can see. `old_reaction` and
 * `new_reaction` are the reaction state before/after — empty means "no
 * reaction", so the diff is (new) minus (old). Requires
 * `allowed_updates: ['message_reaction']` in the getUpdates call.
 */
export interface TelegramMessageReaction {
  chat: TelegramChat;
  user?: TelegramUser;
  message_id: number;
  date: number;
  old_reaction: TelegramReactionType[];
  new_reaction: TelegramReactionType[];
}

export interface TelegramMessage {
  message_id: number;
  date?: number;
  from?: TelegramUser;
  chat: TelegramChat;
  text?: string;
  photo?: TelegramPhotoSize[];
  document?: TelegramDocument;
  voice?: TelegramVoice;
  audio?: TelegramAudio;
  video?: TelegramVideo;
  video_note?: TelegramVideoNote;
  caption?: string;
  reply_to_message?: TelegramMessage;
}

export interface TelegramCallbackQuery {
  id: string;
  from: TelegramUser;
  message?: TelegramMessage;
  data?: string;
}

export interface TelegramUser {
  id: number;
  first_name: string;
  last_name?: string;
  username?: string;
}

export interface TelegramChat {
  id: number;
  type: string;
}

export interface TelegramPhotoSize {
  file_id: string;
  width: number;
  height: number;
}

export interface TelegramDocument {
  file_id: string;
  file_name?: string;
}

export interface TelegramVoice {
  file_id: string;
  duration: number;
}

export interface TelegramAudio {
  file_id: string;
  duration: number;
  file_name?: string;
}

export interface TelegramVideo {
  file_id: string;
  duration: number;
  file_name?: string;
}

export interface TelegramVideoNote {
  file_id: string;
  duration: number;
}

// Task Management Report Types

export interface StaleTaskReport {
  stale_in_progress: Task[];
  stale_pending: Task[];
  stale_human: Task[];
  overdue: Task[];
}

export interface ArchiveReport {
  archived: number;
  skipped: number;
  dry_run: boolean;
}

// Environment / Context Types

export interface CtxEnv {
  instanceId: string;
  ctxRoot: string;
  frameworkRoot: string;
  agentName: string;
  agentDir: string;
  org: string;
  projectRoot: string;
  timezone?: string;
  orchestrator?: string;
  /**
   * Per-agent git worktree path. Computed from CTX_ROOT + CTX_AGENT_NAME so
   * each specialist agent operates on an isolated checkout of the framework
   * repo. Prevents shared-HEAD branch collisions between concurrent agents
   * (worktree-isolation-design-2026-05-23.md). Empty when agentName or
   * ctxRoot is unset.
   */
  agentWorktree?: string;
}

// Bus Path Types

export interface BusPaths {
  ctxRoot: string;
  inbox: string;
  inflight: string;
  processed: string;
  logDir: string;
  stateDir: string;
  taskDir: string;
  approvalDir: string;
  analyticsDir: string;
  /**
   * Per-org deliverables root: {ctxRoot}/orgs/{org}/deliverables/.
   * Files saved here are servable by the dashboard's /api/media route because
   * they live under CTX_ROOT.
   */
  deliverablesDir: string;
}

// IPC Types

export type IPCCommandType =
  | 'status'
  | 'start-agent'
  | 'stop-agent'
  | 'restart-agent'
  | 'wake'
  | 'list-agents'
  | 'spawn-worker'
  | 'terminate-worker'
  | 'list-workers'
  | 'inject-worker'
  | 'reload-crons'
  | 'fire-cron'
  | 'inject-agent'
  | 'list-all-crons'
  | 'list-cron-executions'
  | 'add-cron'
  | 'update-cron'
  | 'remove-cron'
  | 'fleet-health';

// ---------------------------------------------------------------------------
// Execution log pagination response — Subtask 4.3
// ---------------------------------------------------------------------------

/**
 * Paginated response for list-cron-executions IPC command.
 */
export interface CronExecutionLogPage {
  entries: CronExecutionLogEntry[];
  /** Total matching entries (after cronName + statusFilter applied). */
  total: number;
  /** True when there are more entries older than this page. */
  hasMore: boolean;
}

// ---------------------------------------------------------------------------
// list-all-crons response shape — Subtask 4.1
// ---------------------------------------------------------------------------

/**
 * One row returned by the `list-all-crons` IPC command.
 * Combines the cron definition with runtime state (last fire, next fire, status).
 */
export interface CronSummaryRow {
  /** Agent that owns this cron. */
  agent: string;
  /** Org the agent belongs to (from enabled-agents.json). */
  org: string;
  /** Full cron definition as stored in crons.json. */
  cron: CronDefinition;
  /**
   * ISO 8601 timestamp of the most recent fire attempt.
   * Null when the cron has never fired (no execution log entry).
   */
  lastFire: string | null;
  /**
   * Outcome of the most recent execution log entry.
   * Null when the cron has never fired.
   */
  lastStatus: CronExecutionLogEntry['status'] | null;
  /** Kind of the most recent execution, or null for legacy/no history. */
  lastFireKind: CronFireKind | null;
  /**
   * ISO 8601 timestamp of the next scheduled fire.
   * Computed from the cron's schedule + last_fired_at (or now).
   */
  nextFire: string;
}

// ---------------------------------------------------------------------------
// Fleet Health — Subtask 4.4
// ---------------------------------------------------------------------------

export type CronHealthState = 'healthy' | 'warning' | 'failure' | 'never-fired';

/** Health record for a single cron, returned by the fleet-health IPC command. */
export interface CronHealthRow {
  agent: string;
  org: string;
  cronName: string;
  state: CronHealthState;
  reason: string;
  lastFire: number | null;
  /** Kind of the most recent execution, or null for legacy/no history. */
  lastFireKind: CronFireKind | null;
  expectedIntervalMs: number;
  gapMs: number | null;
  successRate24h: number;
  firesLast24h: number;
  nextFire: string;
}

/** Per-agent breakdown in the fleet-health summary. */
export interface AgentHealthSummary {
  agent: string;
  org: string;
  total: number;
  healthy: number;
  warning: number;
  failure: number;
  neverFired: number;
}

/** Full response returned by the fleet-health IPC command. */
export interface FleetHealthResponse {
  rows: CronHealthRow[];
  summary: {
    total: number;
    healthy: number;
    warning: number;
    failure: number;
    neverFired: number;
    agents: Record<string, AgentHealthSummary>;
  };
}

export interface IPCRequest {
  type: IPCCommandType;
  agent?: string;
  data?: Record<string, unknown>;
  /**
   * BUG-015: human-readable identifier of the caller (e.g. 'cortextos enable',
   * 'cortextos bus soft-restart-all'). Logged by the daemon on every incoming
   * IPC request so we can trace which CLI command triggered which daemon action.
   * Optional for backwards compatibility — older clients fall back to 'unknown'.
   */
  source?: string;
  /** False only when stop-agent is the first half of an explicit restart. */
  userInitiated?: boolean;
}

// Worker Types

export type WorkerStatusValue = 'starting' | 'running' | 'completed' | 'failed';

export interface WorkerStatus {
  name: string;
  status: WorkerStatusValue;
  pid?: number;
  dir: string;
  parent?: string;
  spawnedAt: string;
  exitCode?: number;
}

export interface IPCResponse {
  success: boolean;
  data?: unknown;
  error?: string;
  /**
   * Structured error code for failed responses. Lets operators distinguish
   * "agent does not exist" (NOT_FOUND), "request collapsed against an
   * in-flight identical op" (DEDUPED), and a live runtime that could not
   * durably admit the request (ADMISSION_FAILED). See issue #346.
   */
  code?: 'NOT_FOUND' | 'DEDUPED' | 'INVALID_INPUT' | 'NOT_RUNNING' | 'ADMISSION_FAILED';
}

// Agent Discovery Types

export interface AgentInfo {
  name: string;
  org: string;
  display_name?: string;  // user-configured name from IDENTITY.md (e.g. "Alpha", "Beta")
  role: string;
  enabled: boolean;
  running: boolean;
  last_heartbeat: string | null;
  current_task: string | null;
  mode: string | null;
}

export type TrustLevel = 'owner' | 'manager' | 'member';

export const VALID_TRUST_LEVELS: TrustLevel[] = ['owner', 'manager', 'member'];

/**
 * A human team member connected via Slack.
 * Stored in org config or agent config under team_members.
 */
export interface TeamMember {
  /** Display name (e.g. "Morgan Reed") */
  name: string;
  /** Job role or title (e.g. "Operations Manager") */
  role: string;
  /** Slack handle without @ (e.g. "morgan.reed") */
  slack_handle: string;
  /** Trust level — determines how the agent treats messages from this person */
  trust_level: TrustLevel;
  /** Optional persona-agent routing hint from Business Profile Wizard */
  assigned_to_agent?: string;
}

// Agent Status (returned by daemon)

export interface AgentStatus {
  name: string;
  status: 'running' | 'stopped' | 'crashed' | 'starting' | 'halted' | 'rate-limited';
  pid?: number;
  uptime?: number; // seconds
  lastHeartbeat?: string;
  sessionStart?: string;
  crashCount?: number;
  model?: string;
  awaitingConfirmation?: boolean;
}
