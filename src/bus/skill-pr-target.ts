import { spawnSync } from 'node:child_process';

export const SKILL_PR_TARGET_GIT_KEY = 'cortextos.skillPrTarget';
export const ALLOWED_SKILL_PR_TARGETS = new Set([
  'noogalabs/ascendops',
  'grandamenium/cortextos',
]);

export function resolveSkillPrTarget(frameworkRoot: string): string {
  const result = spawnSync('git', ['config', '--local', '--get', SKILL_PR_TARGET_GIT_KEY], {
    cwd: frameworkRoot,
    encoding: 'utf8',
  });
  const target = result.status === 0 ? (result.stdout || '').trim() : '';
  if (!target) {
    throw new Error(
      `Missing install-level ${SKILL_PR_TARGET_GIT_KEY}. Re-run install.mjs in this checkout before creating skill PRs; no repository default is permitted.`,
    );
  }
  if (!ALLOWED_SKILL_PR_TARGETS.has(target)) {
    throw new Error(
      `Invalid install-level ${SKILL_PR_TARGET_GIT_KEY} value "${target}". ` +
      `Allowed values: ${[...ALLOWED_SKILL_PR_TARGETS].join(', ')}. Re-run install.mjs after human confirmation.`,
    );
  }
  return target;
}
