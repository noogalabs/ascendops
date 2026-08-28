import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('PR267 v6.2 authorized static census (not a behavioral casualty)', () => {
  it('protected-prune-casualties-run-through-the-production-shell-only', () => {
    const duplicatePath = resolve('src/daemon/worktree-reap-protocol.ts');
    expect(existsSync(duplicatePath)).toBe(false);
    const shell = readFileSync(resolve('scripts/worktree/reap-agent-worktrees.sh'), 'utf8');
    expect(shell).toContain('git -C "$FRAMEWORK_ROOT" worktree prune --expire now');
  });
});
