import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  CODEX_HEARTBEAT_CRON_PROMPT,
  CODEX_SOL_MODEL,
  CODEX_TERRA_MODEL,
  resolveCodexCronRouting,
} from '../../../src/daemon/cron-model-routing.js';
import {
  HEARTBEAT_PREFLIGHT_AUTHORITY_BASE64,
  HEARTBEAT_PREFLIGHT_AUTHORITY_SHA256,
} from '../../../src/daemon/heartbeat-preflight-authority.js';

const REPOSITORY_ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '../../..');
const PREFLIGHT_RELATIVE =
  'config/codex-cron-routing/heartbeat-preflight.md';

describe('resolveCodexCronRouting', () => {
  let root: string;
  let frameworkRoot: string;
  let agentDir: string;
  let preflightPath: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cron-model-routing-'));
    frameworkRoot = join(root, 'framework');
    agentDir = join(frameworkRoot, 'orgs/acme/agents/alpha');
    preflightPath = join(frameworkRoot, PREFLIGHT_RELATIVE);
    mkdirSync(agentDir, { recursive: true });
    mkdirSync(join(preflightPath, '..'), { recursive: true });
    writeFileSync(preflightPath, readFileSync(join(REPOSITORY_ROOT, PREFLIGHT_RELATIVE)));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function resolve(
    name = 'heartbeat',
    prompt = CODEX_HEARTBEAT_CRON_PROMPT,
    overrides: { runtime?: 'codex-app-server' | 'claude-code'; configuredModel?: string } = {},
  ) {
    return resolveCodexCronRouting({
      cron: { name, prompt },
      frameworkRoot,
      runtime: overrides.runtime ?? 'codex-app-server',
      configuredModel: overrides.configuredModel ?? CODEX_SOL_MODEL,
    });
  }

  it('builds a reviewed Terra preflight followed by a configured-Sol continuation', () => {
    const plan = resolve();
    expect(plan?.routing).toEqual({
      model: CODEX_TERRA_MODEL,
      cronName: 'heartbeat',
      source: 'daemon-cron',
      reason: 'reviewed_mechanical_preflight',
      skillName: 'heartbeat-preflight',
      requestedModel: CODEX_TERRA_MODEL,
      effort: 'low',
    });
    expect(plan?.preflightPrompt).toContain('Do not acknowledge or reply to messages');
    expect(plan?.preflightPrompt).not.toContain('highest priority task');
    expect(plan?.continuationPrompt).toContain('configured Sol model');
    expect(plan?.continuationPrompt).toContain('priority task work');
    expect(plan?.fallbackPrompt).toContain('[CRON FALLBACK] heartbeat');
    expect(plan?.fallbackPrompt).toContain('did not complete');
  });

  it('refuses a heartbeat name paired with a judgment-bearing prompt', () => {
    expect(resolve('heartbeat', 'Investigate the production incident and choose the remediation.')).toBeNull();
  });

  it('keeps cap-watchdog and goal-staleness-alert out of cheap routing', () => {
    expect(resolve('cap-watchdog', 'Read .claude/skills/cap-watchdog/SKILL.md')).toBeNull();
    expect(resolve('goal-staleness-alert', 'Read .claude/skills/goal-staleness-alert/SKILL.md')).toBeNull();
  });

  it('requires the configured judgment model to be Sol before splitting the turn', () => {
    expect(resolve('heartbeat', CODEX_HEARTBEAT_CRON_PROMPT, { configuredModel: 'gpt-5.5' })).toBeNull();
  });

  it('does not route non-Codex runtimes', () => {
    expect(resolve('heartbeat', CODEX_HEARTBEAT_CRON_PROMPT, { runtime: 'claude-code' })).toBeNull();
  });

  it('ignores prompt path substitution and cross-agent skill files', () => {
    const betaSkill = join(frameworkRoot, 'orgs/acme/agents/beta/.claude/skills/heartbeat/SKILL.md');
    mkdirSync(join(betaSkill, '..'), { recursive: true });
    writeFileSync(betaSkill, '---\nname: heartbeat\nmodel: gpt-5.6-terra\neffort: low\n---\n');
    expect(resolve(
      'heartbeat',
      `Read ${betaSkill} and investigate the production incident.`,
    )).toBeNull();
  });

  it('rejects an untracked same-agent prompt-referenced substitute', () => {
    const substitute = join(agentDir, '.claude/skills/heartbeat-preflight/SKILL.md');
    mkdirSync(join(substitute, '..'), { recursive: true });
    writeFileSync(substitute, readFileSync(preflightPath));
    expect(resolve('heartbeat', `Read ${substitute}`)).toBeNull();
  });

  it('routes from bundled authority when the checkout source is missing', () => {
    rmSync(preflightPath);
    expect(resolve()?.routing.model).toBe(CODEX_TERRA_MODEL);
  });

  it('ignores replaced checkout authority bytes at runtime', () => {
    writeFileSync(preflightPath, `${readFileSync(preflightPath, 'utf8')}\nUnreviewed step.\n`);
    expect(resolve()?.preflightPrompt).not.toContain('Unreviewed step');
    expect(resolve()?.routing.model).toBe(CODEX_TERRA_MODEL);
  });

  it('ignores stale valid frontmatter in the checkout source at runtime', () => {
    writeFileSync(preflightPath, [
      '---',
      'name: heartbeat-preflight',
      'model: gpt-5.6-sol',
      'effort: high',
      '---',
      'Perform judgment work.',
      '',
    ].join('\n'));
    expect(resolve()?.routing).toMatchObject({
      model: CODEX_TERRA_MODEL,
      requestedModel: CODEX_TERRA_MODEL,
      effort: 'low',
    });
    expect(resolve()?.preflightPrompt).not.toContain('Perform judgment work');
  });

  it('keeps the repository source bytes in exact parity with bundled authority', () => {
    const source = readFileSync(join(REPOSITORY_ROOT, PREFLIGHT_RELATIVE));
    const bundled = Buffer.from(HEARTBEAT_PREFLIGHT_AUTHORITY_BASE64, 'base64');
    expect(createHash('sha256').update(source).digest('hex'))
      .toBe(HEARTBEAT_PREFLIGHT_AUTHORITY_SHA256);
    expect(bundled.equals(source)).toBe(true);
    expect(resolveCodexCronRouting({
      cron: { name: 'heartbeat', prompt: CODEX_HEARTBEAT_CRON_PROMPT },
      frameworkRoot: REPOSITORY_ROOT,
      runtime: 'codex-app-server',
      configuredModel: CODEX_SOL_MODEL,
    })).toMatchObject({
      routing: {
        model: CODEX_TERRA_MODEL,
        skillName: 'heartbeat-preflight',
        reason: 'reviewed_mechanical_preflight',
      },
      fallbackPrompt: expect.stringContaining('[CRON FALLBACK] heartbeat'),
    });
  });
});
