import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const repo = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();

function fakeSupervisor(root: string): string {
  const path = join(root, 'cortextos');
  writeFileSync(path, '#!/bin/sh\nprintf "%s\\n" "$*" > "$LEASE_LOG"\nexit 73\n');
  chmodSync(path, 0o755);
  return path;
}

describe('repository worktree writer fencing', () => {
  it('refuses to create a worktree when the lease supervisor cannot acquire', () => {
    const root = mkdtempSync(join(tmpdir(), 'writer-fence-init-'));
    mkdirSync(join(root, 'repo', '.git'), { recursive: true });
    const log = join(root, 'lease.log');
    const target = join(root, 'agent-worktree');
    const result = spawnSync('bash', [join(repo, 'scripts/worktree/init-agent-worktree.sh'), 'fixture'], {
      env: {
        ...process.env,
        CTX_FRAMEWORK_ROOT: join(root, 'repo'),
        CTX_AGENT_WORKTREE: target,
        CTX_CORTEXTOS_BIN: fakeSupervisor(root),
        LEASE_LOG: log,
      },
    });
    expect(result.status).toBe(73);
    expect(readFileSync(log, 'utf8')).toContain('with-worktree-lease --instance default --owner fixture');
    expect(spawnSync('test', ['-e', target]).status).not.toBe(0);
  });

  it('refuses fetch/reset writers before git when the repository lease is unavailable', () => {
    const root = mkdtempSync(join(tmpdir(), 'writer-fence-refresh-'));
    const worktree = join(root, 'worktree');
    mkdirSync(worktree, { recursive: true });
    writeFileSync(join(worktree, '.git'), 'gitdir: nowhere\n');
    const log = join(root, 'lease.log');
    const result = spawnSync('bash', [join(repo, 'scripts/worktree/refresh-agent-worktree.sh'), '--force-discard', 'fixture'], {
      env: {
        ...process.env,
        CTX_FRAMEWORK_ROOT: repo,
        CTX_AGENT_WORKTREE: worktree,
        CTX_CORTEXTOS_BIN: fakeSupervisor(root),
        LEASE_LOG: log,
      },
    });
    expect(result.status).toBe(73);
    expect(readFileSync(log, 'utf8')).toContain('with-worktree-lease --instance default --owner fixture');
  });
});
