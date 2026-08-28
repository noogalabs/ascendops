import { execFileSync } from 'node:child_process';

export const MEMBER_SKILL_PR_TARGET = 'noogalabs/ascendops';
export const CANONICAL_SKILL_PR_TARGET = 'grandamenium/cortextos';
export const SKILL_PR_TARGET_GIT_KEY = 'cortextos.skillPrTarget';

function githubSlug(url) {
  const match = String(url || '').trim().match(/github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?$/i);
  return match ? match[1].toLowerCase() : '';
}

export function skillPrTargetForOrigin(originUrl) {
  const slug = githubSlug(originUrl);
  if (!slug || slug === 'noogalabs/ascendops' || slug === 'grandamenium/cortextos') {
    return CANONICAL_SKILL_PR_TARGET;
  }
  return MEMBER_SKILL_PR_TARGET;
}

export function persistSkillPrTarget(installDir) {
  let originUrl = '';
  try {
    originUrl = execFileSync('git', ['remote', 'get-url', 'origin'], {
      cwd: installDir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    // Plain/canonical installs intentionally have no origin after migration.
  }
  const target = skillPrTargetForOrigin(originUrl);
  execFileSync('git', ['config', '--local', SKILL_PR_TARGET_GIT_KEY, target], {
    cwd: installDir,
    stdio: 'pipe',
  });
  return target;
}
