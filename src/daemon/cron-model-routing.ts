import { createHash } from 'crypto';
import { parse as parseYaml } from 'yaml';
import type { AgentConfig, CronDefinition } from '../types/index.js';
import {
  HEARTBEAT_PREFLIGHT_AUTHORITY_BASE64,
  HEARTBEAT_PREFLIGHT_AUTHORITY_SHA256,
} from './heartbeat-preflight-authority.js';

export const CODEX_SOL_MODEL = 'gpt-5.6-sol' as const;
export const CODEX_LUN_MODEL = 'gpt-5.6-lun' as const;
export const CODEX_TERRA_MODEL = 'gpt-5.6-terra' as const;

export type CodexCronModel =
  | typeof CODEX_SOL_MODEL
  | typeof CODEX_LUN_MODEL
  | typeof CODEX_TERRA_MODEL;

export interface CodexCronRoutingDecision {
  model: CodexCronModel;
  cronName: string;
  source: 'daemon-cron';
  reason: string;
  skillName: string;
  requestedModel: string;
  effort: string;
}

export interface CodexCronRoutingPlan {
  routing: CodexCronRoutingDecision;
  preflightPrompt: string;
  continuationPrompt: string;
  fallbackPrompt: string;
}

interface ResolveCronModelInput {
  cron: Pick<CronDefinition, 'name' | 'prompt'>;
  frameworkRoot: string;
  runtime: AgentConfig['runtime'];
  configuredModel: AgentConfig['model'];
}

interface SkillFrontmatter {
  name?: unknown;
  model?: unknown;
  effort?: unknown;
}

type ModelLevel = 0 | 1 | 2;

const MODEL_BY_LEVEL: Record<ModelLevel, CodexCronModel> = {
  0: CODEX_TERRA_MODEL,
  1: CODEX_LUN_MODEL,
  2: CODEX_SOL_MODEL,
};

export const CODEX_HEARTBEAT_CRON_PROMPT =
  'Read HEARTBEAT.md and follow its instructions. Update your heartbeat, check inbox, and work on your highest priority task.';

const HEARTBEAT_PREFLIGHT_AUTHORITY = Buffer.from(
  HEARTBEAT_PREFLIGHT_AUTHORITY_BASE64,
  'base64',
);

const HEARTBEAT_SOL_CONTINUATION = [
  '[CRON CONTINUATION] heartbeat',
  'The reviewed mechanical preflight immediately before this turn updated heartbeat and collected raw inbox, fleet, and cron status.',
  'On the configured Sol model, read HEARTBEAT.md and complete every remaining heartbeat requirement.',
  'Own all interpretation, communication, memory updates, decisions, and priority task work in this turn.',
  'Do not assume the raw preflight output is safe or sufficient, and rerun a preflight command only when verification requires it.',
].join('\n');

const HEARTBEAT_SOL_FALLBACK = [
  '[CRON FALLBACK] heartbeat',
  'The reviewed mechanical preflight did not complete. Do not assume it updated heartbeat or collected any valid state.',
  'On the configured Sol model, read root HEARTBEAT.md and execute the full procedure from its first mandatory step.',
  'Own all interpretation, communication, memory updates, decisions, and priority task work in this turn.',
].join('\n');

function readReviewedPreflight(): { frontmatter: SkillFrontmatter; body: string } | null {
  try {
    if (
      createHash('sha256').update(HEARTBEAT_PREFLIGHT_AUTHORITY).digest('hex')
      !== HEARTBEAT_PREFLIGHT_AUTHORITY_SHA256
    ) return null;

    const content = HEARTBEAT_PREFLIGHT_AUTHORITY.toString('utf8');
    if (!content.startsWith('---\n')) return null;
    const end = content.indexOf('\n---\n', 4);
    if (end < 0) return null;
    const parsed = parseYaml(content.slice(4, end));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const body = content.slice(end + 5).trim();
    if (!body) return null;
    return { frontmatter: parsed as SkillFrontmatter, body };
  } catch {
    return null;
  }
}

function modelLevel(value: string): ModelLevel | null {
  switch (value.trim().toLowerCase()) {
    case CODEX_TERRA_MODEL:
    case 'terra':
      return 0;
    case CODEX_LUN_MODEL:
    case 'lun':
      return 1;
    case CODEX_SOL_MODEL:
    case 'sol':
      return 2;
    default:
      return null;
  }
}

function effortLevel(value: string): ModelLevel | null {
  switch (value.trim().toLowerCase()) {
    case 'low': return 0;
    case 'medium': return 1;
    case 'high': return 2;
    default: return null;
  }
}

export function resolveCodexCronRouting(input: ResolveCronModelInput): CodexCronRoutingPlan | null {
  if (input.runtime !== 'codex-app-server') return null;
  if (input.configuredModel !== CODEX_SOL_MODEL) return null;
  if (input.cron.name !== 'heartbeat' || input.cron.prompt !== CODEX_HEARTBEAT_CRON_PROMPT) return null;

  const skill = readReviewedPreflight();
  if (!skill) return null;
  const { frontmatter } = skill;
  if (
    frontmatter.name !== 'heartbeat-preflight'
    || typeof frontmatter.model !== 'string'
    || typeof frontmatter.effort !== 'string'
  ) return null;

  const pinnedModelLevel = modelLevel(frontmatter.model);
  const pinnedEffortLevel = effortLevel(frontmatter.effort);
  if (pinnedModelLevel === null || pinnedEffortLevel === null) return null;
  const effectiveLevel = Math.max(pinnedModelLevel, pinnedEffortLevel) as ModelLevel;

  return {
    routing: {
      model: MODEL_BY_LEVEL[effectiveLevel],
      cronName: input.cron.name,
      source: 'daemon-cron',
      reason: 'reviewed_mechanical_preflight',
      skillName: 'heartbeat-preflight',
      requestedModel: frontmatter.model,
      effort: frontmatter.effort,
    },
    preflightPrompt: `[CRON PREFLIGHT] heartbeat\n${skill.body}`,
    continuationPrompt: HEARTBEAT_SOL_CONTINUATION,
    fallbackPrompt: HEARTBEAT_SOL_FALLBACK,
  };
}
