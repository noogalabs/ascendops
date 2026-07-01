// Onboarding skill: ONE canonical source, per-role at scaffold time.
//
// The reverse-prompt onboarding skill used to live as a full ~140-line COPY inside
// every agent template (templates/<name>/.claude/skills/onboarding/SKILL.md). Those
// copies drift. They are now a SINGLE canonical file
// (templates/_shared/onboarding/SKILL.md) carrying role-conditional blocks, plus a
// 1-word `.claude/skills/onboarding/role` marker per template. At scaffold time
// add-agent reduces the canonical to the template's role and writes the agent's
// SKILL.md. strip(canonical, role) is byte-identical to the old per-role copy, locked
// by tests/fixtures/onboarding-golden/*.md.

import { Command } from 'commander';
import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'fs';
import { join, resolve, basename } from 'path';

export type OnboardingRole = 'worker' | 'orchestrator' | 'analyst';
const VALID_ROLES: readonly OnboardingRole[] = ['worker', 'orchestrator', 'analyst'];

/**
 * Reduce the canonical onboarding skill to the SKILL.md for one role.
 *
 * The canonical carries role-conditional blocks:
 *   <!--ROLE worker,analyst-->  ...lines...  <!--/ROLE-->
 * A block whose comma-separated role list includes `role` keeps its inner lines
 * (the two marker lines are dropped); any other block is removed entirely. Lines
 * outside any block pass through unchanged. By construction the output is
 * byte-identical to the old per-template copy for that role.
 */
export function stripOnboardingRole(canonical: string, role: string): string {
  const out: string[] = [];
  let active: { keep: boolean } | null = null;
  // Markers must be flat (no nesting) and exactly `<!--ROLE roles-->` / `<!--/ROLE-->`.
  // Match on a \r-trimmed probe so a CRLF checkout (git core.autocrlf) still recognizes
  // them, but EMIT the original line (with its \r, if any) so per-platform line endings
  // and byte-equality are preserved on both LF and CRLF. Anything that looks like a ROLE
  // marker but is malformed, nested, or unbalanced throws (fail-loud, like
  // materializeOnboardingSkill) rather than silently leaking a role block.
  const open = /^<!--ROLE ([a-z,]+)-->$/;
  const looksLikeMarker = /^<!--\s*\/?\s*ROLE\b/i;
  for (const line of canonical.split('\n')) {
    const probe = line.endsWith('\r') ? line.slice(0, -1) : line;
    const m = probe.match(open);
    if (m) {
      if (active) {
        throw new Error('nested <!--ROLE--> block in onboarding canonical (strip is flat, not nested)');
      }
      active = { keep: m[1].split(',').includes(role) };
      continue;
    }
    if (probe === '<!--/ROLE-->') {
      if (!active) throw new Error('unmatched <!--/ROLE--> in onboarding canonical');
      active = null;
      continue;
    }
    if (looksLikeMarker.test(probe)) {
      throw new Error(`malformed ROLE marker in onboarding canonical: ${JSON.stringify(line)}`);
    }
    if (active && !active.keep) continue;
    out.push(line);
  }
  if (active) throw new Error('unclosed <!--ROLE--> block in onboarding canonical');
  return out.join('\n');
}

/**
 * Resolve the shared canonical onboarding skill across the SAME roots add-agent
 * uses for templates, so it resolves on a fresh (npm) install too. Returns the
 * absolute path or null if not found.
 */
export function resolveCanonicalOnboarding(projectRoot: string): string | null {
  const frameworkRoot = process.env.CTX_FRAMEWORK_ROOT || projectRoot;
  const rel = join('templates', '_shared', 'onboarding', 'SKILL.md');
  const candidates = [
    join(projectRoot, rel),
    join(frameworkRoot, rel),
    join(projectRoot, 'node_modules', 'cortextos', rel),
    // Relative to this file for development
    join(__dirname, '..', '..', rel),
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return null;
}

/**
 * After a template is copied into a new agent, materialize its onboarding skill
 * from the shared canonical.
 *
 * A template declares it wants onboarding by carrying a 1-word
 * `.claude/skills/onboarding/role` marker (worker|orchestrator|analyst) instead of
 * a full SKILL.md copy. This reads the marker, strips the canonical to that role,
 * writes SKILL.md (with the same {{placeholder}} substitution copyTemplateFiles
 * applies), and removes the marker. A template with no marker gets no onboarding
 * skill (unchanged behavior). Throws on an unknown role or a missing canonical
 * rather than silently producing a broken agent.
 */
export function materializeOnboardingSkill(
  agentDir: string,
  projectRoot: string,
  name: string,
  org: string,
): void {
  const onbDir = join(agentDir, '.claude', 'skills', 'onboarding');
  const rolePath = join(onbDir, 'role');
  if (!existsSync(rolePath)) return; // template has no onboarding skill

  const role = readFileSync(rolePath, 'utf-8').trim();
  if (!VALID_ROLES.includes(role as OnboardingRole)) {
    throw new Error(
      `onboarding role marker '${role}' in ${rolePath} is invalid (expected ${VALID_ROLES.join('|')})`,
    );
  }

  const canonicalPath = resolveCanonicalOnboarding(projectRoot);
  if (!canonicalPath) {
    throw new Error(
      'canonical onboarding skill not found at templates/_shared/onboarding/SKILL.md ' +
        '(looked in projectRoot, CTX_FRAMEWORK_ROOT, node_modules/cortextos)',
    );
  }

  let content = stripOnboardingRole(readFileSync(canonicalPath, 'utf-8'), role);
  // Mirror copyTemplateFiles' placeholder substitution. Onboarding carries no
  // placeholders today, but staying consistent means future ones Just Work.
  content = content
    .replace(/\{\{agent_name\}\}/g, name)
    .replace(/\{\{org\}\}/g, org)
    .replace(/\{\{current_timestamp\}\}/g, new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'));

  writeFileSync(join(onbDir, 'SKILL.md'), content, 'utf-8');
  unlinkSync(rolePath);
}

/**
 * `cortextos materialize-onboarding <agent-dir>`: materialize the onboarding skill for
 * an agent created by a RAW template copy (the documented manual `cp -r` path), which
 * does not run add-agent's programmatic materialization. Idempotent and safe to run
 * after any copy: a no-op when there is no role marker (already materialized, or the
 * template had no onboarding skill).
 */
export const materializeOnboardingCommand = new Command('materialize-onboarding')
  .description('Materialize the onboarding skill for an agent from a raw template copy (idempotent)')
  .argument('<agent-dir>', 'Agent directory, e.g. orgs/<org>/agents/<name>')
  .action((agentDirArg: string) => {
    const agentDir = resolve(agentDirArg);
    // Resolve the project root so the shared canonical is found on a fresh install:
    // CTX_FRAMEWORK_ROOT if set, else walk up from <root>/orgs/<org>/agents/<name>.
    const projectRoot = process.env.CTX_FRAMEWORK_ROOT
      ? resolve(process.env.CTX_FRAMEWORK_ROOT)
      : resolve(agentDir, '..', '..', '..', '..');
    // name/org only feed {{placeholder}} substitution (onboarding has none today).
    const name = basename(agentDir);
    const org = basename(resolve(agentDir, '..', '..'));
    const hadMarker = existsSync(join(agentDir, '.claude', 'skills', 'onboarding', 'role'));
    materializeOnboardingSkill(agentDir, projectRoot, name, org);
    console.log(
      hadMarker
        ? `materialize-onboarding: wrote .claude/skills/onboarding/SKILL.md for ${name}`
        : `materialize-onboarding: no role marker in ${agentDir} (no-op)`,
    );
  });
