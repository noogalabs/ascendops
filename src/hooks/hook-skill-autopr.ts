/**
 * hook-skill-autopr.ts — PostToolUse hook.
 *
 * Fires after every Write or Edit tool call. When the target file is a
 * community skill (community/skills/<name>/SKILL.md relative to the
 * framework root), this hook:
 *
 *  1. Validates required agentskills.io-compatible frontmatter
 *     (name + description are mandatory; triggers and external_calls recommended)
 *  2. Runs a lightweight security scan for injection/exfiltration patterns
 *     (inspired by Cisco skill-scanner — 13.4% of community skills are malicious)
 *  3. If valid, spawns a background `cortextos bus create-skill-pr <name>`
 *     process that stages, commits, pushes, and opens a DRAFT PR against
 *     grandamenium/cortextos with a mandatory security checklist in the body.
 *
 * The hook always exits 0 — it never blocks the agent. All errors are
 * logged to stderr and silently ignored (PostToolUse hooks must not disrupt
 * normal tool execution).
 *
 * Security design:
 * - Draft PRs only — human review (James) required before merge
 * - Security checklist injected into every PR body
 * - Suspicious skills are flagged in the PR body rather than silently accepted
 * - No skill is ever auto-loaded from an external source
 */

import { readFileSync, existsSync } from 'fs';
import { join, resolve } from 'path';
import { spawn } from 'child_process';
import { readStdin, parseHookInput } from './index.js';

import { stripSessionCredentialFromEnv } from '../utils/env.js';
import { hookBootstrap } from './bootstrap.js';
import { scanForSecurityIssues, validateFrontmatter, parseFrontmatter } from './skill-validators.js';
export type { SkillFrontmatter, FrontmatterValidation, SecurityScanResult } from './skill-validators.js';
export { scanForSecurityIssues, validateFrontmatter, parseFrontmatter } from './skill-validators.js';
// ── Types ────────────────────────────────────────────────────────────────────




// ── Frontmatter parsing ───────────────────────────────────────────────────────

/**
 * Parse YAML frontmatter from a SKILL.md file.
 * Handles only the simple scalar/array types used by agentskills.io.
 * Exported for unit testing.
 */

/**
 * Validate frontmatter against agentskills.io required fields.
 * Exported for unit testing.
 */

// ── Security scan ─────────────────────────────────────────────────────────────

/**
 * Lightweight security scan for common skill injection and exfiltration patterns.
 *
 * Inspired by Cisco skill-scanner findings and the Snyk ToxicSkills report
 * (13.4% of 3,984 published skills contained critical vulnerabilities, including
 * prompt injection, base64-encoded payloads, reverse shells, and credential theft).
 *
 * This is a heuristic filter — not a guarantee. Human review (James) is required
 * before any community skill is merged. The scan results appear in the PR body.
 *
 * Exported for unit testing.
 */

// ── PR creation ───────────────────────────────────────────────────────────────

/**
 * Spawn a background process to create the draft PR.
 * The hook exits immediately after spawning — never blocks the agent.
 */
function spawnPrCreation(skillName: string, cliPath: string): void {
  const child = spawn(
    process.execPath,
    [cliPath, 'bus', 'create-skill-pr', skillName],
    {
      detached: true,
      stdio: 'ignore',
      env: stripSessionCredentialFromEnv(process.env),
    },
  );
  child.unref(); // don't keep the hook process alive
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  // PROCESS LINEAGE IS NOT INTENT — see bootstrap.ts.
  // main() is invoked at module scope below, so importing a hook module runs
  // hookBootstrap(). Shared validators live in skill-validators.ts specifically
  // so bus code never imports a hook module merely to reuse its exports; that
  // extraction, not main() placement, fixed the credential-loss regression.
  hookBootstrap();
  const raw = await readStdin();
  const { tool_name, tool_input } = parseHookInput(raw);

  // Pre-filtered to Write/Edit by settings.json matcher — guard here too in case
  // hook is invoked manually or registration changes.
  if (tool_name !== 'Write' && tool_name !== 'Edit') return;

  const filePath = (tool_input.file_path as string | undefined) || '';
  if (!filePath) return;

  const frameworkRoot = resolve(process.env.CTX_FRAMEWORK_ROOT || process.cwd());
  const communitySkillsRoot = join(frameworkRoot, 'community', 'skills');

  // Resolve both paths to avoid relative-path or symlink confusion, then check:
  //  1. The resolved file path must sit inside community/skills/
  //  2. The filename must be exactly SKILL.md (case-sensitive)
  //  3. The directory depth must be exactly one level below community/skills/
  const resolvedFile = resolve(filePath);
  if (!resolvedFile.startsWith(communitySkillsRoot + '/')) return;

  const rel = resolvedFile.slice(communitySkillsRoot.length + 1); // strip prefix + slash
  const skillMatch = rel.match(/^([a-z0-9][a-z0-9_-]{0,63})\/SKILL\.md$/);
  if (!skillMatch) return;

  const skillName = skillMatch[1];

  // Read the skill content
  if (!existsSync(filePath)) return;
  let content: string;
  try {
    content = readFileSync(filePath, 'utf-8');
  } catch {
    process.stderr.write(`hook-skill-autopr: could not read ${filePath}\n`);
    return;
  }

  // Validate frontmatter
  const validation = validateFrontmatter(content, skillName);
  if (!validation.valid) {
    process.stderr.write(
      `hook-skill-autopr: skill "${skillName}" skipped — invalid frontmatter: ${validation.error}\n`,
    );
    return;
  }

  for (const w of validation.warnings) {
    process.stderr.write(`hook-skill-autopr: [warn] ${skillName}: ${w}\n`);
  }

  // Spawn background PR creation (fire-and-forget)
  const cliPath = join(__dirname, '..', 'cli.js');
  spawnPrCreation(skillName, cliPath);
  process.stderr.write(`hook-skill-autopr: queued draft PR for skill "${skillName}"\n`);
}

main().catch(err => {
  process.stderr.write(`hook-skill-autopr: error — ${err}\n`);
  process.exit(0); // always exit 0 — never block tool execution
});
