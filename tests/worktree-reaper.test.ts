import { chmodSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'fs';
import { execFileSync, spawnSync } from 'child_process';
import { join, resolve } from 'path';
import { tmpdir } from 'os';
import { describe, expect, it } from 'vitest';

const script = resolve('scripts/worktree/reap-agent-worktrees.sh');

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'reaper-shell-'));
  execFileSync('git', ['init', '-q', root]);
  execFileSync('git', ['-C', root, 'config', 'user.email', 'test@example.com']);
  execFileSync('git', ['-C', root, 'config', 'user.name', 'Test']);
  writeFileSync(join(root, 'base.txt'), 'base\n');
  execFileSync('git', ['-C', root, 'add', '.']);
  execFileSync('git', ['-C', root, 'commit', '-qm', 'base']);
  execFileSync('git', ['-C', root, 'remote', 'add', 'origin', root]);
  const baseBranch = execFileSync('git', ['-C', root, 'branch', '--show-current'], { encoding: 'utf8' }).trim();
  const state = join(root, 'state');
  execFileSync('mkdir', ['-p', join(state, 'state/agents/fixture/worktree')]);
  const bin = join(root, 'bin'); execFileSync('mkdir', ['-p', bin]);
  const gh = join(bin, 'gh'); writeFileSync(gh, '#!/bin/sh\necho "${GH_COUNT:-1}"\n'); chmodSync(gh, 0o755);
  const ctx = join(bin, 'cortextos');
  writeFileSync(ctx, '#!/bin/sh\nif [ "$1" = check-worktree-lease ] && [ "${LEASE_CHECK_FAIL:-0}" = 1 ]; then exit 42; fi\nprintf \'[{"name":"fixture","running":%s}]\\n\' "${AGENT_RUNNING:-false}"\n'); chmodSync(ctx, 0o755);
  const cwd = join(bin, 'cwd'); writeFileSync(cwd, '#!/bin/sh\nexit "${CWD_EXIT:-1}"\n'); chmodSync(cwd, 0o755);
  const common = execFileSync('git', ['-C', root, 'rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8' }).trim();
  const env = {
    ...process.env, CTX_FRAMEWORK_ROOT: root, CTX_ROOT: state, CTX_AGENT_NAME: 'fixture',
    CTX_AGENT_WORKTREE: join(state, 'state/agents/fixture/worktree'), WORKTREE_REAPER_GH_BIN: gh,
    WORKTREE_REAPER_CORTEXTOS_BIN: ctx, WORKTREE_REAPER_ACTIVE_CWD_BIN: cwd,
    CTX_WORKTREE_LEASE_TOKEN: 'token', CTX_WORKTREE_LEASE_REQUEST_ID: 'request',
    CTX_WORKTREE_LEASE_SCOPE: `repo:${common}`,
  };
  const add = (name: string) => {
    const path = join(root, `fixture-${name}`);
    execFileSync('git', ['-C', root, 'worktree', 'add', '-qb', `fixture/${name}`, path]);
    execFileSync('git', ['-C', path, 'config', `branch.fixture/${name}.remote`, '.']);
    execFileSync('git', ['-C', path, 'config', `branch.fixture/${name}.merge`, `refs/heads/${baseBranch}`]);
    return realpathSync(path);
  };
  return { root, state, bin, env, add };
}

describe('worktree reaper shell contract', () => {
  it('production-reaper-removes-every-parent-owned-temporary-on-exit', () => {
    const f = fixture();
    f.add('temporary-census');
    const isolatedTmp = mkdtempSync(join(tmpdir(), 'reaper-owned-temporaries-'));
    const controlledMktemp = join(f.bin, 'mktemp');
    writeFileSync(controlledMktemp, '#!/bin/sh\n/usr/bin/mktemp "$TMPDIR/reaper.XXXXXX"\n');
    chmodSync(controlledMktemp, 0o755);
    const run = spawnSync(script, [], {
      env: { ...f.env, TMPDIR: isolatedTmp, PATH: `${f.bin}:${process.env.PATH}` }, encoding: 'utf8',
    });
    expect(run.status).toBe(0);
    expect(readdirSync(isolatedTmp)).toEqual([]);
  });

  it('is dry-run by default and requires the supervisor lease for delete', () => {
    const f = fixture(); const tree = f.add('dry');
    const dry = spawnSync(script, [], { env: f.env, encoding: 'utf8' });
    expect(dry.status).toBe(0); expect(dry.stdout).toContain(`WOULD-REAP path=${tree}`);
    const { CTX_WORKTREE_LEASE_TOKEN: _t, ...without } = f.env;
    const del = spawnSync(script, ['--delete'], { env: without, encoding: 'utf8' });
    expect(del.status).toBe(2); expect(del.stderr).toContain('supervisor-held repository lease');
    expect(readFileSync(join(tree, 'base.txt'), 'utf8')).toBe('base\n');
    expect(readFileSync(script, 'utf8')).not.toContain('.worktree-reaper-custody');
  });

  it('refuses destructive work when the opaque lease no longer validates live', () => {
    const f = fixture(); const tree = f.add('lost-lease');
    const run = spawnSync(script, ['--delete'], {
      env: { ...f.env, LEASE_CHECK_FAIL: '1' }, encoding: 'utf8',
    });
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain('repository lease is not live');
    expect(readFileSync(join(tree, 'base.txt'), 'utf8')).toBe('base\n');
  });

  it('requires an exact-head merged PR and fails closed for every local-data class', () => {
    const f = fixture();
    const tracked = f.add('tracked'); writeFileSync(join(tracked, 'base.txt'), 'changed\n');
    const hidden = f.add('hidden'); execFileSync('git', ['-C', hidden, 'update-index', '--skip-worktree', 'base.txt']);
    const untracked = f.add('untracked'); writeFileSync(join(untracked, 'precious.txt'), 'x');
    const gitlink = f.add('gitlink');
    const oid = execFileSync('git', ['-C', gitlink, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    execFileSync('git', ['-C', gitlink, 'update-index', '--add', '--cacheinfo', `160000,${oid},nested-repo`]);
    const cwdUnknown = f.add('cwd');
    const run = spawnSync(script, ['--delete'], { env: { ...f.env, CWD_EXIT: '42' }, encoding: 'utf8' });
    expect(run.status).toBe(0);
    expect(run.stdout).toContain(`REFUSE path=${tracked}`);
    expect(run.stdout).toContain(`REFUSE path=${hidden}`);
    expect(run.stdout).toContain(`REFUSE path=${untracked}`);
    expect(run.stdout).toContain(`REFUSE path=${gitlink}`);
    expect(run.stdout).toContain('submodule-gitlink:nested-repo');
    expect(run.stdout).toContain(`REFUSE path=${cwdUnknown}`);
    expect(run.stdout).toContain('process-cwd-unknown');

    const exact = f.add('exact-head');
    const notMerged = spawnSync(script, ['--delete'], { env: { ...f.env, GH_COUNT: '0' }, encoding: 'utf8' });
    expect(notMerged.stdout).toContain(`REFUSE path=${exact}`);
    expect(notMerged.stdout).toContain('owning-pr-not-merged-for-head');

    const active = f.add('active');
    const activeRun = spawnSync(script, ['--delete'], { env: { ...f.env, AGENT_RUNNING: 'true' }, encoding: 'utf8' });
    expect(activeRun.stdout).toContain(`REFUSE path=${active}`);
    expect(activeRun.stdout).toContain('active-agent-session');
  });

  it('fails second and post-prune censuses nonzero without successful accounting', () => {
    const f = fixture(); const tree = f.add('missing'); execFileSync('mv', [tree, `${tree}.gone`]);
    const fail = join(f.bin, 'fail'); writeFileSync(fail, '#!/bin/sh\nexit 2\n'); chmodSync(fail, 0o755);
    const second = spawnSync(script, ['--delete'], { env: { ...f.env, WORKTREE_REAPER_SECOND_WORKTREE_LIST_BIN: fail }, encoding: 'utf8' });
    expect(second.status).not.toBe(0); expect(second.stderr).toContain('prune-second-census-failure');
    expect(second.stdout).not.toContain('PRUNE owner=fixture registrations=');

    const post = spawnSync(script, ['--delete'], { env: { ...f.env, WORKTREE_REAPER_POST_PRUNE_WORKTREE_LIST_BIN: fail }, encoding: 'utf8' });
    expect(post.status).not.toBe(0); expect(post.stderr).toContain('post-prune-census-failure counts-frozen=true');
    expect(post.stdout).toContain('summary reaped=0 pruned=0 failures=1');
  });

  it('refuses when the immediate second census differs before global prune', () => {
    const f = fixture(); const tree = f.add('missing-window'); execFileSync('mv', [tree, `${tree}.gone`]);
    const changed = join(f.bin, 'changed-census');
    writeFileSync(changed, '#!/bin/sh\ngit -C "$CTX_FRAMEWORK_ROOT" worktree list --porcelain\nprintf "worktree /injected-between-censuses\\nbranch refs/heads/other/new\\n\\n"\n');
    chmodSync(changed, 0o755);
    const run = spawnSync(script, ['--delete'], { env: { ...f.env, WORKTREE_REAPER_SECOND_WORKTREE_LIST_BIN: changed }, encoding: 'utf8' });
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('REFUSE-PRUNE owner=fixture reason=inventory-changed-before-prune');
    expect(run.stdout).not.toContain('PRUNE owner=fixture registrations=');
  });

  it('unobservable-process-cwd-is-unknown-and-refuses-reap', () => {
    const f = fixture();
    const tree = f.add('cwd-instrument-failure');
    const run = spawnSync(script, ['--delete'], {
      env: { ...f.env, CWD_EXIT: '42' }, encoding: 'utf8',
    });
    expect(run.status).toBe(0);
    expect(run.stdout).toContain(`REFUSE path=${tree}`);
    expect(run.stdout).toContain('process-cwd-unknown');
    expect(readFileSync(join(tree, 'base.txt'), 'utf8')).toBe('base\n');
  });

  it('independently-vanished-process-cwd-does-not-create-an-unknown-refusal', () => {
    const f = fixture();
    const tree = f.add('cwd-vanished');
    const run = spawnSync(script, [], {
      env: { ...f.env, CWD_EXIT: '1' }, encoding: 'utf8',
    });
    expect(run.status).toBe(0);
    expect(run.stdout).toContain(`WOULD-REAP path=${tree}`);
    expect(run.stdout).not.toContain('process-cwd-unknown');
  });

  it('selected-instance-binds-both-state-root-and-daemon-queries', () => {
    const f = fixture();
    const tree = f.add('staging-instance');
    const home = join(f.root, 'home');
    execFileSync('mkdir', ['-p', join(home, '.cortextos/staging/state/agents/fixture')]);
    const { CTX_ROOT: _ctxRoot, ...withoutRoot } = f.env;
    const run = spawnSync(script, ['--instance', 'staging'], {
      env: { ...withoutRoot, HOME: home }, encoding: 'utf8',
    });
    expect(run.status).toBe(0);
    expect(run.stdout).toContain(`WOULD-REAP path=${tree}`);
  });
});
