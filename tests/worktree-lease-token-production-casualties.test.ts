import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const roots: string[] = [];

function executable(path: string, body: string): void {
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
}

function fixture(): { root: string; repo: string; worktree: string; bin: string; log: string } {
  const root = mkdtempSync(join(tmpdir(), 'pr267-v62-token-'));
  roots.push(root);
  const repo = join(root, 'repo');
  const worktree = join(root, 'worktree');
  const bin = join(root, 'bin');
  const log = join(root, 'effects.log');
  mkdirSync(join(repo, '.git'), { recursive: true });
  mkdirSync(worktree, { recursive: true });
  writeFileSync(join(worktree, '.git'), 'gitdir: fixture');
  mkdirSync(bin);
  executable(join(bin, 'git'), `printf 'git %s\\n' "$*" >> '${log}'; exit 0`);
  executable(join(bin, 'cortextos'), `printf 'cortextos %s\\n' "$*" >> '${log}'; exit "\${VALIDATOR_EXIT:-1}"`);
  return { root, repo, worktree, bin, log };
}

function run(script: string, f: ReturnType<typeof fixture>) {
  return spawnSync('/bin/bash', [resolve(script), 'alpha'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${f.bin}:${process.env.PATH ?? ''}`,
      CTX_AGENT_NAME: 'alpha',
      CTX_FRAMEWORK_ROOT: f.repo,
      CTX_AGENT_WORKTREE: f.worktree,
      CTX_WORKTREE_LEASE_TOKEN: 'transported-but-dead',
      CTX_WORKTREE_LEASE_REQUEST_ID: '00000000-0000-4000-8000-000000000001',
      CTX_WORKTREE_LEASE_SCOPE: `repo:${join(f.repo, '.git')}`,
      CTX_CORTEXTOS_BIN: join(f.bin, 'cortextos'),
      CTX_INSTANCE_ID: 'instance-primary',
    },
  });
}

describe('production worktree writers validate transported lease authority', () => {
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it('token-presence-without-live-validation-never-authorizes-init', () => {
    const f = fixture();
    rmSync(f.worktree, { recursive: true, force: true });
    const result = run('scripts/worktree/init-agent-worktree.sh', f);
    const effects = readFileSync(f.log, 'utf8');
    expect(result.status).not.toBe(0);
    expect(effects).toContain('cortextos check-worktree-lease');
    expect(effects.split('\n').some(line => line.startsWith('git '))).toBe(false);
  });

  it('token-presence-without-live-validation-never-authorizes-refresh', () => {
    const f = fixture();
    const result = run('scripts/worktree/refresh-agent-worktree.sh', f);
    const effects = readFileSync(f.log, 'utf8');
    expect(result.status).not.toBe(0);
    expect(effects).toContain('cortextos check-worktree-lease');
    expect(effects.split('\n').some(line => line.startsWith('git '))).toBe(false);
  });

  it('an-exact-live-validation-allows-the-protected-writer-boundary', () => {
    const f = fixture();
    const result = spawnSync('/bin/bash', [resolve('scripts/worktree/refresh-agent-worktree.sh'), 'alpha'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${f.bin}:${process.env.PATH ?? ''}`,
        CTX_AGENT_NAME: 'alpha',
        CTX_FRAMEWORK_ROOT: f.repo,
        CTX_AGENT_WORKTREE: f.worktree,
        CTX_WORKTREE_LEASE_TOKEN: 'live-token',
        CTX_WORKTREE_LEASE_REQUEST_ID: '00000000-0000-4000-8000-000000000001',
        CTX_WORKTREE_LEASE_SCOPE: `repo:${join(f.repo, '.git')}`,
        CTX_CORTEXTOS_BIN: join(f.bin, 'cortextos'),
        VALIDATOR_EXIT: '0',
      },
    });
    expect(result.status).toBe(0);
    expect(readFileSync(f.log, 'utf8').split('\n').some(line => line.startsWith('git '))).toBe(true);
  });

  it.each([
    'scripts/worktree/init-agent-worktree.sh',
    'scripts/worktree/refresh-agent-worktree.sh',
  ])('%s propagates the active instance through re-entry and lease validation', (script) => {
    const f = fixture();
    if (script.includes('init')) rmSync(f.worktree, { recursive: true, force: true });
    run(script, f);
    const validationEffects = readFileSync(f.log, 'utf8');
    expect(validationEffects).toContain('--instance instance-primary');
    writeFileSync(f.log, '');
    spawnSync('/bin/bash', [resolve(script), 'alpha'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${f.bin}:${process.env.PATH ?? ''}`,
        CTX_AGENT_NAME: 'alpha',
        CTX_FRAMEWORK_ROOT: f.repo,
        CTX_AGENT_WORKTREE: f.worktree,
        CTX_CORTEXTOS_BIN: join(f.bin, 'cortextos'),
        CTX_INSTANCE_ID: 'instance-primary',
        VALIDATOR_EXIT: '0',
      },
    });
    const reentryEffects = readFileSync(f.log, 'utf8');
    expect(reentryEffects).toContain('with-worktree-lease --instance instance-primary');
  });

  it.each([
    'scripts/worktree/init-agent-worktree.sh',
    'scripts/worktree/refresh-agent-worktree.sh',
  ])('%s re-enters safely with zero positional arguments on the system bash', (script) => {
    const f = fixture();
    if (script.includes('init')) rmSync(f.worktree, { recursive: true, force: true });
    const result = spawnSync('/bin/bash', [resolve(script)], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${f.bin}:${process.env.PATH ?? ''}`,
        CTX_AGENT_NAME: 'alpha',
        CTX_FRAMEWORK_ROOT: f.repo,
        CTX_AGENT_WORKTREE: f.worktree,
        CTX_CORTEXTOS_BIN: join(f.bin, 'cortextos'),
        CTX_INSTANCE_ID: 'instance-primary',
        VALIDATOR_EXIT: '0',
      },
    });
    expect(result.status).toBe(0);
    expect(result.stderr).not.toContain('unbound variable');
    expect(readFileSync(f.log, 'utf8')).toContain('with-worktree-lease --instance instance-primary');
  });
});
