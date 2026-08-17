/**
 * skill-autopr.ts — `cortextos bus create-skill-pr <skill-name>`
 *
 * Called by hook-skill-autopr.ts (as a background process) after a community
 * skill is written or modified. Handles the git operations and draft PR creation
 * so the hook can return immediately without blocking the agent.
 *
 * Steps:
 *  1. Locate the skill file and validate it exists
 *  2. Check whether a PR for this skill is already open (avoid duplicates)
 *  3. Create a branch community/skill/<name>-<timestamp>
 *  4. Stage and commit the skill directory
 *  5. Push the branch
 *  6. Open a draft PR with a mandatory security checklist in the body
 *  7. Log the result
 *
 * Requires: git, gh CLI (GitHub CLI) in PATH.
 * Safe to re-run: duplicate detection prevents multiple open PRs for the same skill.
 */

import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'fs';
import { basename, join } from 'path';
import { tmpdir } from 'os';
import { spawnSync } from 'child_process';
import { scanForSecurityIssues, validateFrontmatter } from '../hooks/hook-skill-autopr.js';

const UPSTREAM_REPO = 'grandamenium/cortextos';

/**
 * Skill names must be lowercase alphanumeric slugs.
 * This prevents shell injection when the name is interpolated into run() commands.
 */
const SKILL_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/**
 * Run a shell command and return its stdout, or throw on non-zero exit.
 */
function run(cmd: string, cwd: string): string {
  const result = spawnSync('bash', ['-c', cmd], { cwd, encoding: 'utf-8' });
  if (result.status !== 0) {
    const err = result.stderr?.trim() || result.stdout?.trim() || 'unknown error';
    throw new Error(`Command failed (${result.status}): ${cmd}\n${err}`);
  }
  return result.stdout?.trim() || '';
}

/**
 * Check if a draft PR is already open for this skill branch prefix.
 * Returns the PR URL if found, null otherwise.
 * Logs auth/network failures to stderr rather than silently masking them.
 */
function findExistingPR(skillName: string, cwd: string): string | null {
  try {
    const out = run(
      `gh pr list --repo ${UPSTREAM_REPO} --state open --json headRefName,url ` +
      `--jq '.[] | select(.headRefName | startswith("community/skill/${skillName}-")) | .url'`,
      cwd,
    );
    return out.trim() || null;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Log authentication or network errors so they surface in daemon logs
    if (/auth|token|credential|network|timeout|permission/i.test(msg)) {
      process.stderr.write(`skill-autopr: gh pr list failed (possible auth issue): ${msg}\n`);
    }
    return null;
  }
}

/**
 * Build the draft PR body with security checklist and scan results.
 */
function buildPrBody(
  skillName: string,
  description: string,
  securityFlags: string[],
  warnings: string[],
): string {
  const securityStatus = securityFlags.length === 0
    ? '✅ Automated scan passed — no obvious injection or exfiltration patterns detected.'
    : `⚠️ **Automated scan flagged ${securityFlags.length} issue(s) — human review required:**\n${securityFlags.map(f => `  - ${f}`).join('\n')}`;

  const warningBlock = warnings.length > 0
    ? `\n**Frontmatter warnings:**\n${warnings.map(w => `- ${w}`).join('\n')}\n`
    : '';

  return `## New Community Skill: \`${skillName}\`

**Description:** ${description}
${warningBlock}
---

## Security Scan

${securityStatus}

> This scan is heuristic-only. Human review is mandatory before merging.
> See Snyk ToxicSkills report: 13.4% of published community skills contain critical vulnerabilities.

---

## Reviewer Checklist (required before merge)

- [ ] Description accurately explains what the skill does and when to use it
- [ ] No hardcoded credentials, API keys, or tokens in skill content
- [ ] No exfiltration code (curl to external URLs, webhook calls, data uploads)
- [ ] No prompt injection (hidden instructions, "ignore previous instructions", conditional exfiltration)
- [ ] Scripts (if any) are minimal, documented, and do not execute arbitrary code
- [ ] \`external_calls\` field accurately reflects all network calls the skill makes
- [ ] \`triggers\` field contains appropriate activation phrases
- [ ] \`license\` field present if skill includes third-party content

---

🤖 Auto-staged by cortextos hook-skill-autopr | Draft PR — do not merge without checklist sign-off`;
}

export async function createSkillPr(skillName: string): Promise<void> {
  // Validate skill name is a safe slug — prevents shell injection and path traversal
  if (!SKILL_NAME_RE.test(skillName)) {
    throw new Error(
      `Invalid skill name "${skillName}" — must match [a-z0-9][a-z0-9_-]{0,63} (alphanumeric slug only)`,
    );
  }

  const frameworkRoot = process.env.CTX_FRAMEWORK_ROOT || process.cwd();

  // Path traversal check: resolved skill dir must stay inside community/skills/
  const communitySkillsDir = join(frameworkRoot, 'community', 'skills');
  const skillDir = join(communitySkillsDir, skillName);
  if (!skillDir.startsWith(communitySkillsDir + '/') && skillDir !== communitySkillsDir) {
    throw new Error(`Skill path "${skillDir}" escapes the community/skills directory`);
  }

  const skillFile = join(skillDir, 'SKILL.md');

  if (!existsSync(skillFile)) {
    throw new Error(`Skill file not found: ${skillFile}`);
  }

  const content = readFileSync(skillFile, 'utf-8');

  // Re-validate frontmatter (hook already checked, but be defensive)
  const validation = validateFrontmatter(content, skillName);
  if (!validation.valid) {
    throw new Error(`Invalid frontmatter for skill "${skillName}": ${validation.error}`);
  }

  // Security scan
  const security = scanForSecurityIssues(content);

  // Check for existing open PR (duplicate prevention)
  const existing = findExistingPR(skillName, frameworkRoot);
  if (existing) {
    console.log(`Skill PR already open for "${skillName}": ${existing}`);
    return;
  }

  // Create a new branch
  const ts = Math.floor(Date.now() / 1000);
  const branch = `community/skill/${skillName}-${ts}`;

  // Save the skill file content now, before any branch switching.
  // `git checkout -` at the end returns to the original branch, which resets
  // tracked files to their committed state — losing uncommitted changes written
  // by the hook that triggered us. We restore the file after switching back.
  const skillFileContentBeforeBranch = readFileSync(skillFile, 'utf-8');

  let bodyFile: string | null = null;

  try {
    // Fetch latest upstream, then branch from origin/main
    // Failing to fetch is non-fatal — we'll still branch from whatever origin/main is cached
    run('git fetch origin main 2>/dev/null || git fetch upstream main 2>/dev/null || true', frameworkRoot);
    run(`git checkout -b ${branch} origin/main`, frameworkRoot);

    // Restore the skill file on the new branch — git checkout from origin/main
    // would have reset it to the committed version, losing our uncommitted write.
    writeFileSync(skillFile, skillFileContentBeforeBranch, 'utf-8');

    // Stage only the skill directory
    run(`git add community/skills/${skillName}/`, frameworkRoot);

    // Check if there's anything to commit
    const status = run('git diff --cached --name-only', frameworkRoot);
    if (!status) {
      throw new Error(`Nothing staged for skill "${skillName}" — file may not have changed`);
    }

    // Commit
    run(
      `git commit -m "community: add skill ${skillName}\n\nAuto-staged by hook-skill-autopr.\n\nCo-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"`,
      frameworkRoot,
    );

    // Push
    run(`git push origin ${branch}`, frameworkRoot);

    // Write PR body to a temp file so multi-line content is passed correctly
    // (bash -c with inline JSON.stringify flattens \n — body-file preserves formatting)
    const description = (validation.frontmatter.description as string) || '';
    const body = buildPrBody(skillName, description, security.flags, validation.warnings);
    const title = `community: add skill ${skillName}`;

    bodyFile = join(tmpdir(), `skill-pr-body-${ts}.txt`);
    writeFileSync(bodyFile, body, 'utf-8');

    const prUrl = run(
      `gh pr create --repo ${UPSTREAM_REPO} --draft ` +
      `--title ${JSON.stringify(title)} ` +
      `--body-file ${JSON.stringify(bodyFile)} ` +
      `--head ${branch}`,
      frameworkRoot,
    );

    console.log(`Draft PR created for skill "${skillName}": ${prUrl}`);

    // Return to original branch, then restore the skill file so the working
    // tree reflects the content that was written before we branched.
    run('git checkout -', frameworkRoot);
    writeFileSync(skillFile, skillFileContentBeforeBranch, 'utf-8');
  } catch (err) {
    // Attempt cleanup: return to original branch and restore file
    try {
      run('git checkout -', frameworkRoot);
      writeFileSync(skillFile, skillFileContentBeforeBranch, 'utf-8');
    } catch { /* ignore */ }
    throw err;
  } finally {
    // Clean up temp body file
    if (bodyFile) {
      try { unlinkSync(bodyFile); } catch { /* ignore */ }
    }
  }
}

// ─── Skill-audit apply-loop PR (weekly-review Phase 1C, orchestration-upgrade Tip 1 P1) ───

/**
 * Parse "owner/repo" out of a GitHub remote URL (https or ssh).
 * Exported for unit testing.
 */
export function parseOriginSlug(url: string): string {
  const m = url.trim().match(/github\.com[:/](.+?)(?:\.git)?\/?$/);
  if (!m || !m[1].includes('/')) {
    throw new Error(`Cannot parse owner/repo from origin remote URL: ${url}`);
  }
  return m[1];
}

/**
 * Build the draft PR body for a skill-audit apply-loop PR.
 * Exported for unit testing.
 */
export function buildAuditPrBody(
  skillName: string,
  stagedPaths: string[],
  conflicts: string[],
  receipt?: {
    population: string;
    expectedPopulation: number;
    registryEnumeratedPopulation: number;
    observedPopulation: number;
  },
): string {
  const staged = stagedPaths.map((p) => `- \`${p}\``).join('\n');
  const conflictBlock = conflicts.length > 0
    ? `\n## Cascade Conflicts (manual follow-up required)\n\n${conflicts.map((c) => `- \`${c}\``).join('\n')}\n`
    : '';
  return `## Skill-Audit Apply Loop: \`${skillName}\`

Applies an ACCEPTED skill-optimizer audit diff to the canonical skill home and cascades it to every mirror/deployed copy (template-first + cascade, per orchestration-upgrade-plan-2026-07-01 Tip 1 P1).

## Population receipt

- Population: \`${receipt?.population ?? 'UNSPECIFIED'}\`
- Expected: ${receipt?.expectedPopulation ?? 'UNSPECIFIED'}
- Registry-enumerated: ${receipt?.registryEnumeratedPopulation ?? 'UNSPECIFIED'}
- Observed: ${receipt?.observedPopulation ?? 'UNSPECIFIED'}

## Files updated

${staged}
${conflictBlock}
## Reviewer checklist

- [ ] Diff matches the accepted skill-improvement/<skill>/*-diff.patch verdict from weekly review
- [ ] Canonical template/shared-skills home updated (not only a per-agent deployed copy)
- [ ] Cascaded copies stay in sync: \`node scripts/skill-drift-check.mjs --tier ci\` is green
- [ ] history.json marked diff_applied:true for the applied run

---

Auto-staged by \`cortextos bus create-skill-audit-pr\` (weekly-review Phase 1C)`;
}

type AuditReceipt = {
  population: string;
  expectedPopulation: number;
  registryEnumeratedPopulation: number;
  observedPopulation: number;
};

export function selectAuditTargets(
  targets: Array<{ layout: string; relativePath: string }>,
  layouts?: string[],
): string[] {
  const selected = layouts ? new Set(layouts) : null;
  return targets
    .filter((target) => !selected || selected.has(target.layout))
    .map((target) => target.relativePath);
}

/**
 * Reconcile changed files against registry-returned target directories. The
 * changed set is observational evidence only; it never defines completeness.
 */
export function reconcileAuditTargets(
  changedPaths: string[],
  expectedTargetDirs: string[],
  receipt: AuditReceipt,
): string[] {
  if (
    receipt.expectedPopulation !== receipt.registryEnumeratedPopulation ||
    receipt.expectedPopulation !== receipt.observedPopulation
  ) {
    throw new Error(
      `Population receipt mismatch for ${receipt.population}: expected=${receipt.expectedPopulation} registry=${receipt.registryEnumeratedPopulation} observed=${receipt.observedPopulation}`,
    );
  }
  const normalizedTargets = [...new Set(expectedTargetDirs.map((path) => path.replace(/\/$/, '')))].sort();
  const coverage = new Set<string>();
  const extra: string[] = [];
  for (const changed of changedPaths) {
    const target = normalizedTargets.find((candidate) => changed === candidate || changed.startsWith(`${candidate}/`));
    if (target) coverage.add(target);
    else extra.push(changed);
  }
  const missing = normalizedTargets.filter((target) => !coverage.has(target));
  if (missing.length || extra.length) {
    throw new Error(
      `Skill-audit population incomplete; missing=${missing.join(',') || '(none)'} extra=${extra.join(',') || '(none)'}`,
    );
  }
  return [...changedPaths].sort();
}

type MirrorGroup = {
  skill?: unknown;
  canonical?: unknown;
  mirrors?: unknown;
  population?: unknown;
  layouts?: unknown;
  expectedPopulation?: unknown;
  expectedTrackedPopulation?: unknown;
};

export function selectMirrorAuditTargets(group: MirrorGroup): string[] {
  if (typeof group.canonical !== 'string' || !Array.isArray(group.mirrors) ||
      group.mirrors.some((path) => typeof path !== 'string')) {
    throw new Error(`Mirror group ${String(group.skill)} has invalid canonical/mirrors topology`);
  }
  const targets = [group.canonical, ...(group.mirrors as string[])];
  for (const target of targets) {
    if (target.startsWith('/') || target.split('/').includes('..')) {
      throw new Error(`Mirror group ${String(group.skill)} has unsafe target: ${target}`);
    }
  }
  if (new Set(targets).size !== targets.length) {
    throw new Error(`Mirror group ${String(group.skill)} has duplicate targets`);
  }
  if (!Number.isSafeInteger(group.expectedPopulation) || group.expectedPopulation !== targets.length) {
    throw new Error(
      `Mirror group ${String(group.skill)} total population mismatch: expected=${String(group.expectedPopulation)} declared=${targets.length}`,
    );
  }
  if (!Number.isSafeInteger(group.expectedTrackedPopulation) || Number(group.expectedTrackedPopulation) < 0) {
    throw new Error(`Mirror group ${String(group.skill)} has invalid expectedTrackedPopulation`);
  }
  return targets.sort();
}

export function loadAuditPopulation(frameworkRoot: string, skillName: string): {
  receipt: AuditReceipt;
  targets: string[];
} {
  const manifest = JSON.parse(readFileSync(join(frameworkRoot, 'scripts/skill-mirrors.json'), 'utf8')) as MirrorGroup[];
  const group = manifest.find((entry) => entry.skill === skillName);
  if (!group) {
    throw new Error(`Skill-audit "${skillName}" has no named population or explicit mirror group`);
  }
  if (typeof group.population !== 'string') {
    // Audit PRs can stage only the framework repository's tracked members.
    // Local-tier runtime mirrors remain declared and checked by skill-drift,
    // but cannot be smuggled into a clean-checkout PR receipt.
    const targets = selectMirrorAuditTargets(group).filter((target) => {
      const tracked = spawnSync('git', ['-C', frameworkRoot, 'ls-files', '--', target], {
        encoding: 'utf8',
      });
      if (tracked.status !== 0) {
        throw new Error(`Cannot determine tracked mirror status for ${target}: ${tracked.stderr || tracked.stdout}`);
      }
      return Boolean((tracked.stdout || '').trim());
    });
    if (targets.length !== group.expectedTrackedPopulation) {
      throw new Error(
        `Mirror group ${skillName} tracked population mismatch: expected=${String(group.expectedTrackedPopulation)} observed=${targets.length}`,
      );
    }
    const observed = targets.filter((target) => existsSync(join(frameworkRoot, target, 'SKILL.md'))).length;
    return {
      receipt: {
        population: `skill-mirrors:${skillName}`,
        expectedPopulation: targets.length,
        registryEnumeratedPopulation: targets.length,
        observedPopulation: observed,
      },
      targets,
    };
  }
  const result = spawnSync(process.execPath, [
    join(frameworkRoot, 'scripts/fleet-population.mjs'), 'paths',
    '--registry', join(frameworkRoot, 'scripts/fleet-populations.json'),
    '--root', frameworkRoot,
    '--population', group.population,
    '--skill', skillName,
    '--format', 'json',
  ], { cwd: frameworkRoot, encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`Population preflight failed for ${skillName}:\n${result.stdout || result.stderr}`);
  }
  const payload = JSON.parse((result.stdout || '').trim().split('\n').at(-1) || '{}');
  return {
    receipt: payload.receipt,
    targets: selectAuditTargets(
      payload.targets,
      Array.isArray(group.layouts) ? group.layouts as string[] : undefined,
    ),
  };
}

/**
 * createSkillAuditPr — `cortextos bus create-skill-audit-pr <skill-name>`
 *
 * Weekly-review apply loop: after an accepted skill-optimizer diff has been
 * applied to the canonical skill home and cascaded to mirrors/deployed copies
 * in the working tree, this commits EVERY modified copy of that skill
 * (templates/, orgs/, community/) on a skill-audit/<name>-<ts> branch off
 * origin/main and opens a draft PR against the ORIGIN repo (not the community
 * upstream). Mirrors createSkillPr's save/branch/restore mechanics.
 */
export async function createSkillAuditPr(skillName: string): Promise<void> {
  if (!SKILL_NAME_RE.test(skillName)) {
    throw new Error(
      `Invalid skill name "${skillName}" — must match [a-z0-9][a-z0-9_-]{0,63} (alphanumeric slug only)`,
    );
  }

  const frameworkRoot = process.env.CTX_FRAMEWORK_ROOT || process.cwd();

  // Resolve the registry topology before interpreting the dirty tree. The
  // changed set remains evidence, never the source of completeness.
  const auditPopulation = loadAuditPopulation(frameworkRoot, skillName);
  const topologySkillNames = new Set(auditPopulation.targets.map((target) => basename(target)));

  // Collect every modified tracked copy of this skill in the working tree.
  const porcelain = run('git status --porcelain', frameworkRoot);
  const changed = porcelain
    .split('\n')
    .filter(Boolean)
    .map((l) => l.slice(3).trim())
    .filter(
      (p) =>
        [...topologySkillNames].some((name) =>
          p.includes(`/skills/${name}/`) || p.includes(`/shared-skills/${name}/`)),
    )
    .filter(
      (p) =>
        p.startsWith('templates/') ||
        p.startsWith('orgs/') ||
        p.startsWith('community/'),
    );

  if (changed.length === 0) {
    throw new Error(
      `No modified copies of skill "${skillName}" found in the working tree — apply the accepted diff first, then re-run`,
    );
  }

  // Population proof happens before remote lookup, branch creation, staging,
  // history mutation, or any other side effect.
  reconcileAuditTargets(changed, auditPopulation.targets, auditPopulation.receipt);
  const repoSlug = parseOriginSlug(run('git remote get-url origin', frameworkRoot));

  // Duplicate-PR guard on the skill-audit/<name>- branch prefix.
  let existing: string | null = null;
  try {
    existing =
      run(
        `gh pr list --repo ${repoSlug} --state open --json headRefName,url ` +
          `--jq '.[] | select(.headRefName | startswith("skill-audit/${skillName}-")) | .url'`,
        frameworkRoot,
      ).trim() || null;
  } catch {
    existing = null;
  }
  if (existing) {
    console.log(`Skill-audit PR already open for "${skillName}": ${existing}`);
    return;
  }

  // Save modified contents before branch switching — `git checkout` resets
  // tracked files to committed state (same rationale as createSkillPr).
  const saved = new Map<string, string>();
  for (const p of changed) {
    saved.set(p, readFileSync(join(frameworkRoot, p), 'utf-8'));
  }

  const ts = Math.floor(Date.now() / 1000);
  const branch = `skill-audit/${skillName}-${ts}`;
  let bodyFile: string | null = null;

  try {
    run('git fetch origin main 2>/dev/null || true', frameworkRoot);
    run(`git checkout -b ${branch} origin/main`, frameworkRoot);

    for (const [p, content] of saved) {
      writeFileSync(join(frameworkRoot, p), content, 'utf-8');
    }
    for (const p of changed) {
      run(`git add ${JSON.stringify(p)}`, frameworkRoot);
    }

    const status = run('git diff --cached --name-only', frameworkRoot);
    if (!status) {
      throw new Error(
        `Nothing staged for skill-audit "${skillName}" — files may already match origin/main`,
      );
    }

    run(
      `git commit -m "skill-audit: apply ${skillName} audit diff (template-first + cascade)\n\nAuto-staged by cortextos bus create-skill-audit-pr (weekly-review apply loop)."`,
      frameworkRoot,
    );
    run(`git push origin ${branch}`, frameworkRoot);

    const body = buildAuditPrBody(skillName, changed, [], auditPopulation.receipt);
    bodyFile = join(tmpdir(), `skill-audit-pr-body-${ts}.txt`);
    writeFileSync(bodyFile, body, 'utf-8');

    const prUrl = run(
      `gh pr create --repo ${repoSlug} --draft ` +
        `--title ${JSON.stringify(`skill-audit: apply ${skillName} audit diff`)} ` +
        `--body-file ${JSON.stringify(bodyFile)} ` +
        `--head ${branch}`,
      frameworkRoot,
    );
    console.log(`Draft skill-audit PR created for "${skillName}": ${prUrl}`);

    run('git checkout -', frameworkRoot);
    for (const [p, content] of saved) {
      writeFileSync(join(frameworkRoot, p), content, 'utf-8');
    }
  } catch (err) {
    try {
      run('git checkout -', frameworkRoot);
      for (const [p, content] of saved) {
        writeFileSync(join(frameworkRoot, p), content, 'utf-8');
      }
    } catch {
      /* ignore */
    }
    throw err;
  } finally {
    if (bodyFile) {
      try {
        unlinkSync(bodyFile);
      } catch {
        /* ignore */
      }
    }
  }
}

// No require.main === module guard here — skill-autopr.ts is bundled into cli.js
// by tsup (splitting: false) so that check would always be true and fire on every
// CLI invocation. The CLI entry point is bus.ts, which registers create-skill-pr
// as a Commander subcommand and calls createSkillPr() from there.
