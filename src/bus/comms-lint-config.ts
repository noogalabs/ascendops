/**
 * Configurable comms-lint rule loader.
 *
 * Reads per-org and per-agent `comms_lint` config, merges it with the hardcoded
 * defaults (transcribed byte-for-byte from src/cli/bus.ts), compiles regex
 * safely, and returns a fully-resolved rule set ready for the linter to run.
 *
 * FAIL-OPEN posture (mirrors `checkDeliverableRequirement` in bus.ts): any
 * missing/malformed config file, any bad rule spec, or any unexpected error
 * falls back to the defaults — a broken config must NEVER crash a send or
 * disable the whole lint. One bad rule is dropped; the rest survive.
 *
 * `resolveCommsLintRules({})` returns the byte-for-byte default rule set; this
 * is the regression contract Shard 2 (bus.ts integration) relies on.
 */

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { stripBom } from '../utils/strip-bom.js';
import type {
  CommsLintConfig,
  CommsLintGroupConfig,
  CommsLintRuleSpec,
} from '../types/index.js';

/** A single compiled rule the linter actually runs. */
export interface CommsLintRule {
  id: string;
  pattern: RegExp;
  reason: string;
  suggest?: string;
  group: 'banned' | 'passive' | 'telegram' | 'agent-name';
}

/** The fully-resolved rule set returned by the loader. */
export interface ResolvedCommsLintRules {
  banned: CommsLintRule[];
  passive: CommsLintRule[];
  activeContext: RegExp;
  nextSignalContext: RegExp;
  telegram: CommsLintRule[];
  agentName: CommsLintRule | null;
}

// ─── Hardcoded defaults (transcribed EXACTLY from src/cli/bus.ts L82-224) ───
// Each entry mirrors the original regex source + flags one-for-one. The ids are
// part of the public allowlist contract (master plan §4.6) and MUST stay stable.
//
// IMPORTANT: per-rule flags are preserved verbatim. The em-dash rule
// (`telegram:em-dash`, /[–—―]/) has NO `i` flag in bus.ts — it stays flagless.

const DEFAULT_BANNED: CommsLintRule[] = [
  { id: 'banned:sleep-posture', pattern: /\bsleep posture\b/i, reason: 'banned jargon', group: 'banned' },
  { id: 'banned:standing-by', pattern: /\bstanding by\b/i, reason: 'banned jargon', group: 'banned' },
  { id: 'banned:standby', pattern: /\bstandby\b/i, reason: 'banned jargon', group: 'banned' },
  { id: 'banned:parked', pattern: /\bparked\b/i, reason: 'banned jargon', group: 'banned' },
  { id: 'banned:on-deck', pattern: /\bon-?deck\b/i, reason: 'banned jargon', group: 'banned' },
  { id: 'banned:idle', pattern: /\bidle\b/i, reason: 'banned jargon', group: 'banned' },
  { id: 'banned:asleep', pattern: /\basleep\b/i, reason: 'banned jargon', group: 'banned' },
  { id: 'banned:sleeping', pattern: /\bsleeping\b/i, reason: 'banned jargon', group: 'banned' },
  { id: 'banned:waiting-on', pattern: /\bwaiting[- ]on[- ]\w+\b/i, reason: 'banned jargon', group: 'banned' },
];

const DEFAULT_PASSIVE: CommsLintRule[] = [
  {
    id: 'passive:posture-set',
    pattern: /\b(standing by|standby|parked|idle|asleep|sleeping|holding)\b/i,
    reason: 'passive posture framing without active-work or specific next-signal context',
    group: 'passive',
  },
  {
    id: 'passive:waiting',
    pattern: /\bwaiting\b/i,
    reason: 'passive posture framing without active-work or specific next-signal context',
    group: 'passive',
  },
];

const DEFAULT_ACTIVE_CONTEXT =
  /\b(working on|implementing|building|testing|reviewing|shipping|debugging|patching|running|opened pr|pr #|commit\b|merging|validating)\b/i;
const DEFAULT_NEXT_SIGNAL_CONTEXT =
  /\b(next dispatch|next heartbeat|when .* (lands|arrives|finishes)|after .* (lands|arrives|finishes)|upon .* (signal|review|feedback))\b/i;

const DEFAULT_TELEGRAM: CommsLintRule[] = [
  {
    id: 'telegram:pr-number',
    pattern: /\bpr #\d+\b/i,
    reason: 'PR number leak (David tracks features not PR numbers)',
    suggest: 'reference the feature/fix by what it does, e.g. "the migration" not "PR #45"',
    group: 'telegram',
  },
  {
    id: 'telegram:pull-request-number',
    pattern: /\bpull request #\d+\b/i,
    reason: 'PR number leak',
    suggest: 'reference the feature/fix by what it does',
    group: 'telegram',
  },
  {
    id: 'telegram:commit-sha',
    pattern: /\b(?=[0-9a-f]{7,40}\b)[0-9a-f]*[a-f][0-9a-f]*\b/i,
    reason: 'commit SHA leak (engineer-speak)',
    suggest: 'drop the SHA — describe the change instead',
    group: 'telegram',
  },
  {
    id: 'telegram:brand-cortextos',
    pattern: /\bcortextos\b/i,
    reason: 'framework brand leak (cortextos is the internal framework name)',
    suggest: 'use "AscendOps" (the product David knows)',
    group: 'telegram',
  },
  {
    // Em-dash, en-dash, horizontal bar. NO `i` flag (matches bus.ts exactly).
    id: 'telegram:em-dash',
    pattern: /[–—―]/,
    reason: 'em-dash banned (reads as AI-written, David hard rule 2026-05-30)',
    suggest: 'use a comma, period, or parentheses instead, never a long dash',
    group: 'telegram',
  },
];

// Agent-name lint is ROSTER-DRIVEN, never a hardcoded set. It is built from the
// CONFIGURED org roster (see buildAgentNameRule + resolveCommsLintRules' `roster`
// opt). With no roster it is null — you cannot lint agent names you do not know,
// and the framework must never ship one org's agent names to another.
function escapeForRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function buildAgentNameRule(roster: string[]): CommsLintRule | null {
  const names = (Array.isArray(roster) ? roster : [])
    .filter((n) => typeof n === 'string' && n.trim().length > 0)
    .map((n) => escapeForRegex(n.trim()));
  if (names.length === 0) return null;
  return {
    id: 'agent-name:default',
    pattern: new RegExp(`\\b(${names.join('|')})\\b`, 'i'),
    reason:
      'agent name in outbound Telegram (usually the outcome matters, not which agent shipped it)',
    suggest: 'rephrase to describe the work, OR pass --explicit-naming to allow when naming is intentional',
    group: 'agent-name',
  };
}

/**
 * Build a fresh copy of the hardcoded default rule set. Each call returns new
 * arrays/objects (and freshly-constructed RegExps via the literals above are
 * shared by reference — RegExp literals are stateless here because no default
 * uses the `g`/`y` flag, so lastIndex never advances).
 */
export function getDefaultCommsLintRules(): ResolvedCommsLintRules {
  return {
    banned: DEFAULT_BANNED.map((r) => ({ ...r })),
    passive: DEFAULT_PASSIVE.map((r) => ({ ...r })),
    activeContext: new RegExp(DEFAULT_ACTIVE_CONTEXT.source, DEFAULT_ACTIVE_CONTEXT.flags),
    nextSignalContext: new RegExp(
      DEFAULT_NEXT_SIGNAL_CONTEXT.source,
      DEFAULT_NEXT_SIGNAL_CONTEXT.flags,
    ),
    telegram: DEFAULT_TELEGRAM.map((r) => ({ ...r })),
    // Roster-driven: no hardcoded agent names. resolveCommsLintRules sets this
    // from the configured org roster when one is passed; null otherwise.
    agentName: null,
  };
}

const ID_RE = /^[a-z0-9:_-]+$/;
const FLAGS_RE = /^[gimsuy]*$/;
const MAX_PATTERN_LENGTH = 1000;

/**
 * Compile a JSON rule spec into a CommsLintRule, or return null if the spec is
 * invalid in any way (bad id, bad flags, over-length pattern, uncompilable
 * regex). Never throws. A dropped rule never disables the others.
 */
function compileRuleSpec(
  spec: CommsLintRuleSpec,
  group: CommsLintRule['group'],
): CommsLintRule | null {
  try {
    if (!spec || typeof spec.id !== 'string' || !ID_RE.test(spec.id)) return null;
    if (typeof spec.pattern !== 'string' || spec.pattern.length > MAX_PATTERN_LENGTH) return null;
    if (typeof spec.reason !== 'string') return null;
    const flags = spec.flags === undefined ? 'i' : spec.flags;
    if (typeof flags !== 'string' || !FLAGS_RE.test(flags)) return null;
    let pattern: RegExp;
    try {
      // Validate the supplied set before normalization so duplicate/invalid
      // flags still reject the rule. Sticky `y` is incompatible with lint's
      // match-anywhere contract: at offset zero it corrupts the later telemetry
      // match, and elsewhere it silently bypasses detection. Preserve the rule
      // and every other flag, but never let sticky state reach the matcher.
      // eslint-disable-next-line no-new
      new RegExp('', flags);
      pattern = new RegExp(spec.pattern, flags.replace(/y/g, ''));
    } catch {
      return null;
    }
    const rule: CommsLintRule = { id: spec.id, pattern, reason: spec.reason, group };
    if (typeof spec.suggest === 'string') rule.suggest = spec.suggest;
    return rule;
  } catch {
    return null;
  }
}

/**
 * Merge one group: start from defaults (or `replace` if present), append `add`,
 * then remove any rule whose id is in `allow`. Order: replace -> add -> allow.
 *
 * FAIL-OPEN on `replace` (master plan §4.3 last bullet): if `replace` is present
 * but every spec is invalid/dropped (or the array is empty), the compiled result
 * is empty and we fall back to the prior layer's resolved set (`defaults`) rather
 * than zeroing the group. An empty/all-invalid replace is read as "the operator's
 * replacement failed, keep protecting" — NOT "operator wants zero rules". The
 * intentional zero-rules path is `allow`-listing rules by id (explicit). A
 * partially-valid replace (≥1 spec compiles) replaces as normal — only a fully
 * empty compiled result triggers the fallback.
 */
function mergeGroup(
  defaults: CommsLintRule[],
  cfg: CommsLintGroupConfig | undefined,
  group: CommsLintRule['group'],
): CommsLintRule[] {
  if (!cfg) return defaults.map((r) => ({ ...r }));

  let base: CommsLintRule[];
  if (Array.isArray(cfg.replace)) {
    const compiled = cfg.replace
      .map((spec) => compileRuleSpec(spec, group))
      .filter((r): r is CommsLintRule => r !== null);
    // Empty/all-invalid replace → keep the prior layer's resolved set (fail open).
    base = compiled.length > 0 ? compiled : defaults.map((r) => ({ ...r }));
  } else {
    base = defaults.map((r) => ({ ...r }));
  }

  if (Array.isArray(cfg.add)) {
    for (const spec of cfg.add) {
      const compiled = compileRuleSpec(spec, group);
      if (compiled) base.push(compiled);
    }
  }

  if (Array.isArray(cfg.allow) && cfg.allow.length > 0) {
    const allowSet = new Set(cfg.allow);
    base = base.filter((r) => !allowSet.has(r.id));
  }

  return base;
}

/**
 * Extend a context regex by OR-ing extra sources onto it. Each extra source is
 * length/syntax-guarded. On any failure the original regex is kept unchanged.
 * The combined regex is always compiled with the 'i' flag (matches §4.4).
 */
function extendContext(existing: RegExp, extras: string[] | undefined): RegExp {
  if (!Array.isArray(extras) || extras.length === 0) return existing;
  let current = existing;
  for (const extra of extras) {
    if (typeof extra !== 'string' || extra.length === 0 || extra.length > MAX_PATTERN_LENGTH) {
      continue;
    }
    try {
      // Validate the extra source compiles on its own before combining.
      // eslint-disable-next-line no-new
      new RegExp(extra, 'i');
      current = new RegExp(current.source + '|' + extra, 'i');
    } catch {
      // keep current unchanged
    }
  }
  return current;
}

/**
 * Apply a single config layer (org or agent) onto a current resolved set,
 * returning a new resolved set. agentName is a single-rule group: mergeGroup
 * returns 0 or 1 rules; [] -> null, [rule] -> that rule. If add/replace yield
 * more than one, the FIRST is taken (documented behavior).
 */
function applyLayer(
  current: ResolvedCommsLintRules,
  cfg: CommsLintConfig | undefined,
): ResolvedCommsLintRules {
  if (!cfg) return current;

  const agentNameDefaults = current.agentName ? [current.agentName] : [];
  const mergedAgentName = mergeGroup(agentNameDefaults, cfg.agentName, 'agent-name');

  return {
    banned: mergeGroup(current.banned, cfg.banned, 'banned'),
    passive: mergeGroup(current.passive, cfg.passive, 'passive'),
    activeContext: extendContext(current.activeContext, cfg.add_active_context),
    nextSignalContext: extendContext(current.nextSignalContext, cfg.add_next_signal_context),
    telegram: mergeGroup(current.telegram, cfg.telegram, 'telegram'),
    agentName: mergedAgentName.length > 0 ? mergedAgentName[0] : null,
  };
}

/**
 * Read a JSON config file and extract its `comms_lint` block. Returns undefined
 * on any error (missing file, malformed JSON, no comms_lint field). Never throws.
 */
function readCommsLintConfig(path: string): CommsLintConfig | undefined {
  try {
    if (!existsSync(path)) return undefined;
    const parsed = JSON.parse(stripBom(readFileSync(path, 'utf-8')));
    if (parsed && typeof parsed === 'object' && parsed.comms_lint) {
      return parsed.comms_lint as CommsLintConfig;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * Resolve the full comms-lint rule set for the given org/agent context.
 *
 * Layering: hardcoded defaults -> org config -> agent config (last writer wins).
 * NEVER throws — the whole body is wrapped in a belt-and-suspenders try/catch
 * that returns the defaults on any unexpected error. With all-undefined opts,
 * returns the byte-for-byte default rule set.
 */
export function resolveCommsLintRules(opts: {
  org?: string;
  agentDir?: string;
  frameworkRoot?: string;
  roster?: string[];
}): ResolvedCommsLintRules {
  try {
    let resolved = getDefaultCommsLintRules();

    // Roster-driven agent-name rule: built from the CONFIGURED org roster the
    // caller passes (via listAgents), never a hardcoded set. This is the default
    // the org/agent config layers below can still override/allow. No roster -> null.
    if (opts.roster && opts.roster.length > 0) {
      resolved = { ...resolved, agentName: buildAgentNameRule(opts.roster) };
    }

    // Org layer.
    if (opts.org && opts.frameworkRoot) {
      const orgContextPath = join(opts.frameworkRoot, 'orgs', opts.org, 'context.json');
      const orgCfg = readCommsLintConfig(orgContextPath);
      resolved = applyLayer(resolved, orgCfg);
    }

    // Agent layer (final say).
    if (opts.agentDir) {
      const agentConfigPath = join(opts.agentDir, 'config.json');
      const agentCfg = readCommsLintConfig(agentConfigPath);
      resolved = applyLayer(resolved, agentCfg);
    }

    return resolved;
  } catch {
    return getDefaultCommsLintRules();
  }
}
