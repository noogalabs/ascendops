/**
 * cron-migration.ts — Subtask 2.2: Auto-migration of crons from config.json → crons.json
 *
 * Migrates each agent's `crons` array from its config.json into the external
 * persistent crons.json format understood by the daemon CronScheduler.
 *
 * ## Idempotency
 * A zero-byte marker file at `{CTX_ROOT}/.cortextOS/state/agents/{agent}/.crons-migrated`
 * signals that migration already ran.  The migration is skipped entirely when the
 * marker exists, unless `force: true` is passed (which deletes the marker first).
 *
 * ## One-shot crons
 * CronDefinition supports interval-based and cron-expression schedules only —
 * there is no "fire once at time T" field in the external schema (as of Subtask 1.1).
 * One-shot crons from config.json (type:"once" with fire_at) are therefore:
 *   - Skipped with a log message if fire_at is in the past.
 *   - Skipped with a log message if fire_at is in the future (not representable in CronDefinition).
 *
 * TODO (future subtask): add a `fire_at` field to CronDefinition and teach
 * CronScheduler to fire them once then remove them.  When that lands, the
 * one-shot migration path below can be uncommented/extended.
 *
 * ## Non-destructive
 * The original `crons` array in config.json is never modified.
 */

import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import type { CronDefinition, CronEntry } from '../types/index.js';
import { readCronsWithStatus, writeCrons, withCronLock } from '../bus/crons.js';
import { CRONS_DIRECTORY } from '../bus/crons-schema.js';
import { scanAgentDir } from '../utils/cron-teaching-scanner.js';

// ---------------------------------------------------------------------------
// Marker file path helpers
// ---------------------------------------------------------------------------

/**
 * Return the absolute path to the migration marker file for an agent.
 * Path: `{ctxRoot}/.cortextOS/state/agents/{agentName}/.crons-migrated`
 */
function markerPath(ctxRoot: string, agentName: string): string {
  return join(ctxRoot, CRONS_DIRECTORY, agentName, '.crons-migrated');
}

/**
 * Return true when the migration marker exists for this agent.
 */
export function isMigrated(ctxRoot: string, agentName: string): boolean {
  return existsSync(markerPath(ctxRoot, agentName));
}

/**
 * Write (or touch) the migration marker file.
 * Creates the directory if it does not already exist.
 */
function writeMarker(ctxRoot: string, agentName: string): void {
  const path = markerPath(ctxRoot, agentName);
  mkdirSync(join(ctxRoot, CRONS_DIRECTORY, agentName), { recursive: true });
  writeFileSync(path, '', { encoding: 'utf-8', mode: 0o600 });
}

/**
 * Delete the migration marker file (used by --force re-migration).
 * No-op if the marker does not exist.
 */
function deleteMarker(ctxRoot: string, agentName: string): void {
  const path = markerPath(ctxRoot, agentName);
  if (existsSync(path)) {
    unlinkSync(path);
  }
}

// ---------------------------------------------------------------------------
// Cron-teaching upgrade advisory (Part C of upgrade-cron-teaching follow-up)
//
// The data migration above moves cron entries from config.json -> crons.json.
// The *teaching* (CronCreate / /loop / config.json prose) inside each agent's
// CLAUDE.md, AGENTS.md, ONBOARDING.md, and SKILL.md files is independent of
// that data migration and frequently lags behind. The advisory below scans
// the agent workspace once per agent, logs a single warning line listing the
// stale-reference count, and drops a `.cron-teaching-checked` marker so the
// scan does not repeat on every daemon boot. Pure advisory: never blocks
// migration, and never modifies workspace files.
// ---------------------------------------------------------------------------

const TEACHING_MARKER_NAME = '.cron-teaching-checked';

function teachingMarkerPath(ctxRoot: string, agentName: string): string {
  return join(ctxRoot, CRONS_DIRECTORY, agentName, TEACHING_MARKER_NAME);
}

/** True when the cron-teaching scan has already run for this agent. */
export function isTeachingChecked(ctxRoot: string, agentName: string): boolean {
  return existsSync(teachingMarkerPath(ctxRoot, agentName));
}

function writeTeachingMarker(ctxRoot: string, agentName: string): void {
  const path = teachingMarkerPath(ctxRoot, agentName);
  mkdirSync(join(ctxRoot, CRONS_DIRECTORY, agentName), { recursive: true });
  writeFileSync(path, '', { encoding: 'utf-8', mode: 0o600 });
}

function deleteTeachingMarker(ctxRoot: string, agentName: string): void {
  const path = teachingMarkerPath(ctxRoot, agentName);
  if (existsSync(path)) {
    unlinkSync(path);
  }
}

interface TeachingCheckArgs {
  agentName: string;
  agentDir: string;
  ctxRoot: string;
  force: boolean;
  log: (msg: string) => void;
}

/**
 * Scan one agent's workspace for stale cron-teaching patterns. Logs a single
 * advisory line if any matches are found, then drops the
 * `.cron-teaching-checked` marker so the scan does not repeat. Honors the
 * `force` option for parity with `migrateCronsForAgent`.
 */
function runTeachingCheck(args: TeachingCheckArgs): void {
  if (args.force) {
    deleteTeachingMarker(args.ctxRoot, args.agentName);
  }
  if (isTeachingChecked(args.ctxRoot, args.agentName)) {
    return;
  }

  // Workspace dir may not exist (e.g. migration called against a config path
  // whose parent has been removed). Drop the marker anyway so we do not loop.
  if (!existsSync(args.agentDir)) {
    writeTeachingMarker(args.ctxRoot, args.agentName);
    return;
  }

  const result = scanAgentDir(args.agentDir);
  if (result.matches.length > 0) {
    const fileCount = new Set(result.matches.map((m) => m.file)).size;
    args.log(
      `cron-teaching upgrade recommended: ${result.matches.length} stale references in ${fileCount} files. ` +
        `Run cortextos bus upgrade-cron-teaching ${args.agentName}`,
    );
  }
  writeTeachingMarker(args.ctxRoot, args.agentName);
}

// ---------------------------------------------------------------------------
// Config.json cron conversion
// ---------------------------------------------------------------------------

/**
 * Convert a single CronEntry (config.json format) to a CronDefinition (crons.json format).
 *
 * Returns null with a reason string when the entry cannot be converted (e.g. one-shot crons).
 *
 * Exported alias used by {@link reloadCronsForAgent} so reload + migrate share
 * the same conversion semantics. Keeps shape-rule changes in one place.
 */
export function convertConfigEntryToDefinition(
  entry: CronEntry,
  agentName: string,
): { cron: CronDefinition } | { skip: string } {
  return convertEntry(entry, agentName);
}

function convertEntry(
  entry: CronEntry,
  agentName: string,
): { cron: CronDefinition } | { skip: string } {
  const {
    name, type, interval, cron: cronExpr, fire_at, prompt, wake_on_fire,
    enabled, description, disabled_reason,
  } = entry;

  // Treat absent `type` as "recurring" (spec requirement)
  const effectiveType = type ?? 'recurring';

  // OPERATOR INTENT CAN BE EXPRESSED TWO WAYS, AND BOTH MUST BE HONOURED.
  //
  // `type: "disabled"` was the only signal this function used to read. But an
  // operator disabling a cron reaches for the obvious field — `enabled: false` —
  // and leaves `type` as "recurring", because the cron IS recurring; it is just
  // switched off. Those two fields do not contradict each other from a writer's
  // point of view, and the reader honoured only one of them.
  //
  // 2026-08-12: an agent hardened cash's config with `enabled: false` on five
  // proactive crons precisely so a fleet restart could not re-arm them. This
  // function discarded the field and wrote `enabled: true`, and since #125
  // reconciles config.json -> crons.json on EVERY AGENT BOOT, all five came back
  // armed. Zero prohibited fires only because cash noticed and re-disabled them
  // ~25 minutes before the 12:00Z window. The hardening was correct and
  // unreachable — defeated by the mechanism that reads it.
  //
  // An explicit `enabled: false` is a disable instruction whatever `type` says.
  // Absent means "not specified", which still defaults to enabled.
  const explicitlyDisabled = enabled === false;

  // Disabled crons: migrate as disabled (preserve operator intent)
  if (effectiveType === 'disabled' || explicitlyDisabled) {
    // Disabled entries still need a schedule — use interval or cron expression if present
    const schedule = cronExpr ?? interval;
    if (!schedule) {
      return { skip: `cron "${name}" is disabled and has no interval/cron — skipping` };
    }
    const def: CronDefinition = {
      name,
      prompt: prompt ?? '',
      schedule,
      enabled: false,
      created_at: new Date().toISOString(),
      // The operator's own description wins. The generic string is a FALLBACK,
      // not an override — it used to clobber whatever the config said.
      description: description ?? `Migrated from config.json (was disabled)`,
      ...(disabled_reason ? { disabled_reason } : {}),
      metadata: { migrated_from_config: true, original_type: effectiveType },
      ...(wake_on_fire ? { wake_on_fire: true } : {}),
    };
    return { cron: def };
  }

  // One-shot crons — CronDefinition has no fire_at field yet
  if (effectiveType === 'once') {
    if (!fire_at) {
      return {
        skip: `cron "${name}" has type "once" but no fire_at timestamp — skipping. ` +
          `TODO: once CronDefinition supports fire_at, migrate this entry.`,
      };
    }
    const fireAtMs = Date.parse(fire_at);
    if (isNaN(fireAtMs)) {
      return {
        skip: `cron "${name}" has type "once" with unparseable fire_at "${fire_at}" — skipping`,
      };
    }
    if (fireAtMs <= Date.now()) {
      return {
        skip: `cron "${name}" has type "once" with past fire_at "${fire_at}" — skipping (already fired or expired)`,
      };
    }
    // Future one-shot — still not representable in CronDefinition as of Subtask 1.1
    return {
      skip: `cron "${name}" has type "once" with future fire_at "${fire_at}" — skipping. ` +
        `TODO: once CronDefinition supports fire_at, migrate this as a one-shot.`,
    };
  }

  // Recurring cron — requires a schedule
  // Use cron expression if present (takes precedence), else interval shorthand
  const schedule = cronExpr ?? interval;
  if (!schedule) {
    return {
      skip: `cron "${name}" has no interval or cron expression — skipping`,
    };
  }

  if (!prompt) {
    return {
      skip: `cron "${name}" has no prompt — skipping`,
    };
  }

  const def: CronDefinition = {
    name,
    prompt,
    schedule,
    enabled: true,
    created_at: new Date().toISOString(),
    // Carry the operator's own fields through. Declaring them on CronEntry was
    // not enough — until 2026-08-13 they were read off the entry and dropped
    // here, so a description or a disabled_reason written in config.json
    // vanished on every boot reconcile.
    ...(description ? { description } : {}),
    ...(disabled_reason ? { disabled_reason } : {}),
    metadata: { migrated_from_config: true, original_type: effectiveType },
    ...(wake_on_fire ? { wake_on_fire: true } : {}),
  };

  return { cron: def };
}

// ---------------------------------------------------------------------------
// Per-agent migration
// ---------------------------------------------------------------------------

export interface MigrationOptions {
  /** Re-run even if the marker file already exists (deletes marker first). */
  force?: boolean;
  /** Custom logger (defaults to console.log). */
  log?: (msg: string) => void;
}

export interface MigrationResult {
  /** Agent name processed. */
  agentName: string;
  /** Disposition: skipped-already-migrated | no-config | no-crons | migrated */
  status: 'skipped-already-migrated' | 'no-config' | 'no-crons' | 'migrated';
  /** Number of crons written to crons.json (only set when status === "migrated"). */
  cronsMigrated?: number;
  /** Names of crons that were skipped (one-shots, missing fields, etc.). */
  cronsSkipped?: string[];
}

/**
 * Migrate crons for a single agent from its config.json → crons.json.
 *
 * @param agentName       - The agent directory name (e.g. "boris", "paul").
 * @param configJsonPath  - Absolute path to the agent's config.json.
 * @param ctxRoot         - Absolute path to CTX_ROOT (where state dirs live).
 * @param options         - Optional: force re-migration, custom logger.
 * @returns A MigrationResult describing what happened.
 */
export function migrateCronsForAgent(
  agentName: string,
  configJsonPath: string,
  ctxRoot: string,
  options: MigrationOptions = {},
): MigrationResult {
  const log = options.log ?? ((msg: string) => console.log(`[cron-migration] ${msg}`));

  const result = runMigrationCore(agentName, configJsonPath, ctxRoot, options, log);

  // Part C: cron-teaching upgrade advisory. Independent of cron-data migration
  // (uses its own marker). Pure advisory — never blocks the migration result.
  try {
    runTeachingCheck({
      agentName,
      agentDir: dirname(configJsonPath),
      ctxRoot,
      force: !!options.force,
      log,
    });
  } catch (err) {
    log(
      `cron-teaching scan failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  return result;
}

/** Core migration logic. Public callers go through `migrateCronsForAgent`. */
function runMigrationCore(
  agentName: string,
  configJsonPath: string,
  ctxRoot: string,
  options: MigrationOptions,
  log: (msg: string) => void,
): MigrationResult {
  // --force: delete marker to allow re-migration
  if (options.force) {
    deleteMarker(ctxRoot, agentName);
    log(`Force flag set — cleared migration marker for "${agentName}"`);
  }

  // Idempotency check: already migrated → skip
  if (isMigrated(ctxRoot, agentName)) {
    log(`Skipping migration for "${agentName}" — already migrated`);
    return { agentName, status: 'skipped-already-migrated' };
  }

  // Read existing crons.json state FIRST so we never blind-overwrite
  // runtime-added crons (bus add-cron) that aren't represented in config.json.
  // Fail loud on catastrophic corruption (primary + .bak both unparseable):
  // skip this agent entirely rather than zeroing a real schedule, and do NOT
  // write the marker so a later boot retries after the operator restores it.
  const existingRead = readCronsWithStatus(agentName);
  if (existingRead.corrupt) {
    log(
      `ERROR: crons.json for "${agentName}" is corrupt (primary + .bak unparseable) — ` +
        `aborting migration, leaving file untouched and NOT writing marker so a later ` +
        `boot retries after the operator restores it`,
    );
    return { agentName, status: 'no-crons' };
  }
  const existingByName = new Map(existingRead.crons.map((c) => [c.name, c]));

  // Read config.json — preserve existing crons on a missing file
  if (!existsSync(configJsonPath)) {
    log(`No config.json found for "${agentName}" at ${configJsonPath} — preserving ${existingRead.crons.length} existing crons.json entries + marker`);
    writeCrons(agentName, existingRead.crons);
    writeMarker(ctxRoot, agentName);
    return { agentName, status: 'no-config' };
  }

  let rawConfig: unknown;
  try {
    rawConfig = JSON.parse(readFileSync(configJsonPath, 'utf-8'));
  } catch (err) {
    // Unreadable / corrupt config.json: fail loud — leave existing crons.json
    // untouched and do NOT write the marker, so migration retries next boot
    // rather than permanently wiping a real schedule from one bad parse.
    log(
      `ERROR: failed to parse config.json for "${agentName}" — leaving existing crons.json untouched, ` +
        `NOT writing marker (will retry next boot). Error: ${err instanceof Error ? err.message : String(err)}`,
    );
    return { agentName, status: 'no-crons' };
  }

  // Extract crons array — treat missing / empty as "no crons"
  const configCrons: CronEntry[] = [];
  if (
    rawConfig !== null &&
    typeof rawConfig === 'object' &&
    'crons' in rawConfig &&
    Array.isArray((rawConfig as { crons?: unknown }).crons)
  ) {
    configCrons.push(...((rawConfig as { crons: CronEntry[] }).crons));
  }

  if (configCrons.length === 0) {
    log(`No crons array in config.json for "${agentName}" — preserving ${existingRead.crons.length} existing crons.json entries + marker`);
    writeCrons(agentName, existingRead.crons);
    writeMarker(ctxRoot, agentName);
    return { agentName, status: 'no-crons' };
  }

  // Convert + merge each config entry over existing state. Start the merge map
  // from existing-by-name so runtime-added crons not present in config are kept
  // (orphan-tolerant, matching reloadCronsForAgent). For names present in both,
  // overlay only the config-authoritative fields and preserve runtime fields
  // (created_at, last_fired_at, fire_count, …) from the prior on-disk entry.
  const skipped: string[] = [];
  const mergedByName = new Map<string, CronDefinition>(existingByName);

  for (const entry of configCrons) {
    const result = convertEntry(entry, agentName);
    if ('cron' in result) {
      const newDef = result.cron;
      const prior = existingByName.get(newDef.name);
      if (prior) {
        const merged: CronDefinition = { ...prior };
        for (const field of CONFIG_AUTHORITATIVE_FIELDS) {
          (merged as unknown as Record<string, unknown>)[field] = newDef[field];
        }
        if (newDef.description !== undefined) merged.description = newDef.description;
        // disabled_reason gets description's CONDITIONAL semantics, not blanket
        // inclusion in CONFIG_AUTHORITATIVE_FIELDS: config wins when it supplies
        // one, state is preserved when it does not. Added 2026-08-13 — conversion
        // began populating the field but both merge paths dropped it, so a reason
        // added or changed in config never reached disk for an existing cron.
        if (newDef.disabled_reason !== undefined) merged.disabled_reason = newDef.disabled_reason;
        mergedByName.set(newDef.name, merged);
      } else {
        mergedByName.set(newDef.name, newDef);
      }
      log(`  Migrated cron "${entry.name}" for "${agentName}" (schedule: ${newDef.schedule})`);
    } else {
      skipped.push(entry.name);
      log(`  Skipped cron for "${agentName}": ${result.skip}`);
    }
  }

  const converted = Array.from(mergedByName.values());

  // Write crons.json atomically and set marker under the agent cron lock to
  // serialize against addCron/removeCron writers — same discipline as reload.
  withCronLock(agentName, () => {
    writeCrons(agentName, converted);
  });
  writeMarker(ctxRoot, agentName);

  log(
    `Migration complete for "${agentName}": ${converted.length} migrated, ${skipped.length} skipped`,
  );

  return {
    agentName,
    status: 'migrated',
    cronsMigrated: converted.length,
    cronsSkipped: skipped,
  };
}

// ---------------------------------------------------------------------------
// Multi-agent migration
// ---------------------------------------------------------------------------

export interface MultiMigrationSummary {
  processed: number;
  totalCronsMigrated: number;
  results: MigrationResult[];
}

/**
 * Discover all agents in the framework and migrate each one.
 *
 * Scans `{frameworkRoot}/orgs/{org}/agents/{name}/config.json` for every agent
 * directory found on disk.  The CTX_ROOT for state (marker files and crons.json)
 * is resolved from `process.env.CTX_ROOT` when not explicitly provided.
 *
 * @param frameworkRoot - Absolute path to the framework root.
 * @param ctxRoot       - Absolute path to CTX_ROOT (state dir root).
 * @param options       - Optional: force, custom logger.
 * @returns Summary across all agents.
 */
export function migrateAllAgents(
  frameworkRoot: string,
  ctxRoot: string,
  options: MigrationOptions = {},
): MultiMigrationSummary {
  const log = options.log ?? ((msg: string) => console.log(`[cron-migration] ${msg}`));

  const { readdirSync: fsReaddir, existsSync: fsExists } = require('fs') as {
    readdirSync: typeof import('fs').readdirSync;
    existsSync: typeof import('fs').existsSync;
  };

  const results: MigrationResult[] = [];

  const orgsBase = join(frameworkRoot, 'orgs');
  if (!fsExists(orgsBase)) {
    log(`No orgs directory found at ${orgsBase} — nothing to migrate`);
    return { processed: 0, totalCronsMigrated: 0, results };
  }

  let orgNames: string[] = [];
  try {
    orgNames = fsReaddir(orgsBase, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch (err) {
    log(`Failed to read orgs directory: ${err instanceof Error ? err.message : String(err)}`);
    return { processed: 0, totalCronsMigrated: 0, results };
  }

  for (const org of orgNames) {
    const agentsBase = join(orgsBase, org, 'agents');
    if (!fsExists(agentsBase)) continue;

    let agentNames: string[] = [];
    try {
      // Match the daemon's discoverAgents() filter: skip _shared/, hidden
      // dirs, and any directory without a config.json. Without these guards
      // cron-migration would write crons.json + .crons-migrated markers for
      // dirs that the daemon would never actually spawn (Zone C M4).
      agentNames = fsReaddir(agentsBase, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .filter((d) => !d.name.startsWith('_') && !d.name.startsWith('.'))
        .filter((d) => fsExists(join(agentsBase, d.name, 'config.json')))
        .map((d) => d.name);
    } catch {
      continue;
    }

    for (const name of agentNames) {
      const configPath = join(agentsBase, name, 'config.json');
      try {
        const result = migrateCronsForAgent(name, configPath, ctxRoot, { ...options, log });
        results.push(result);
      } catch (err) {
        log(
          `ERROR: unexpected failure migrating "${name}": ${err instanceof Error ? err.message : String(err)}`,
        );
        results.push({ agentName: name, status: 'no-config' });
      }
    }
  }

  const totalCronsMigrated = results.reduce((sum, r) => sum + (r.cronsMigrated ?? 0), 0);

  log(
    `All-agent migration complete: ${results.length} agents processed, ${totalCronsMigrated} total crons migrated`,
  );

  return { processed: results.length, totalCronsMigrated, results };
}

// ---------------------------------------------------------------------------
// reload-crons — merge-aware re-sync of config.json → crons.json
//
// Unlike migrateCronsForAgent + force (which wipes runtime fields),
// reloadCronsForAgent preserves runtime fields (last_fired_at, fire_count,
// created_at, last_fire_attempted_at) for crons whose name already exists in
// the state crons.json. Config-side fields (prompt, schedule, enabled,
// description) authoritatively overwrite state.
//
// Default behavior tolerates orphans (crons present in state but not config).
// Pass --prune to drop orphans. All destructive ops require explicit opt-in
// per the cron-source-of-truth contract.
//
// Architecture doc: docs/architecture/cron-source-of-truth.md
// ---------------------------------------------------------------------------

/**
 * Fields that config.json AUTHORITATIVELY OVERWRITES on a matched entry.
 * Everything else on the existing state entry (runtime fields + operator-set
 * metadata + future schema additions) is preserved by default.
 *
 * Inversion fix per Codex review P2 (PR #17 surface, fix lands on #16):
 * earlier shape rebuilt from convertEntry output and copied only 4 named
 * runtime fields back, silently dropping operator-set `description` (from
 * `bus add-cron --desc`) and any state-only fields not yet in the schema.
 *
 * New shape: start from existing state, overwrite only these fields with
 * the config-side values. New crons (no existing state) take the full
 * converted CronDefinition unchanged.
 */
const CONFIG_AUTHORITATIVE_FIELDS = [
  'prompt',
  'schedule',
  'enabled',
  'wake_on_fire',
] as const;

export interface ReloadOptions {
  /** Drop crons present in state but not in config.json. Default false (orphans tolerated). */
  prune?: boolean;
  /** Custom logger (defaults to console.log). */
  log?: (msg: string) => void;
}

export interface ReloadResult {
  agentName: string;
  added: string[];
  updated: string[];
  unchanged: string[];
  kept_orphan: string[];
  pruned_orphan: string[];
  skipped: { name: string; reason: string }[];
  total_state_crons: number;
  /** Set when reload could not complete (missing config, parse failure, etc.).
   *  CLI exits non-zero when this is populated; --json mode emits it so callers
   *  can distinguish silent success from silent failure (Codex P2 finding). */
  error?: string;
}

/**
 * Reload an agent's crons from its config.json into state crons.json,
 * preserving runtime fields on matching entries. See module-level docs.
 *
 * @param agentName        - Agent identifier (validated by caller).
 * @param configJsonPath   - Absolute path to the agent's config.json.
 * @param options          - {@link ReloadOptions}.
 */
export function reloadCronsForAgent(
  agentName: string,
  configJsonPath: string,
  options: ReloadOptions = {},
): ReloadResult {
  const log = options.log ?? ((msg: string) => console.log(msg));
  const prune = options.prune ?? false;

  const result: ReloadResult = {
    agentName,
    added: [],
    updated: [],
    unchanged: [],
    kept_orphan: [],
    pruned_orphan: [],
    skipped: [],
    total_state_crons: 0,
  };

  // 1. Read config.json crons[] (before acquiring lock — pure read)
  let configCrons: CronEntry[] = [];
  if (!existsSync(configJsonPath)) {
    const msg = `No config.json found for "${agentName}" at ${configJsonPath} — reload no-op`;
    log(msg);
    result.error = msg;
    return result;
  }
  try {
    const configRaw = readFileSync(configJsonPath, 'utf-8');
    const config = JSON.parse(configRaw);
    configCrons = Array.isArray(config?.crons) ? config.crons : [];
  } catch (err) {
    const msg =
      `failed to parse config.json for "${agentName}": ` +
      `${err instanceof Error ? err.message : String(err)}`;
    log(`ERROR: ${msg} — reload aborted`);
    result.error = msg;
    return result;
  }

  // 2-5. Serialize the read-modify-write cycle under the agent cron lock to
  // prevent races with `addCron` / `updateCron` / `removeCron` writers (Codex P1).
  withCronLock(agentName, () => {
    // 2. Read existing state crons.json (may be empty if first-ever sync).
    // Guard corrupt STATE the same way corrupt CONFIG is guarded above: a
    // catastrophic parse failure (crons.json AND its .bak both unparseable)
    // returns corrupt=true with an empty list. Proceeding would treat state as
    // empty and OVERWRITE the unrecoverable file with config-only crons, wiping
    // live-only orphans + runtime metadata (fire_count, last_fired_at). Fail
    // loud, no write, preserve the file for manual recovery. (Single-file
    // corruption self-heals earlier via the crons.json.bak fallback.)
    const existingRead = readCronsWithStatus(agentName);
    if (existingRead.corrupt) {
      const msg =
        `crons.json for "${agentName}" is corrupt (primary + .bak both unparseable) — ` +
        `reload aborted, file preserved for recovery (no overwrite)`;
      log(`ERROR: ${msg}`);
      result.error = msg;
      return;
    }
    const existingState = existingRead.crons;
    const existingByName = new Map(existingState.map(c => [c.name, c]));

    // 3. Build merged crons array: for each config entry, convert + merge runtime fields
    const mergedByName = new Map<string, CronDefinition>();
    for (const configEntry of configCrons) {
      const conv = convertEntry(configEntry, agentName);
      if ('skip' in conv) {
        result.skipped.push({ name: configEntry.name, reason: conv.skip });
        continue;
      }
      const newDef = conv.cron;
      const existing = existingByName.get(newDef.name);
      if (existing) {
        // Merge inversion: start from existing state (preserves runtime fields,
        // operator-set metadata, and any state-only fields not yet in the
        // schema), then overwrite ONLY the config-authoritative fields.
        // Description is handled separately — preserve operator-set description
        // when config does not provide one. Double-cast for TS2352.
        const merged: CronDefinition = { ...existing };
        for (const field of CONFIG_AUTHORITATIVE_FIELDS) {
          (merged as unknown as Record<string, unknown>)[field] = newDef[field];
        }
        if (newDef.description !== undefined) {
          merged.description = newDef.description;
        }
        // Same conditional treatment for disabled_reason (see the migration merge
        // above). This is the BOOT path — the one that runs on every agent start —
        // so dropping it here is what made an operator's stated reason vanish in
        // practice rather than only in theory.
        if (newDef.disabled_reason !== undefined) {
          merged.disabled_reason = newDef.disabled_reason;
        }

        mergedByName.set(newDef.name, merged);

        // Track add vs update vs unchanged using config-authoritative fields
        // (description compared only when config provides one).
        const definitionChanged =
          existing.prompt !== newDef.prompt ||
          existing.schedule !== newDef.schedule ||
          existing.enabled !== newDef.enabled ||
          (existing.wake_on_fire ?? false) !== (newDef.wake_on_fire ?? false) ||
          (newDef.description !== undefined && existing.description !== newDef.description) ||
          // disabled_reason compared on the same CONDITIONAL terms as description.
          // Without this the merge writes a changed reason to disk while
          // reloadCronsForAgent reports it unchanged — the bytes are right and the
          // REPORT is wrong, which is worse for CLI/JSON callers that use
          // ReloadResult to decide whether anything moved. Found by an agent's
          // from-zero review of e74192aa, 2026-08-13.
          (newDef.disabled_reason !== undefined &&
            existing.disabled_reason !== newDef.disabled_reason);
        if (definitionChanged) {
          result.updated.push(newDef.name);
        } else {
          result.unchanged.push(newDef.name);
        }
      } else {
        // New cron — no existing state to preserve
        mergedByName.set(newDef.name, newDef);
        result.added.push(newDef.name);
      }
    }

    // 4. Handle orphans (in state but not in config)
    for (const existing of existingState) {
      if (mergedByName.has(existing.name)) continue;
      if (prune) {
        result.pruned_orphan.push(existing.name);
      } else {
        mergedByName.set(existing.name, existing);
        result.kept_orphan.push(existing.name);
      }
    }

    // 5. Atomic write back to crons.json (inside the lock)
    const merged = Array.from(mergedByName.values());
    writeCrons(agentName, merged);
    result.total_state_crons = merged.length;
  });

  log(
    `Reload complete for "${agentName}": ${result.added.length} added, ${result.updated.length} updated, ` +
      `${result.unchanged.length} unchanged, ${result.kept_orphan.length} orphan kept, ` +
      `${result.pruned_orphan.length} orphan pruned, ${result.skipped.length} skipped, ` +
      `total ${result.total_state_crons}`,
  );

  return result;
}

// ---------------------------------------------------------------------------
// sync — boot-time config.json → crons.json synchronization
//
// Closes the cron-sync gap: migrateCronsForAgent is marker-gated and runs ONCE
// per agent, so any cron added to config.json AFTER the first migration never
// reached crons.json (the canonical live source the CronScheduler reads) unless
// an operator manually ran `cortextos bus reload-crons`. syncCronsForAgent is
// the daemon's boot-time entry point: first boot migrates exactly as before;
// every subsequent boot reconciles config.json into crons.json via the
// merge-aware reloadCronsForAgent (runtime fields preserved, orphans kept,
// never prunes, fail-loud no-op on missing/corrupt config.json).
// ---------------------------------------------------------------------------

export interface SyncResult {
  agentName: string;
  /** Which path ran: first-boot migration or post-migration reconcile. */
  mode: 'migrated' | 'reconciled';
  /** Set when mode === 'migrated'. */
  migration?: MigrationResult;
  /** Set when mode === 'reconciled'. */
  reload?: ReloadResult;
}

/**
 * Ensure an agent's crons.json reflects its config.json `crons` array.
 *
 * - Not yet migrated (no `.crons-migrated` marker): runs the one-shot
 *   migration (unchanged semantics, marker written).
 * - Already migrated: runs {@link reloadCronsForAgent} with `prune: false` —
 *   config-side adds/edits land in crons.json, runtime metadata
 *   (`fire_count`, `last_fired_at`, `last_fire_attempted_at`, `created_at`)
 *   is preserved on name matches, and live-only orphan crons (added via
 *   `bus add-cron`, absent from config.json) are kept. Missing or unparseable
 *   config.json is a logged no-op — crons.json is never wiped.
 *
 * Called by the daemon on every agent start (daemon boot starts each agent
 * through `startAgent`, and restarts go stopAgent → startAgent), so editing
 * config.json + restarting now reaches the live scheduler without a manual
 * `bus reload-crons`.
 */
export function syncCronsForAgent(
  agentName: string,
  configJsonPath: string,
  ctxRoot: string,
  options: MigrationOptions = {},
): SyncResult {
  const log = options.log ?? ((msg: string) => console.log(`[cron-sync] ${msg}`));

  const migration = migrateCronsForAgent(agentName, configJsonPath, ctxRoot, {
    ...options,
    log,
  });

  if (migration.status !== 'skipped-already-migrated') {
    // First boot (or no-config / no-crons / corrupt-config dispositions) —
    // migration core already handled merge/fail-loud semantics; nothing more
    // to reconcile this boot.
    return { agentName, mode: 'migrated', migration };
  }

  // Marker present: migration is permanently a no-op for this agent. Reconcile
  // config.json into crons.json so post-migration config edits reach the live
  // scheduler. prune:false — orphan removal stays an explicit operator action
  // (`bus reload-crons --prune`), never an automatic boot side-effect.
  const reload = reloadCronsForAgent(agentName, configJsonPath, {
    prune: false,
    log,
  });

  return { agentName, mode: 'reconciled', reload };
}
